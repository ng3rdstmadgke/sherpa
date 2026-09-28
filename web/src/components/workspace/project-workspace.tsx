"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ChevronDown, Files, GitBranch, GitCompare, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Project } from "@/lib/types"
import { api, useChanges, useCompare, useSpec, wtUrl, WtContext, type WtRef } from "@/lib/api"
import { onWatchEvent, useWatchStatus } from "@/lib/events"
import { relTime } from "@/lib/format"
import { usePersistentState } from "@/lib/persist"
import { parseSpecPaths } from "@/lib/spec"
import { createLayout, findGroup, groups, openTab, tabKey, type DiffBase, type DocTab, type Layout } from "./editor-layout"
import { EditorArea, type FindState } from "./editor-area"
import { FilesPanel, type SearchMode } from "./side-panels"
import { GitPanel } from "./git-panel"
import { WorktreeInfo } from "./worktree-info"
import { SpecPathsInput } from "./spec-paths-input"
import { ComparePicker, type CompareState } from "./compare-picker"

type View = "files" | "git"

const VIEWS = [
  { id: "files", icon: Files, label: "ファイル (Ctrl+Shift+E)" },
  { id: "git", icon: GitCompare, label: "Git 差分 (Ctrl+Shift+G)" },
] as const

export function worktreeLabel(project: Project, worktreeId: string) {
  const w = project.worktrees.find((x) => x.id === worktreeId)
  if (!w) return worktreeId
  return w.isMain ? "(main worktree)" : w.name
}

// タブごとに保存・復元する状態
type WorkspaceState = {
  view: View
  // メニューごとに中央のエディタレイアウトを別々に持つ
  layouts: Record<View, Layout>
  compare: CompareState
}

// 比較対象の既定値: プロジェクトの設定のブランチ (なくなっていれば自動) → 自動 (main → master → develop)
const defaultCompareBranch = (project: Project) => project.defaultCompareBranch ?? project.autoCompareBranch ?? ""

const initialState = (project: Project): WorkspaceState => ({
  view: "files",
  layouts: { files: createLayout(), git: createLayout() },
  compare: { branch: defaultCompareBranch(project), includeUncommitted: true },
})

// 開いているタブのパス (自動更新の通知で、読み直したタブを知るため)
function openPaths(layouts: Record<View, Layout>) {
  const paths = new Set<string>()
  for (const l of Object.values(layouts)) for (const g of groups(l.root)) for (const t of g.tabs) if (t.kind !== "commit") paths.add(t.path)
  return paths
}

