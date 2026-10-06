"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ResizableHandle } from "@/components/ui/resizable"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ChangeStatus, FileNode, SearchHit } from "@/lib/types"
import { errorMessage, listWorktreeDir, useChildren, useContentSearch, useNameSearch, useSpec, useTree, useWt, type SearchRequest } from "@/lib/api"
import { matchesAny, parseSearchGlobs } from "@/lib/glob"
import { buildMatcher, type Match, type SearchOptions } from "@/lib/search"
import { PathSuggestInput } from "@/components/path-suggest-input"
import { FileIcon, PRESSED_FILL, setTabDrag, statusColor } from "./common"
import type { DocTab } from "./editor-layout"
import { Section, SectionGroup } from "./panel-section"
import { TreeContextMenu } from "./tree-context-menu"

const dragFile = (path: string) => (e: React.DragEvent) => setTabDrag(e, { tab: { kind: "file", path }, fromGroupId: null })

export type SearchMode = "content" | "name"

// 検索欄の入力。Contents / File のタブごとに別々に持つ
type SearchForm = SearchOptions & { q: string; include: string; exclude: string }
const emptyForm: SearchForm = { q: "", caseSensitive: false, regex: false, include: "", exclude: "" }

// 検索中の状態。null なら検索していない
type ActiveSearch = {
  mode: SearchMode
  // 内容の検索でヒットした行 (ファイルのパス → 行)。ファイル名の検索では空
  hits: Map<string, SearchHit[]>
  matches: (node: FileNode) => boolean
  // パスで一致した範囲のうち、ファイル名の中の部分 (強調表示用。位置はファイル名の中)
  nameRanges: (path: string) => Match[]
  // ツリーにまだないファイル (無視されたディレクトリの中でヒットしたもの)。ツリーに差し込む
  extra: { path: string; ignored: boolean }[]
  loading: boolean
  truncated: boolean
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

// 内容の検索はサーバー (rg)。ファイル名の検索 (worktree からのパスに当てる) は、「gitignore」OFF ならブラウザにあるツリーで絞り、ON ならサーバーに問い合わせる
function useSearch(form: SearchForm, mode: SearchMode, showIgnored: boolean): { search: ActiveSearch | null; error?: string } {
  const debounced = useDebounced(form, 200)
  const matcher = buildMatcher(form.q, form)
  const valid = !!matcher && !("error" in matcher)
  const req: SearchRequest | null = valid && debounced.q ? { ...debounced, ignored: showIgnored } : null
  const content = useContentSearch(mode === "content" ? req : null)
  const names = useNameSearch(mode === "name" && showIgnored ? req : null)
  return useMemo(() => {
    if (!matcher) return { search: null }
    if ("error" in matcher) return { search: null, error: matcher.error }
    // 対象 / 対象外 (カンマ区切りの glob)
    const include = parseSearchGlobs(form.include)
    const exclude = parseSearchGlobs(form.exclude)
    const inScope = (path: string) => (!include.length || matchesAny(path, include)) && !(exclude.length && matchesAny(path, exclude))
    if (mode === "name") {
      const server = showIgnored ? (names.data?.files ?? []) : []
      const serverSet = new Set(server.map((f) => f.path))
      return {
        search: {
          mode,
          hits: new Map(),
          matches: (n: FileNode) => (showIgnored ? serverSet.has(n.path) : inScope(n.path) && matcher.find(n.path).length > 0),
          nameRanges: (path: string) => {
            const base = path.lastIndexOf("/") + 1
            return matcher
              .find(path)
              .filter((m) => m.end > base)
              .map((m) => ({ start: Math.max(m.start, base) - base, end: m.end - base }))
          },
          extra: server,
          loading: showIgnored && names.isFetching,
          truncated: !!names.data?.truncated,
        },
        error: names.error ? errorMessage(names.error) : undefined,
      }
    }
    const hits = new Map<string, SearchHit[]>()
    for (const h of content.data?.hits ?? []) if (inScope(h.path)) hits.set(h.path, [...(hits.get(h.path) ?? []), h])
    return {
      search: {
        mode,
        hits,
        matches: (n: FileNode) => hits.has(n.path),
        nameRanges: () => [],
        extra: [...hits.keys()].map((path) => ({ path, ignored: true })),
        loading: content.isFetching,
        truncated: !!content.data?.truncated,
      },
      error: content.error ? errorMessage(content.error) : undefined,
    }
  }, [form, mode, showIgnored, matcher, content.data, content.isFetching, content.error, names.data, names.isFetching, names.error])
}

// ツリーにないファイル (無視されたディレクトリの中) を差し込む。lazy のディレクトリは、差し込んだものだけを子にする
function mergePaths(nodes: FileNode[], extra: { path: string; ignored: boolean }[]): FileNode[] {
  if (!extra.length) return nodes
  const clone = (list: FileNode[]): FileNode[] => list.map((n) => (n.children ? { ...n, children: clone(n.children) } : { ...n }))
  const root = clone(nodes)
  for (const { path, ignored } of extra) {
    let list = root
    const parts = path.split("/")
    let inIgnored = false
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/")
      let d = list.find((n) => n.type === "dir" && n.path === p)
      if (!d) {
        d = { name: parts[i], path: p, type: "dir", children: [], ignored: ignored || inIgnored || undefined }
        list.push(d)
      }
      if (d.lazy) {
        d.lazy = undefined
        d.children = []
      }
      inIgnored ||= !!d.ignored
      list = d.children ??= []
    }
    if (!list.some((n) => n.path === path)) list.push({ name: parts[parts.length - 1], path, type: "file", ignored: ignored || inIgnored || undefined })
  }
  return root
}

