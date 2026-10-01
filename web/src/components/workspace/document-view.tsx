"use client"

import { useEffect, useState } from "react"
import { cn } from "cn"
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, History } from "lucide-react"
import type { Layout } from "react-resizable-panels"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Change, DiffLine, DiffResult, DiffSide, FileContent } from "@/lib/types"
import { errorMessage, previewUrl, rawUrl, useChanges, useCommit, useDiff, useFile, usePreviewToken, useWt } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { usePersistentState } from "@/lib/persist"
import { formatSize, relTime } from "@/lib/format"
import { CodeViewer, langFromPath } from "@/components/viewers/code-viewer"
import { MarkdownDiffViewer, MarkdownViewer } from "@/components/viewers/markdown-viewer"
import { DiffViewer } from "@/components/viewers/diff-viewer"
import { ZoomView } from "@/components/viewers/zoom-dialog"
import { diffSides, withinHighlightLimit } from "@/lib/diff"
import { DiffStat, dirname, FileIcon, resolveRelative, statusColor } from "./common"
import { baseLabel, type DiffBase, type DocTab, type DocView, type GroupView } from "./editor-layout"
import { HistoryList, UNCOMMITTED, useHistory } from "./history-list"

export type DocumentActions = {
  openFile: (path: string) => void
  // 表示中のタブを書き換える。DocView を付けると、グループの表示 (差分 / 全体、Unified / Split、プレビュー / ソース、History) も変える
  updateTab: (tab: DocTab) => void
  compareBase: DiffBase
  hasDiff: (path: string) => boolean
}

type DiffFormat = "unified" | "split"
type Display = "diff" | "file"
type MdMode = "preview" | "source"