export function ProjectWorkspace({
  instanceId,
  project,
  worktreeId,
  onWorktreeChange,
  active: isActive,
}: {
  instanceId: string
  project: Project
  worktreeId: string
  onWorktreeChange: (id: string) => void
  active: boolean
}) {
  const worktree = project.worktrees.find((w) => w.id === worktreeId)
  const wt = useMemo<WtRef>(() => ({ projectId: project.id, worktreeId }), [project.id, worktreeId])
  const [state, setState] = usePersistentState<WorkspaceState>(`ws:${instanceId}`, () => initialState(project))
  const { view, layouts } = state
  const setView = useCallback((v: View) => setState((s) => ({ ...s, view: v })), [setState])
  const setCompare = (c: CompareState) => setState((s) => ({ ...s, compare: c }))
  // ファイルメニューの検索欄のタブと、フォーカスの合図 (Ctrl+G: Contents、Ctrl+P: File)
  const [searchMode, setSearchMode] = useState<SearchMode>("content")
  const [focusSearch, setFocusSearch] = useState(0)
  // グループ内検索 (Ctrl+F)。開いている検索バーは表示中のメニューで 1 つだけ
  const [find, setFind] = useState<(FindState & { view: View }) | null>(null)
  // キーボードのハンドラから最新の表示状態を読むため
  const latest = useRef({ view, layouts })
  useEffect(() => {
    latest.current = { view, layouts }
  }, [view, layouts])
  const reloaded = useReloadNotice(wt, layouts)
  const qc = useQueryClient()
  const watch = useWatchStatus(`${project.id}/${worktreeId}`)
  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["wt", project.id, worktreeId] })
    void qc.invalidateQueries({ queryKey: ["projects"] })
  }

  const updateView = useCallback(
    (v: View) => (fn: (l: Layout) => Layout) => setState((s) => ({ ...s, layouts: { ...s.layouts, [v]: fn(s.layouts[v]) } })),
    [setState],
  )
  const provided = (children: React.ReactNode) => <WtContext.Provider value={wt}>{children}</WtContext.Provider>
  // SPEC に出す場所。worktree ごとに SQLite に保存する (worktree バーの SPEC 欄で入力する)。保存が一覧に反映されるまでは入力した値を使う
  const [specLocal, setSpecLocal] = useState<{ worktreeId: string; value: string } | null>(null)
  const specInput = specLocal?.worktreeId === worktreeId ? specLocal.value : (worktree?.specPaths ?? "")
  const setSpecInput = (value: string) => {
    setSpecLocal({ worktreeId, value })
    void api(wtUrl(wt, "spec-paths"), { method: "PUT", body: { input: value } }).then(() => qc.invalidateQueries({ queryKey: ["projects"] }))
  }
  const specPatterns = useMemo(() => parseSpecPaths(specInput), [specInput])

  if (!worktree || worktree.missing) {
    return (
      <div className={cn("min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm", isActive ? "flex" : "hidden")}>
        <AlertTriangle className="size-6 text-destructive" />
        <p>worktree が見つかりません ({worktreeId})</p>
        <p className="text-xs text-muted-foreground">削除されたか、場所が変わった可能性があります。</p>
        {worktreeId !== "main" && (
          <Button variant="outline" size="sm" onClick={() => onWorktreeChange("main")}>
            main worktree に切り替える
          </Button>
        )}
      </div>
    )
  }

  return provided(
    <WorkspaceBody
      {...{ project, worktreeId, onWorktreeChange, isActive, state, setState, setView, setCompare, searchMode, setSearchMode, focusSearch, setFocusSearch, find, setFind }}
      {...{ latest, reloaded, reload, watch, specInput, setSpecInput, specPatterns, updateView }}
    />,
  )
}

type BodyProps = {
  project: Project
  worktreeId: string
  onWorktreeChange: (id: string) => void
  isActive: boolean
  state: WorkspaceState
  setState: React.Dispatch<React.SetStateAction<WorkspaceState>>
  setView: (v: View) => void
  setCompare: (c: CompareState) => void
  searchMode: SearchMode
  setSearchMode: (m: SearchMode) => void
  focusSearch: number
  setFocusSearch: React.Dispatch<React.SetStateAction<number>>
  find: (FindState & { view: View }) | null
  setFind: React.Dispatch<React.SetStateAction<(FindState & { view: View }) | null>>
  latest: React.RefObject<{ view: View; layouts: Record<View, Layout> }>
  reloaded: string | null
  reload: () => void
  watch: { status: "ok" | "error" | "off"; message?: string }
  specInput: string
  setSpecInput: (v: string) => void
  specPatterns: string[]
  updateView: (v: View) => (fn: (l: Layout) => Layout) => void
}