// ツリーを絞り込む (除外パターンはサーバーで外している)。
// .gitignore で無視されているもの (ignored) は showIgnored のときだけ残し、子にも ignored を引き継ぐ。
// ファイルが 1 つも残らないディレクトリは外す。中身を読んでいない (lazy) ディレクトリは、絞り込んでいないときだけ残す
function filterTree(
  list: FileNode[],
  keep: (file: FileNode) => boolean,
  opts: { showIgnored: boolean; keepLazy: boolean },
  parentIgnored = false,
): FileNode[] {
  const out: FileNode[] = []
  for (const n of list) {
    const ignored = parentIgnored || !!n.ignored
    if (ignored && !opts.showIgnored) continue
    if (n.type === "dir") {
      if (n.lazy) {
        if (opts.keepLazy) out.push({ ...n, ignored })
        continue
      }
      const children = filterTree(n.children ?? [], keep, opts, ignored)
      if (children.length) out.push({ ...n, ignored, children })
    } else if (keep(n)) {
      out.push({ ...n, ignored })
    }
  }
  return out
}

// 検索語の横の Aa / ab / .* のボタン。ON のときは枠と背景で示す
function OptionToggle({ label, title, on, onClick }: { label: string; title: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        "rounded px-1 font-mono text-[11px] hover:bg-accent",
        on ? "bg-sky-500/15 text-sky-700 ring-1 ring-sky-500/60 dark:text-sky-300" : "text-muted-foreground",
      )}
    >
      {label}
    </button>
  )
}

function countFiles(list: FileNode[]): FileNode[] {
  return list.flatMap((n) => (n.type === "dir" ? countFiles(n.children ?? []) : [n]))
}

function useToggleSet(initial: string[] = []) {
  const [set, setSet] = useState<Set<string>>(() => new Set(initial))
  const toggle = (p: string) =>
    setSet((prev) => {
      const n = new Set(prev)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })
  const add = (ps: string[]) =>
    setSet((prev) => (ps.every((p) => prev.has(p)) ? prev : new Set([...prev, ...ps])))
  const remove = (ps: string[]) => setSet((prev) => (ps.some((p) => prev.has(p)) ? new Set([...prev].filter((p) => !ps.includes(p))) : prev))
  const clear = () => setSet((prev) => (prev.size ? new Set() : prev))
  return [set, toggle, add, remove, clear] as const
}