// 並んだボタンのうち 1 つを選ぶ (選んでいるものを塗る)。パスのバーの切り替えはすべてこの形にする
function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; title?: string }[] }) {
  return (
    <ToggleGroup variant="outline" size="sm" spacing={0} value={[value]} onValueChange={(v: string[]) => v[0] && onChange(v[0] as T)}>
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          title={o.title}
          className="h-6 px-2 text-xs text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 aria-pressed:hover:text-primary-foreground"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const FORMAT_OPTIONS: { value: DiffFormat; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
]
const MD_OPTIONS: { value: MdMode; label: string }[] = [
  { value: "preview", label: "プレビュー" },
  { value: "source", label: "ソース" },
]

function Breadcrumb({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  const parts = path.split("/")
  const file = parts.pop()
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground" title={path}>
      {parts.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {parts.map((p, i) => (
            <span key={i} className="flex min-w-0 shrink items-center gap-1">
              <span className="truncate">{p}</span>
              <ChevronRight className="size-3 shrink-0" />
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 text-foreground">{file}</span>
      <button
        onClick={() =>
          void copyText(path).then((ok) => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
        className="ml-1 shrink-0 rounded p-1 hover:bg-accent"
        title={copied ? "コピーしました" : "相対パスをコピー"}
      >
        {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
      </button>
    </div>
  )
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">{children}</div>
}

// 読み込み中・エラー・表示しないファイルの案内 (本文の真ん中に出す)
function Notice({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={cn("flex h-full min-h-32 flex-col items-center justify-center gap-2 p-6 text-sm", error ? "text-destructive" : "text-muted-foreground")}>
      {error && <AlertTriangle className="size-5" />}
      {children}
    </div>
  )
}

// view: グループの表示 (パスのバーの切り替え。グループの中のタブで共有する)
export function DocumentView({ tab, view, actions }: { tab: DocTab; view: GroupView; actions: DocumentActions }) {
  if (tab.kind === "commit") return <CommitView hash={tab.hash} />
  if (tab.kind === "diff") return <DiffDocument tab={tab} view={view} actions={actions} />
  return <FileDocument tab={tab} view={view} actions={actions} />
}

// Markdown の画像の相対パスを、Markdown のあるディレクトリを基準にサーバーの raw の URL にする
function useImageResolver(path: string) {
  const wt = useWt()
  return (src: string) => {
    if (/^(https?:|data:)/.test(src)) return src
    return rawUrl(wt, resolveRelative(dirname(path), src))
  }
}

// 透明な部分が分かるよう、画像の下に市松模様を敷く
const CHECKER = "bg-[repeating-conic-gradient(#8881_0_25%,transparent_0_50%)] bg-[length:16px_16px]"

function ImageView({ src, caption }: { src: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={caption ?? ""} className={cn("max-w-full rounded border", CHECKER)} />
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  )
}

// 画像のファイル。枠に収まる大きさ (元より大きくはしない) で開き、拡大・縮小できる。
// 元の大きさが分からない画像 (読めない・大きさのない SVG など) は、拡大・縮小せずにそのまま出す
function ImageFileView({ src, name, size }: { src: string; name: string; size: number }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | "error" | null>(null)
  useEffect(() => {
    const img = new Image()
    img.onload = () => setNatural(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : "error")
    img.onerror = () => setNatural("error")
    img.src = src
    return () => {
      img.onload = img.onerror = null
    }
  }, [src])
  if (natural === null) return <Notice>読み込み中…</Notice>
  if (natural === "error") return <ImageView src={src} caption={`${name} (${formatSize(size)})`} />
  return (
    <ZoomView
      className="h-full"
      maxFit={1}
      // ファイル名はパンくずリストにあるので、大きさだけを出す
      header={
        <span className="text-xs text-muted-foreground tabular-nums">
          {natural.width} × {natural.height} · {formatSize(size)}
        </span>
      }
      {...natural}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={name} draggable={false} className={cn("block size-full", CHECKER)} />
    </ZoomView>
  )
}

// ファイル全体の表示 (Markdown はプレビューかソース、それ以外はコード。画像は画像、バイナリと大きすぎるものは案内)
function FileBody({ path, line, mdMode, actions }: { path: string; line?: number; mdMode: MdMode; actions: DocumentActions }) {
  const wt = useWt()
  const { data, error, isPending, dataUpdatedAt } = useFile(path)
  const resolveImage = useImageResolver(path)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  // HTML のプレビューは、ファイルを読み直したら (変更を検知したら) 開き直す
  if (isHtml(path) && mdMode === "preview" && data.kind === "text") return <HtmlPreview key={dataUpdatedAt} path={path} />
  return <FileContentView content={data} path={path} line={line} mdMode={mdMode} actions={actions} imageUrl={rawUrl(wt, path)} resolveImage={resolveImage} />
}

const isHtml = (path: string) => /\.html?$/i.test(path)

// HTML のプレビュー。sherpa と別の origin として動くよう、sandbox の iframe で開く (スクリプトは動く。docs/architecture/security.md §6)。
// ページは白地を前提にしていることが多いので、ダークのときも白地にする
function HtmlPreview({ path }: { path: string }) {
  const wt = useWt()
  const { data, error } = usePreviewToken()
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  if (!data) return <Notice>読み込み中…</Notice>
  return <iframe src={previewUrl(wt, data.token, path)} sandbox="allow-scripts" title="HTML のプレビュー" className="block size-full border-0 bg-white" />
}

function FileContentView(props: {
  content: FileContent
  path: string
  line?: number
  mdMode: MdMode
  actions: DocumentActions
  imageUrl: string
  resolveImage: (src: string) => string
}) {
  const { content: c, path, line, mdMode, actions } = props
  if (c.kind === "image") return <ImageFileView key={props.imageUrl} src={props.imageUrl} name={path.split("/").pop() ?? path} size={c.size} />
  if (c.kind === "binary") return <Notice>バイナリのため表示しません ({formatSize(c.size)})</Notice>
  if (c.kind === "too-large") return <Notice>大きすぎるため表示しません ({formatSize(c.size)})</Notice>
  if (c.kind === "symlink")
    return (
      <Notice>
        シンボリックリンク → <span className="font-mono">{c.target}</span>
        {c.outside && <span className="text-xs">(worktree の外を指しているため、中身は表示しません)</span>}
      </Notice>
    )
  return (
    <>
      {c.invalidUtf8 && <p className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-400">UTF-8 ではないため、正しく表示できない文字があります</p>}
      {!c.highlight && <p className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">大きなファイルのため、シンタックスハイライトしていません ({formatSize(c.size)})</p>}
      {path.endsWith(".md") && mdMode === "preview" && c.highlight ? (
        <MarkdownViewer content={c.content} resolveImage={props.resolveImage} onOpenLink={(href) => actions.openFile(resolveRelative(dirname(path), href))} />
      ) : (
        <CodeViewer path={path} code={c.content} highlightLine={line} plain={!c.highlight} />
      )}
    </>
  )
}

// Markdown のプレビューの差分 (Unified は 1 つに重ね、Split は左に変更前・右に変更後)。
// 差分が一部だけ (partial) のときと大きすぎるときは、プレビューにできないのでソースの差分を出す
function MarkdownDiffBody(props: { path: string; lines: DiffLine[]; partial?: boolean; format: DiffFormat; expandAll?: boolean; actions: DocumentActions }) {
  const { path, lines, format, actions } = props
  const resolveImage = useImageResolver(path)
  const { before, after } = diffSides(lines)
  if (props.partial || !withinHighlightLimit(before) || !withinHighlightLimit(after))
    return (
      <>
        <p className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">大きなファイルのため、プレビューの差分は表示できません。ソースの差分を表示しています</p>
        <DiffViewer lines={lines} mode={format} expandAll={props.expandAll} lang={props.partial ? undefined : langFromPath(path)} />
      </>
    )
  if (!lines.some((l) => l.type !== "ctx")) return <p className="p-4 text-sm text-muted-foreground">差分はありません</p>
  const viewer = { lines, resolveImage, onOpenLink: (href: string) => actions.openFile(resolveRelative(dirname(path), href)) }
  if (format === "unified") return <MarkdownDiffViewer {...viewer} />
  return (
    <div className="grid grid-cols-2 divide-x">
      <div className="min-w-0">
        <MarkdownDiffViewer {...viewer} side="before" />
      </div>
      <div className="min-w-0">
        <MarkdownDiffViewer {...viewer} side="after" />
      </div>
    </div>
  )
}

// 差分の本文 (テキスト・画像・バイナリ)。preview は Markdown のプレビューの差分 (actions があるときだけ)
function DiffBody(props: { path: string; result: DiffResult; format: DiffFormat; preview?: boolean; expandAll?: boolean; actions?: DocumentActions }) {
  const { path, result, format, actions } = props
  const wt = useWt()
  if (result.kind === "binary") return <Notice>バイナリのファイルが変更されています</Notice>
  if (result.kind === "image") {
    const url = (s: DiffSide) => rawUrl(wt, s.path, s.rev)
    return (
      <div className="grid grid-cols-2 divide-x">
        <div>{result.before ? <ImageView src={url(result.before)} caption="変更前" /> : <Notice>(追加)</Notice>}</div>
        <div>{result.after ? <ImageView src={url(result.after)} caption="変更後" /> : <Notice>(削除)</Notice>}</div>
      </div>
    )
  }
  return (
    <>
      {result.partial && <p className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">大きなファイルのため、変更の前後だけを表示しています</p>}
      {!result.lines.length ? (
        <Notice>変更はありません (空のファイル)</Notice>
      ) : props.preview && actions ? (
        <MarkdownDiffBody path={path} lines={result.lines} partial={result.partial} format={format} expandAll={props.expandAll} actions={actions} />
      ) : (
        // 大きなファイルは、ファイルの表示と同じくハイライトしない (partial は前後がそろわないのでしない)
        <DiffViewer lines={result.lines} mode={format} expandAll={props.expandAll} lang={result.partial ? undefined : langFromPath(path)} />
      )}
    </>
  )
}

// 差分を取ってきて表示する
function LoadedDiff(props: {
  path: string
  oldPath?: string
  base: DiffBase | { type: "commit"; hash: string }
  format: DiffFormat
  preview?: boolean
  expandAll?: boolean
  actions?: DocumentActions
}) {
  const { data, error, isPending } = useDiff(props.path, props.oldPath, props.base)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  return <DiffBody path={props.path} result={data} format={props.format} preview={props.preview} expandAll={props.expandAll} actions={props.actions} />
}

type FileTab = Extract<DocTab, { kind: "file" }>
type DiffTab = Extract<DocTab, { kind: "diff" }>

// ファイルタブと差分タブの本文。パスのバーの右に [プレビュー|ソース] [Unified|Split] [差分|全体] [History] を並べる。
// プレビュー / ソースは Markdown (と、全体のときの HTML) だけ、Unified / Split は差分のときだけ、差分 / 全体は差分があるときか履歴で選んでいるときだけ出す。
// diff: 差分の取り方 (ファイルタブは比較対象との差分をファイル全体に重ねる。差分がなければ undefined)
function DocumentPane(props: { tab: FileTab | DiffTab; view: GroupView; actions: DocumentActions; diff?: { base: DiffBase; oldPath?: string; expandAll?: boolean } }) {
  const { tab, view, actions, diff } = props
  const { path } = tab
  const isMd = path.endsWith(".md")
  // HTML は「全体」のときだけプレビューできる (プレビューの差分は Markdown だけ)
  const canPreview = isMd || isHtml(path)
  const line = tab.kind === "file" ? tab.line : undefined
  const format = view.format ?? "unified"
  const update = (v: DocView) => actions.updateTab({ ...tab, ...v })

  // 履歴 (左の一覧)。Untracked のファイルにはコミットがないので出さない
  const own = useChanges().data?.find((c) => c.path === path)
  const untracked = own?.status === "U"
  const historyOpen = !!view.history && !untracked
  const history = useHistory(path, historyOpen)
  const rev = historyOpen ? tab.rev : undefined
  const revCommit = rev && rev !== UNCOMMITTED ? history.data?.commits.find((c) => c.hash === rev) : undefined
  // 履歴で選んだものの差分。コミットはその親との差分 (名前を変えたコミットは元のパスとの差分)
  const revDiff =
    rev === UNCOMMITTED && own
      ? { path, oldPath: own.oldPath, base: { type: "uncommitted" } as const, label: baseLabel({ type: "uncommitted" }) }
      : revCommit
        ? {
            path: revCommit.change.path,
            oldPath: revCommit.change.oldPath,
            base: { type: "commit", hash: revCommit.hash } as const,
            label: revCommit.parents.length ? `${revCommit.shortHash}^..${revCommit.shortHash}` : revCommit.shortHash,
          }
        : undefined

  const display: Display = diff ? (view.display ?? (tab.kind === "diff" ? "diff" : "file")) : "file"
  const showDiff = !!rev || display === "diff"
  // 検索結果から行を指定して開いたときはソースを表示する
  const md: MdMode = canPreview ? (view.md ?? (line ? "source" : "preview")) : "source"
  const label = rev ? revDiff?.label : diff && display === "diff" ? baseLabel(diff.base) : undefined

  const body = rev ? (
    revDiff ? (
      <LoadedDiff path={revDiff.path} oldPath={revDiff.oldPath} base={revDiff.base} format={format} preview={isMd && md === "preview"} actions={actions} />
    ) : (
      <Notice>{history.isPending ? "読み込み中…" : "選んだものが履歴にありません"}</Notice>
    )
  ) : diff && display === "diff" ? (
    <LoadedDiff path={path} oldPath={diff.oldPath} base={diff.base} format={format} preview={isMd && md === "preview"} expandAll={diff.expandAll} actions={actions} />
  ) : (
    <FileBody path={path} line={line} mdMode={md} actions={actions} />
  )

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <Breadcrumb path={path} />
        {label && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground">{label}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {(isMd || (canPreview && !showDiff)) && <Segmented value={md} onChange={(m) => update({ md: m })} options={MD_OPTIONS} />}
          {showDiff && <Segmented value={format} onChange={(f) => update({ format: f })} options={FORMAT_OPTIONS} />}
          {(diff || rev) && (
            // 履歴で選んでいる間はどちらも選ばない。押すと履歴の選択をやめて、その表示にする
            <Segmented
              value={rev ? ("" as Display) : display}
              onChange={(d) => update({ display: d, rev: undefined })}
              options={[
                ...(diff ? [{ value: "diff" as const, label: "差分", title: `${baseLabel(diff.base)} との差分を表示` }] : []),
                { value: "file" as const, label: "全体", title: "ファイル全体を表示" },
              ]}
            />
          )}
          <Toggle
            variant="outline"
            size="sm"
            pressed={historyOpen}
            disabled={untracked}
            onPressedChange={(on) => update({ history: on || undefined, rev: undefined })}
            title={untracked ? "Untracked のファイルには履歴がありません" : "このファイルの変更の履歴"}
            className="h-6 min-w-0 px-2 text-xs text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 aria-pressed:hover:text-primary-foreground"
          >
            <History className="size-3.5" />
            History
          </Toggle>
        </div>
      </Toolbar>
      {historyOpen ? (
        <HistorySplit
          list={
            <HistoryList
              path={path}
              uncommitted={own}
              commits={history.data?.commits}
              loading={history.isFetching}
              error={history.error}
              truncated={!!history.data?.truncated}
              onMore={history.onMore}
              selected={rev}
              onSelect={(r) => update({ rev: r })}
            />
          }
        >
          {body}
        </HistorySplit>
      ) : (
        <div data-find-root className="min-h-0 flex-1 overflow-auto">
          {body}
        </div>
      )}
    </div>
  )
}

// 左に履歴、右に本文。履歴の幅はドラッグで変えられ、保存する (タブに関係なく 1 つ)
function HistorySplit({ list, children }: { list: React.ReactNode; children: React.ReactNode }) {
  const [layout, setLayout] = usePersistentState<Layout | null>("history-panel-layout", () => null)
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout ?? undefined} onLayoutChanged={setLayout}>
      <ResizablePanel id="history" defaultSize="260px" minSize="160px" maxSize="60%">
        {list}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="content" minSize="30%">
        <div data-find-root className="h-full overflow-auto">
          {children}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

// ファイルタブ。比較対象との差分があれば「差分」で、ファイル全体に差分を重ねて表示する (既定は「全体」)
function FileDocument({ tab, view, actions }: { tab: FileTab; view: GroupView; actions: DocumentActions }) {
  const diff = actions.hasDiff(tab.path) ? { base: actions.compareBase, expandAll: true } : undefined
  return <DocumentPane tab={tab} view={view} actions={actions} diff={diff} />
}

// 差分タブ。変更のない部分は省略する (既定は「差分」)
function DiffDocument({ tab, view, actions }: { tab: DiffTab; view: GroupView; actions: DocumentActions }) {
  return <DocumentPane tab={tab} view={view} actions={actions} diff={{ base: tab.base, oldPath: tab.oldPath }} />
}

function CommitView({ hash }: { hash: string }) {
  const { data, error, isPending } = useCommit(hash)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  return <CommitDetail commit={{ ...data, files: data.files ?? [] }} />
}

// コミットの詳細を開いたとき、変更ファイルがこの数以下なら差分をすべて展開しておく (多いと差分の取得が一度に走るため)
const COMMIT_EXPAND_LIMIT = 50

function CommitDetail({ commit }: { commit: { hash: string; shortHash: string; message: string; body: string; author: string; date: string; files: Change[] } }) {
  const [mode, setMode] = useState<DiffFormat>("unified")
  const [open, setOpen] = useState<Set<string>>(() => new Set(commit.files.length <= COMMIT_EXPAND_LIMIT ? commit.files.map((f) => f.path) : []))
  const toggle = (p: string) =>
    setOpen((prev) => {
      const n = new Set(prev)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })
  const allOpen = open.size === commit.files.length
  const additions = commit.files.reduce((a, f) => a + f.additions, 0)
  const deletions = commit.files.reduce((a, f) => a + f.deletions, 0)

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="text-xs text-muted-foreground">コミット {commit.files.length} ファイル</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="xs" onClick={() => setOpen(allOpen ? new Set() : new Set(commit.files.map((f) => f.path)))}>
            {allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
            {allOpen ? "すべて折りたたむ" : "すべて展開"}
          </Button>
          <Segmented value={mode} onChange={setMode} options={FORMAT_OPTIONS} />
        </div>
      </Toolbar>
      <div data-find-root className="min-h-0 flex-1 overflow-auto p-6">
        <h2 className="text-lg font-semibold">{commit.message}</h2>
        {commit.body && <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">{commit.body}</pre>}
        <p className="mt-2 mb-4 flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span title={commit.hash}>{commit.shortHash}</span> · {commit.author} · <span title={commit.date}>{relTime(commit.date)}</span> · {commit.files.length} files
          <DiffStat additions={additions} deletions={deletions} />
        </p>
        <div className="space-y-2">
          {commit.files.map((f) => {
            const isOpen = open.has(f.path)
            return (
              <div key={f.path} className="overflow-hidden rounded-md border">
                <button
                  onClick={() => toggle(f.path)}
                  className={cn("sticky top-0 z-10 flex w-full items-center gap-2 bg-muted/50 px-3 py-2 text-left text-sm hover:bg-muted", isOpen && "border-b")}
                >
                  {isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                  <span className={cn("w-3 font-mono text-xs", statusColor[f.status])}>{f.status}</span>
                  <FileIcon path={f.path} />
                  <span className="truncate font-mono text-[13px]">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
                  <span className="ml-auto">
                    <DiffStat additions={f.additions} deletions={f.deletions} />
                  </span>
                </button>
                {isOpen && <LoadedDiff path={f.path} oldPath={f.oldPath} base={{ type: "commit", hash: commit.hash }} format={mode} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
