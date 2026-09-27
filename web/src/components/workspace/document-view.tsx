"use client"

import { useState } from "react"
import { cn } from "cn"
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Eye, FileText, GitCompare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Change, DiffResult, DiffSide, FileContent } from "@/lib/types"
import { errorMessage, rawUrl, useCommit, useDiff, useFile, useWt } from "@/lib/api"
import { formatSize, relTime } from "@/lib/format"
import { CodeViewer } from "@/components/viewers/code-viewer"
import { MarkdownViewer } from "@/components/viewers/markdown-viewer"
import { DiffViewer } from "@/components/viewers/diff-viewer"
import { DiffStat, dirname, FileIcon, resolveRelative, statusColor } from "./common"
import { baseLabel, type DiffBase, type DocTab } from "./editor-layout"

export type DocumentActions = {
  openFile: (path: string) => void
  // 表示中のタブの状態を書き換える (ファイルタブの差分表示、差分タブの「差分 / ファイル全体」の切り替えなど)
  updateTab: (tab: DocTab) => void
  compareBase: DiffBase
  hasDiff: (path: string) => boolean
}

type DiffMode = "unified" | "split"

function DiffModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  return (
    <ToggleGroup variant="outline" size="sm" value={[mode]} onValueChange={(v: string[]) => v[0] && onChange(v[0] as DiffMode)}>
      <ToggleGroupItem value="unified" className="h-6 px-2 text-xs">
        Unified
      </ToggleGroupItem>
      <ToggleGroupItem value="split" className="h-6 px-2 text-xs">
        Split
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

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
        onClick={() => {
          navigator.clipboard?.writeText(path)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
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

export function DocumentView({ tab, actions }: { tab: DocTab; actions: DocumentActions }) {
  if (tab.kind === "commit") return <CommitView hash={tab.hash} />
  if (tab.kind === "diff") return <DiffDocument tab={tab} actions={actions} />
  return <FileDocument tab={tab} actions={actions} />
}

type MdMode = "preview" | "source"

function MdModeToggle({ mode, onChange }: { mode: MdMode; onChange: (m: MdMode) => void }) {
  return (
    <ToggleGroup variant="outline" size="sm" value={[mode]} onValueChange={(v: string[]) => v[0] && onChange(v[0] as MdMode)}>
      <ToggleGroupItem value="preview" className="h-6 px-2 text-xs">
        プレビュー
      </ToggleGroupItem>
      <ToggleGroupItem value="source" className="h-6 px-2 text-xs">
        ソース
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

// Markdown の画像の相対パスを、Markdown のあるディレクトリを基準にサーバーの raw の URL にする
function useImageResolver(path: string) {
  const wt = useWt()
  return (src: string) => {
    if (/^(https?:|data:)/.test(src)) return src
    return rawUrl(wt, resolveRelative(dirname(path), src))
  }
}

function ImageView({ src, caption }: { src: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={caption ?? ""} className="max-w-full rounded border bg-[repeating-conic-gradient(#8881_0_25%,transparent_0_50%)] bg-[length:16px_16px]" />
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  )
}

// ファイル全体の表示 (Markdown はプレビューかソース、それ以外はコード。画像は画像、バイナリと大きすぎるものは案内)
function FileBody({ path, line, mdMode, actions }: { path: string; line?: number; mdMode: MdMode; actions: DocumentActions }) {
  const wt = useWt()
  const { data, error, isPending } = useFile(path)
  const resolveImage = useImageResolver(path)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  return <FileContentView content={data} path={path} line={line} mdMode={mdMode} actions={actions} imageUrl={rawUrl(wt, path)} resolveImage={resolveImage} />
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
  if (c.kind === "image") return <ImageView src={props.imageUrl} caption={`${path.split("/").pop()} (${formatSize(c.size)})`} />
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

// 差分の本文 (テキスト・画像・バイナリ)
function DiffBody({ result, mode, expandAll }: { result: DiffResult; mode: DiffMode; expandAll?: boolean }) {
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
      {result.lines.length ? <DiffViewer lines={result.lines} mode={mode} expandAll={expandAll} /> : <Notice>変更はありません (空のファイル)</Notice>}
    </>
  )
}

// 差分を取ってきて表示する
function LoadedDiff(props: { path: string; oldPath?: string; base: DiffBase | { type: "commit"; hash: string }; mode: DiffMode; expandAll?: boolean }) {
  const { data, error, isPending } = useDiff(props.path, props.oldPath, props.base)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  return <DiffBody result={data} mode={props.mode} expandAll={props.expandAll} />
}

type FileTab = Extract<DocTab, { kind: "file" }>

// ファイルタブ。「差分を見る」を押すと、同じタブの中でファイル全体に差分を重ねて表示する (Unified / Split)
function FileDocument({ tab, actions }: { tab: FileTab; actions: DocumentActions }) {
  const { path, line } = tab
  // 検索結果から行指定で開いたときはソースを表示する
  const [mdMode, setMdMode] = useState<MdMode>(line ? "source" : "preview")
  const diff = actions.hasDiff(path) ? tab.diff : undefined
  const base = actions.compareBase

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <Breadcrumb path={path} />
        {diff && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground">{baseLabel(base)}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {diff ? (
            <DiffModeToggle mode={diff} onChange={(m) => actions.updateTab({ ...tab, diff: m })} />
          ) : (
            path.endsWith(".md") && <MdModeToggle mode={mdMode} onChange={setMdMode} />
          )}
          {actions.hasDiff(path) && (
            <Button
              variant={diff ? "secondary" : "outline"}
              size="xs"
              onClick={() => actions.updateTab({ ...tab, diff: diff ? undefined : "unified" })}
              title={diff ? "差分の表示をやめる" : `ファイル全体の中に ${baseLabel(base)} の差分を表示`}
            >
              <GitCompare className="size-3.5" /> {diff ? "差分を閉じる" : "差分を見る"}
              {!diff && base.type === "branch" && <span className="font-mono text-[10px] text-muted-foreground">({base.branch})</span>}
            </Button>
          )}
        </div>
      </Toolbar>
      <div data-find-root className="min-h-0 flex-1 overflow-auto">
        {diff ? <LoadedDiff path={path} base={base} mode={diff} expandAll /> : <FileBody path={path} line={line} mdMode={mdMode} actions={actions} />}
      </div>
    </div>
  )
}

type DiffTab = Extract<DocTab, { kind: "diff" }>

// 差分タブ。同じタブの中で「差分」と「ファイル全体」を切り替える
function DiffDocument({ tab, actions }: { tab: DiffTab; actions: DocumentActions }) {
  const { path, base, oldPath } = tab
  const display = tab.display ?? "diff"
  const [mode, setMode] = useState<DiffMode>("unified")
  const [mdPreview, setMdPreview] = useState(false)
  const [mdMode, setMdMode] = useState<MdMode>("preview")
  const isMd = path.endsWith(".md")

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <Breadcrumb path={path} />
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground">{baseLabel(base)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {display === "diff" ? (
            <>
              {isMd && (
                <Button variant={mdPreview ? "secondary" : "outline"} size="xs" onClick={() => setMdPreview((x) => !x)}>
                  <Eye className="size-3.5" /> 変更後をプレビュー
                </Button>
              )}
              <DiffModeToggle mode={mode} onChange={setMode} />
            </>
          ) : (
            isMd && <MdModeToggle mode={mdMode} onChange={setMdMode} />
          )}
          {/* 押すたびに「差分」と「ファイル全体」を入れ替える。ラベルは切り替え先 */}
          <Button
            variant="outline"
            size="xs"
            onClick={() => actions.updateTab({ ...tab, display: display === "diff" ? "file" : "diff" })}
            title={display === "diff" ? "ファイル全体を表示" : "差分を表示"}
          >
            {display === "diff" ? (
              <>
                <FileText className="size-3.5" /> ファイル全体
              </>
            ) : (
              <>
                <GitCompare className="size-3.5" /> 差分
              </>
            )}
          </Button>
        </div>
      </Toolbar>
      <div data-find-root className="min-h-0 flex-1 overflow-auto">
        {display === "file" ? (
          <FileBody path={path} mdMode={mdMode} actions={actions} />
        ) : mdPreview && isMd ? (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel className="overflow-auto!">
              <LoadedDiff path={path} oldPath={oldPath} base={base} mode="unified" />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel className="overflow-auto!">
              <FileBody path={path} mdMode="preview" actions={actions} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <LoadedDiff path={path} oldPath={oldPath} base={base} mode={mode} />
        )}
      </div>
    </div>
  )
}

function CommitView({ hash }: { hash: string }) {
  const { data, error, isPending } = useCommit(hash)
  if (isPending) return <Notice>読み込み中…</Notice>
  if (error) return <Notice error>{errorMessage(error)}</Notice>
  return <CommitDetail commit={{ ...data, files: data.files ?? [] }} />
}

function CommitDetail({ commit }: { commit: { hash: string; shortHash: string; message: string; body: string; author: string; date: string; files: Change[] } }) {
  const [mode, setMode] = useState<DiffMode>("unified")
  const [open, setOpen] = useState<Set<string>>(new Set())
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
          <DiffModeToggle mode={mode} onChange={setMode} />
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
                {isOpen && <LoadedDiff path={f.path} oldPath={f.oldPath} base={{ type: "commit", hash: commit.hash }} mode={mode} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