// ---------------------------------------------------------------------------
// ファイル (検索 + SPEC + エクスプローラ)
// 検索すると、エクスプローラのツリーを、ヒットしたファイルとその親ディレクトリだけに絞り込む (SPEC は絞り込まない)
// ---------------------------------------------------------------------------

export function FilesPanel({
  specInput,
  specPatterns,
  onOpen,
  activePath,
  searchMode,
  onSearchModeChange,
  focusSearchSignal,
  diffStatus,
}: {
  // SPEC に出す場所 (worktree バーの SPEC 欄の入力と、それを解釈したパターン)
  specInput: string
  specPatterns: string[]
  onOpen: (tab: DocTab) => void
  activePath?: string
  // 検索欄のタブ (Contents / File)。Ctrl+G / Ctrl+P で外から切り替えるので、呼び出し元で持つ
  searchMode: SearchMode
  onSearchModeChange: (m: SearchMode) => void
  // Ctrl+G / Ctrl+P が押されるたびに変わる値。検索欄にフォーカスする
  focusSearchSignal: number
  // 比較対象との差分があるファイルと、その状態 (M / A など)
  diffStatus: Map<string, ChangeStatus>
}) {
  const wt = useWt()
  const listDir = useMemo(() => listWorktreeDir(wt), [wt])
  const [forms, setForms] = useState<Record<SearchMode, SearchForm>>({ content: emptyForm, name: emptyForm })
  const form = forms[searchMode]
  const setForm = (patch: Partial<SearchForm>) => setForms((prev) => ({ ...prev, [searchMode]: { ...prev[searchMode], ...patch } }))
  const inputRef = useRef<HTMLInputElement>(null)
  // エクスプローラの絞り込み: 変更のみ / .md のみ / gitignore (無視されたファイルも表示)
  const [filters, setFilters] = useState<string[]>([])
  const [expanded, toggleExpanded, expand] = useToggleSet()
  // 絞り込み (検索を含む) の間はすべて開いて表示し、閉じたディレクトリをここに入れる
  const [collapsed, toggleCollapsed, , uncollapse, clearCollapsed] = useToggleSet()
  const [specCollapsed, toggleSpecCollapsed] = useToggleSet()
  const explorerRef = useRef<HTMLDivElement>(null)

  // 開いているファイルが変わったら、エクスプローラで親のディレクトリを開き、その行が見えるまでスクロールする
  const [revealed, setRevealed] = useState<string | undefined>()
  if (activePath !== revealed) {
    setRevealed(activePath)
    if (activePath) {
      const dirs = activePath.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))
      expand(dirs)
      uncollapse(dirs)
    }
  }
  useEffect(() => {
    if (!activePath) return
    const id = requestAnimationFrame(() =>
      explorerRef.current?.querySelector(`[data-tree-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: "nearest" }),
    )
    return () => cancelAnimationFrame(id)
  }, [activePath])

  useEffect(() => {
    if (focusSearchSignal > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focusSearchSignal])

  const changedOnly = filters.includes("changed")
  const mdOnly = filters.includes("md")
  const showIgnored = filters.includes("ignored")
  const { search, error } = useSearch(form, searchMode, showIgnored)
  const tree = useTree(showIgnored)

  // SPEC: worktree バーの SPEC 欄で指定した場所にある .md。.gitignore に関係なく出す (サーバーで探す)。検索では絞り込まない
  const spec = useSpec(specInput)
  const specNodes = specPatterns.length ? (spec.data?.nodes ?? []) : []
  const explorerNodes = useMemo(
    () =>
      filterTree(
        mergePaths(tree.data?.nodes ?? [], search?.extra ?? []),
        (n) => (!changedOnly || diffStatus.has(n.path)) && (!mdOnly || n.path.endsWith(".md")) && (!search || search.matches(n)),
        { showIgnored, keepLazy: !changedOnly && !mdOnly && !search },
      ),
    [tree.data, search, changedOnly, mdOnly, showIgnored, diffStatus],
  )
  const explorerForceOpen = changedOnly || mdOnly || !!search
  // 絞り込みを変えたら、閉じたディレクトリを開き直す
  const forceOpenKey = explorerForceOpen ? JSON.stringify([changedOnly, mdOnly, search ? [searchMode, form] : null]) : ""
  const [prevForceOpenKey, setPrevForceOpenKey] = useState(forceOpenKey)
  if (forceOpenKey !== prevForceOpenKey) {
    setPrevForceOpenKey(forceOpenKey)
    clearCollapsed()
  }

  const summary = useMemo(() => {
    if (!search) return null
    const files = countFiles(explorerNodes)
    const more = search.truncated ? " (多いため一部だけ)" : ""
    if (!files.length) return search.loading ? "検索中…" : "見つかりません"
    if (search.mode === "name") return `${files.length} ファイル${more}`
    return `${files.reduce((a, f) => a + (search.hits.get(f.path)?.length ?? 0), 0)} 件 / ${files.length} ファイル${more}`
  }, [search, explorerNodes])

  return (
    <>
      <div className="shrink-0 border-b">
        <Tabs value={searchMode} onValueChange={(v) => onSearchModeChange(v as SearchMode)}>
          <TabsList variant="line" className="h-9 w-full justify-start border-b px-2">
            <TabsTrigger value="content" className="flex-none px-3 text-xs" title="内容で検索 (Ctrl+G)">
              Contents
            </TabsTrigger>
            <TabsTrigger value="name" className="flex-none px-3 text-xs" title="ファイル名で検索 (Ctrl+P)">
              File
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="space-y-1.5 px-3 pt-2 pb-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={form.q}
              onChange={(e) => setForm({ q: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setForm({ q: "" })}
              placeholder={searchMode === "content" ? "内容で絞り込む (Ctrl+G)" : "ファイル名で絞り込む (Ctrl+P)"}
              aria-invalid={!!error}
              className="h-8 pr-28 pl-7 text-sm"
            />
            <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
              <OptionToggle label="Aa" title="大文字小文字を区別" on={form.caseSensitive} onClick={() => setForm({ caseSensitive: !form.caseSensitive })} />
              <OptionToggle label=".*" title="正規表現" on={form.regex} onClick={() => setForm({ regex: !form.regex })} />
              {form.q && (
                <button onClick={() => setForm({ q: "" })} className="rounded p-0.5 text-muted-foreground hover:bg-accent" title="クリア (Esc)">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <PathSuggestInput
            value={form.include}
            onChange={(v) => setForm({ include: v })}
            list={listDir}
            listKey={`wt:${wt.projectId}/${wt.worktreeId}`}
            separator=","
            placeholder="対象: 例 *.md, docs/adr"
            className="h-7 font-mono text-xs md:text-xs"
          />
          <PathSuggestInput
            value={form.exclude}
            onChange={(v) => setForm({ exclude: v })}
            list={listDir}
            listKey={`wt:${wt.projectId}/${wt.worktreeId}`}
            separator=","
            placeholder="対象外: 例 tmp, *.log"
            className="h-7 font-mono text-xs md:text-xs"
          />
        </div>
      </div>

      <SectionGroup storageKey="files-panel-layout">
        <Section id="spec" title="Spec" count={specNodes.length ? (spec.data?.count ?? 0) : 0} defaultSize="30">
          {specNodes.length ? (
            <TreeContextMenu>
              <div className="px-1">
                <Tree
                  nodes={specNodes}
                  depth={0}
                  isOpen={(p) => !specCollapsed.has(p)}
                  toggle={toggleSpecCollapsed}
                  onOpen={onOpen}
                  activePath={activePath}
                  search={null}
                  diffStatus={diffStatus}
                  dimIgnored={false}
                />
              </div>
            </TreeContextMenu>
          ) : (
            <p className="px-3 py-1 text-xs text-muted-foreground">
              {specPatterns.length
                ? spec.isPending
                  ? "読み込み中…"
                  : spec.error
                    ? errorMessage(spec.error)
                    : "指定した場所に .md はありません"
                  : "上の worktree バーの SPEC 欄に、spec や plan の場所を入力してください (例: agent-tasks/226_add_gateway/*)"}
            </p>
          )}
        </Section>
        <ResizableHandle />
        <Section
          id="explorer"
          title="Explorer"
          defaultSize="70"
          actions={
            <ToggleGroup size="sm" variant="outline" multiple value={filters} onValueChange={(v: string[]) => setFilters(v)}>
              <ToggleGroupItem value="changed" className={cn("h-6 px-2 text-[11px]", PRESSED_FILL)} title="比較対象との差分があるファイルだけを表示">
                変更のみ
              </ToggleGroupItem>
              <ToggleGroupItem value="md" className={cn("h-6 px-2 text-[11px]", PRESSED_FILL)}>
                .md のみ
              </ToggleGroupItem>
              <ToggleGroupItem value="ignored" className={cn("h-6 px-2 text-[11px]", PRESSED_FILL)} title=".gitignore で無視されたファイルも表示する">
                gitignore
              </ToggleGroupItem>
            </ToggleGroup>
          }
        >
          {summary && <p className="px-3 pb-1 text-xs text-muted-foreground">{summary}</p>}
          {tree.isPending && <p className="px-3 py-1 text-xs text-muted-foreground">読み込み中…</p>}
          {tree.error && <p className="px-3 py-1 text-xs text-destructive">{errorMessage(tree.error)}</p>}
          {tree.data?.truncated && (
            <p className="px-3 pb-1 text-xs text-amber-700 dark:text-amber-400">ファイルが多いため一部だけ表示しています。除外パターンを追加してください</p>
          )}
          <TreeContextMenu>
            <div ref={explorerRef} className="px-1">
              <Tree
                nodes={explorerNodes}
                depth={0}
                isOpen={(p) => (explorerForceOpen ? !collapsed.has(p) : expanded.has(p))}
                toggle={explorerForceOpen ? toggleCollapsed : toggleExpanded}
                onOpen={onOpen}
                activePath={activePath}
                search={search}
                diffStatus={diffStatus}
                dimIgnored
              />
            </div>
          </TreeContextMenu>
        </Section>
      </SectionGroup>
    </>
  )
}

function Tree(props: {
  nodes: FileNode[]
  depth: number
  isOpen: (dirPath: string) => boolean
  toggle: (dirPath: string) => void
  onOpen: (tab: DocTab) => void
  activePath?: string
  search: ActiveSearch | null
  diffStatus: Map<string, ChangeStatus>
  // .gitignore で無視されたファイルを薄く表示する
  dimIgnored: boolean
}) {
  const { nodes, depth, isOpen, toggle, onOpen, activePath, search, diffStatus, dimIgnored } = props
  // 子が 1 つだけのディレクトリは連結して表示 (深い階層を浅く見せる)
  return (
    <>
      {nodes.map((n) => {
        const dim = dimIgnored && n.ignored
        if (n.type === "dir") {
          let node = n
          let label = n.name
          while (node.children?.length === 1 && node.children[0].type === "dir") {
            node = node.children[0]
            label += "/" + node.name
          }
          const open = isOpen(n.path)
          return (
            <div key={n.path}>
              <button
                data-tree-path={node.path}
                className={cn("flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left text-sm hover:bg-accent", dim && "opacity-50")}
                style={{ paddingLeft: depth * 12 + 4 }}
                onClick={() => toggle(n.path)}
              >
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                {open ? <FolderOpen className="size-4 shrink-0 text-sky-500" /> : <Folder className="size-4 shrink-0 text-sky-500" />}
                <span className="truncate">{label}</span>
              </button>
              {open && (node.lazy ? <LazyChildren {...props} path={node.path} depth={depth + 1} /> : <Tree {...props} nodes={node.children ?? []} depth={depth + 1} />)}
            </div>
          )
        }
        const hits = search?.hits.get(n.path) ?? []
        const status = diffStatus.get(n.path)
        return (
          <div key={n.path}>
            <button
              data-tree-path={n.path}
              data-tree-download
              draggable
              onDragStart={dragFile(n.path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-sm hover:bg-accent",
                // 開いているファイル (ホバーと見分けられる色にする)
                activePath === n.path && "bg-sky-500/20 hover:bg-sky-500/25",
                dim && "opacity-50",
              )}
              style={{ paddingLeft: depth * 12 + 22 }}
              onClick={() => onOpen({ kind: "file", path: n.path })}
              title={dim ? `${n.path} (.gitignore で無視されています)` : undefined}
            >
              <FileIcon path={n.path} />
              <span className={cn("truncate", status && statusColor[status])}>
                {search?.mode === "name" ? <Highlight text={n.name} ranges={search.nameRanges(n.path)} /> : n.name}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {hits.length > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    {hits.length}
                  </Badge>
                )}
                {status && <span className={cn("font-mono text-xs", statusColor[status])}>{status}</span>}
              </span>
            </button>
            {/* 内容の検索では、ヒットした行をファイルの下に並べる */}
            {search &&
              hits.map((h) => (
                <button
                  key={h.line}
                  // 行を見せるため、全体をソースで表示する
                  onClick={() => onOpen({ kind: "file", path: n.path, line: h.line, display: "file", md: "source" })}
                  className="flex w-full gap-2 rounded py-0.5 pr-2 text-left hover:bg-accent"
                  style={{ paddingLeft: depth * 12 + 40 }}
                >
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{h.line}</span>
                  <span className="truncate font-mono text-xs">
                    <Highlight text={h.text} ranges={h.matches} trimStart />
                  </span>
                </button>
              ))}
          </div>
        )
      })}
    </>
  )
}

// 中身を読んでいない無視されたディレクトリ。開いたときにサーバーから読む
function LazyChildren(props: Parameters<typeof Tree>[0] & { path: string }) {
  const { data, isPending, error } = useChildren(props.path, true)
  const pad = { paddingLeft: props.depth * 12 + 22 }
  if (isPending) return <p className="py-0.5 text-xs text-muted-foreground" style={pad}>読み込み中…</p>
  if (error) return <p className="py-0.5 text-xs text-destructive" style={pad}>{errorMessage(error)}</p>
  if (!data?.length) return <p className="py-0.5 text-xs text-muted-foreground" style={pad}>(空)</p>
  return <Tree {...props} nodes={data} />
}

// 一致した範囲を強調する。trimStart のときは行頭の空白を省いて表示する
function Highlight({ text, ranges, trimStart }: { text: string; ranges: Match[]; trimStart?: boolean }) {
  const offset = trimStart ? text.length - text.trimStart().length : 0
  const parts: React.ReactNode[] = []
  let pos = offset
  for (const r of ranges) {
    const start = Math.max(r.start, pos)
    if (r.end <= start) continue
    if (start > pos) parts.push(text.slice(pos, start))
    parts.push(
      <mark key={start} className="rounded-sm bg-amber-300/60 text-foreground dark:bg-amber-500/40">
        {text.slice(start, r.end)}
      </mark>,
    )
    pos = r.end
  }
  parts.push(text.slice(pos))
  return <>{parts}</>
}