// worktree があるときの本体 (WtContext の中で API を呼ぶため、ProjectWorkspace から分けている)
function WorkspaceBody(props: BodyProps) {
  const { project, worktreeId, onWorktreeChange, isActive, state, setView, setCompare, searchMode, setSearchMode, focusSearch, setFocusSearch, find, setFind } = props
  const { latest, reloaded, reload, watch, specInput, setSpecInput, specPatterns, updateView } = props
  const worktree = project.worktrees.find((w) => w.id === worktreeId)!
  const { view, layouts, compare } = state
  const open = (v: View) => (tab: DocTab) => updateView(v)((l) => openTab(l, tab))
  const compareBase: DiffBase = { type: "branch", ...compare }
  // 比較対象との差分 (Git の COMPARE と同じ範囲)。エクスプローラの「変更のみ」と記号、「差分を見る」が参照する
  const compareQuery = useCompare(compare)
  const diffStatus = useMemo(() => new Map((compareQuery.data?.files ?? []).map((c) => [c.path, c.status])), [compareQuery.data])
  const ab = { ahead: compareQuery.data?.ahead ?? 0, behind: compareQuery.data?.behind ?? 0 }
  const specCount = useSpec(specInput).data?.count ?? 0
  const changeCount = useChanges().data?.length ?? worktree.changes
  const actionsFor = (v: View) => (groupId: string) => ({
    openFile: (path: string) => updateView(v)((l) => openTab(l, { kind: "file", path }, groupId)),
    updateTab: (tab: DocTab) => updateView(v)((l) => openTab(l, tab, groupId)),
    compareBase,
    hasDiff: (path: string) => diffStatus.has(path),
  })

  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      // Ctrl+G はブラウザの「次を検索」より優先する (Shift 付きは Git メニュー)
      if ((k === "p" || k === "g") && !e.shiftKey) {
        e.preventDefault()
        setView("files")
        setSearchMode(k === "p" ? "name" : "content")
        setFocusSearch((n) => n + 1)
      } else if (k === "f" && !e.shiftKey) {
        // 検索バーの入力欄でもう一度押したときは、ブラウザ標準の検索に任せる
        if ((document.activeElement as HTMLElement | null)?.dataset.findInput !== undefined) return
        e.preventDefault()
        const { view, layouts } = latest.current
        // 文字列を選択していれば、それを検索語にする
        const selected = window.getSelection()?.toString().trim() ?? ""
        setFind((prev) => ({
          view,
          groupId: layouts[view].activeGroupId,
          query: selected && !selected.includes("\n") ? selected : (prev?.query ?? ""),
          nonce: (prev?.nonce ?? 0) + 1,
        }))
      } else if (e.shiftKey && k === "e") {
        e.preventDefault()
        setView("files")
      } else if (e.shiftKey && k === "g") {
        e.preventDefault()
        setView("git")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isActive, setView, latest, setFind, setFocusSearch, setSearchMode])

  const filesLayout = layouts.files
  const filesActive = findGroup(filesLayout.root, filesLayout.activeGroupId)
  const activeFilePath = filesActive?.tabs.find((t) => tabKey(t) === filesActive.activeKey)

  return (
    <div className={cn("relative min-h-0 flex-1 flex-col", isActive ? "flex" : "hidden")}>

      {/* ワークツリー / ブランチ バー */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-sm">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
            <GitBranch className="size-4" />
            <span className="font-medium">{worktreeLabel(project, worktreeId)}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[520px]" align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>ワークツリーを切り替え ({project.worktrees.length})</DropdownMenuLabel>
              {project.worktrees.map((w) => (
                <DropdownMenuItem key={w.id} disabled={w.missing} onClick={() => onWorktreeChange(w.id)} className="flex-col items-start gap-0.5 py-2">
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("font-medium", w.id === worktreeId && "text-primary")}>{w.isMain ? "(main worktree)" : w.name}</span>
                    {w.changes > 0 && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        {w.changes} changes
                      </Badge>
                    )}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      ↑{w.ahead} ↓{w.behind}
                    </span>
                  </div>
                  <div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{w.missing ? "(見つかりません)" : (w.branch ?? `(detached) ${w.head}`)}</span>
                    {w.lastCommit && (
                      <span className="ml-auto truncate">
                        {w.lastCommit.message} · {relTime(w.lastCommit.date)}
                      </span>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ComparePicker value={compare} onChange={setCompare} error={compareQuery.error} />
        <SpecPathsInput key={worktreeId} value={specInput} onChange={setSpecInput} count={specCount} />
        <WorktreeInfo project={project} worktree={worktree} compareBranch={compare.branch} ahead={ab.ahead} behind={ab.behind} />
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="relative" onClick={reload} />}>
              <RefreshCw className="size-4" />
              {/* 監視中 (自動更新) の印。監視できないときや、サーバーとの接続が切れているときは灰色 */}
              <span className={cn("absolute top-1 right-1 size-1.5 rounded-full", watch.status === "ok" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
            </TooltipTrigger>
            <TooltipContent>
              {watch.status === "ok"
                ? "自動更新中: ファイルの変更を監視し、開いているタブと差分を自動で再読み込みします。クリックで手動で再読み込み"
                : `${watch.message}。クリックで手動で再読み込み`}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* アクティビティバー */}
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
          {VIEWS.map(({ id, icon: Icon, label }) => (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("relative", view === id && "bg-accent text-accent-foreground")}
                    onClick={() => setView(id)}
                  />
                }
              >
                <Icon className="size-5" />
                {id === "git" && changeCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
                    {changeCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="24" minSize={220}>
            <div className="flex h-full flex-col overflow-hidden">
              {view === "files" && (
                <FilesPanel
                  specInput={specInput}
                  specPatterns={specPatterns}
                  onOpen={open("files")}
                  activePath={activeFilePath?.kind === "file" ? activeFilePath.path : undefined}
                  searchMode={searchMode}
                  onSearchModeChange={setSearchMode}
                  focusSearchSignal={focusSearch}
                  diffStatus={diffStatus}
                />
              )}
              {view === "git" && <GitPanel compare={compare} compareQuery={compareQuery} onOpen={open("git")} />}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>
            {/* 状態 (スクロール位置など) を保つため 3 つとも描画しておき、表示だけ切り替える */}
            {VIEWS.map(({ id }) => (
              <div key={id} className={cn("h-full", view !== id && "hidden")}>
                <EditorArea
                  layout={layouts[id]}
                  update={updateView(id)}
                  actionsFor={actionsFor(id)}
                  empty={<EmptyState view={id} />}
                  find={isActive && find?.view === id ? find : null}
                  onFindChange={(f) => setFind(f && { ...f, view: id })}
                />
              </div>
            ))}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {reloaded && isActive && (
        <div className="absolute right-4 bottom-4 z-30 flex items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm shadow-lg">
          <RefreshCw className="size-4 text-emerald-600" />
          <span>
            <span className="font-mono">{reloaded}</span> が更新されたため再読み込みしました
          </span>
        </div>
      )}
    </div>
  )
}

// 開いているタブのファイルが変わったら (自動更新で読み直したら)、右下に 4 秒だけ通知を出す
function useReloadNotice(wt: WtRef, layouts: Record<View, Layout>) {
  const [notice, setNotice] = useState<string | null>(null)
  const paths = useRef(openPaths(layouts))
  useEffect(() => {
    paths.current = openPaths(layouts)
  }, [layouts])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onWatchEvent((e) => {
      if (e.type !== "files" || e.projectId !== wt.projectId || e.worktreeId !== wt.worktreeId) return
      const hit = e.paths.find((p) => paths.current.has(p))
      if (!hit) return
      setNotice(hit.split("/").pop() ?? hit)
      clearTimeout(timer)
      timer = setTimeout(() => setNotice(null), 4000)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [wt])
  return notice
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border px-1.5 py-0.5 font-mono text-xs">{children}</kbd>
}

function EmptyState({ view }: { view: View }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      {view === "files" && (
        <>
          <p>ファイルを選択してください</p>
          <p className="flex items-center gap-2">
            <Kbd>Ctrl+P</Kbd> ファイル名で探す <Kbd>Ctrl+G</Kbd> 内容で探す
          </p>
        </>
      )}
      {view === "git" && <p>左の一覧から変更ファイルかコミットを選択してください</p>}
      <p className="text-xs">タブやファイルをここの端へドラッグすると画面を分割できます</p>
    </div>
  )
}
