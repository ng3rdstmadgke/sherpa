"use client"

import { useLayoutEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import { AlertTriangle, FolderGit2, GitBranch, Home, Moon, MoreHorizontal, Pencil, Plus, Settings, Sun, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { Project, Worktree } from "@/lib/types"
import { api, errorMessage, useHealth, useProjects } from "@/lib/api"
import { useWatchEvents } from "@/lib/events"
import { relTime, tildify } from "@/lib/format"
import { removePersisted, usePersistentState } from "@/lib/persist"
import type { Theme } from "@/lib/theme"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectWorkspace, worktreeLabel } from "@/components/workspace/project-workspace"
import { ProjectDialog } from "@/components/project-dialog"
import { SettingsPage } from "@/components/settings-page"
import { AppNavContext, type SettingsSection } from "@/components/app-nav"

// 1 つのタブ = プロジェクト + ワークツリー。同じプロジェクトを複数のタブで開ける
type Instance = { id: string; projectId: string; worktreeId: string }

// 設定タブの id (プロジェクトのタブの id と重ならない値)
const SETTINGS = "settings"

const newInstanceId = () => `t-${Math.random().toString(36).slice(2, 9)}`

export function AppShell() {
  // 開いているタブと選択中のタブは保存し、再起動後に復元する
  const [storedInstances, setInstances] = usePersistentState<Instance[]>("instances", () => [])
  const projectsQuery = useProjects()
  const projects = projectsQuery.data ?? []
  // 登録を解除したプロジェクトのタブは出さない (一覧を読み込むまでは、保存していたタブをそのまま出す)
  const instances = projectsQuery.data ? storedInstances.filter((i) => projects.some((p) => p.id === i.projectId)) : storedInstances
  // 開いているタブの worktree の変更を、サーバーから SSE で受け取る
  useWatchEvents(instances.map((i) => `${i.projectId}/${i.worktreeId}`))
  const [storedActiveId, setActiveId] = usePersistentState<string>("activeId", () => instances[0]?.id ?? "home")
  // 設定タブ (1 つだけ)。開いているかどうかも保存する
  const [settingsOpen, setSettingsOpen] = usePersistentState<boolean>("settingsOpen", () => false)
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSection; nonce: number }>()
  const activeId =
    instances.some((i) => i.id === storedActiveId) || (storedActiveId === SETTINGS && settingsOpen) ? storedActiveId : "home"
  // ライト / ダーク。保存して、次に開いたときも同じテーマにする
  const [theme, setTheme] = usePersistentState<Theme>("theme", () => "light")
  const dark = theme === "dark"
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  // 同じプロジェクト + ワークツリーが既に開いていればそのタブへ、なければ新しいタブで開く
  const open = (projectId: string, worktreeId = "main") => {
    const existing = instances.find((i) => i.projectId === projectId && i.worktreeId === worktreeId)
    if (existing) return setActiveId(existing.id)
    const inst = { id: newInstanceId(), projectId, worktreeId }
    setInstances((prev) => [...prev, inst])
    setActiveId(inst.id)
  }
  const close = (id: string) => {
    const next = instances.filter((x) => x.id !== id)
    setInstances(next)
    removePersisted(`ws:${id}`)
    if (activeId === id) setActiveId(next[next.length - 1]?.id ?? "home")
  }
  // 登録の解除: そのプロジェクトのタブをすべて閉じる
  const closeProject = (projectId: string) => {
    const next = storedInstances.filter((x) => x.projectId !== projectId)
    for (const i of storedInstances) if (i.projectId === projectId) removePersisted(`ws:${i.id}`)
    setInstances(next)
    if (!next.some((i) => i.id === activeId) && activeId !== SETTINGS) setActiveId("home")
  }
  const nav = {
    openSettings: (section?: SettingsSection) => {
      setSettingsOpen(true)
      setActiveId(SETTINGS)
      if (section) setSettingsFocus((prev) => ({ section, nonce: (prev?.nonce ?? 0) + 1 }))
    },
  }
  const closeSettings = () => {
    setSettingsOpen(false)
    if (activeId === SETTINGS) setActiveId(instances[instances.length - 1]?.id ?? "home")
  }
  const changeWorktree = (id: string, worktreeId: string) =>
    setInstances((prev) => prev.map((i) => (i.id === id ? { ...i, worktreeId } : i)))
  const toggleDark = () => setTheme(dark ? "light" : "dark")

  return (
    <AppNavContext.Provider value={nav}>
      <div className="flex h-screen flex-col overflow-hidden">
        {/* プロジェクトタブ */}
        <header className="flex h-11 shrink-0 items-center gap-1 border-b bg-muted/50 px-2">
          <div className="mr-2 flex items-center gap-1.5 px-1 font-semibold tracking-tight">
            <FolderGit2 className="size-5" />
            sherpa
          </div>
          <button
            onClick={() => setActiveId("home")}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm",
              activeId === "home" ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60",
            )}
          >
            <Home className="size-4" /> Projects
          </button>
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {instances.map((inst) => {
              const p = projects.find((x) => x.id === inst.projectId)
              const w = p?.worktrees.find((x) => x.id === inst.worktreeId)
              if (!p) return null
              return (
                <div
                  key={inst.id}
                  onClick={() => setActiveId(inst.id)}
                  onAuxClick={(e) => e.button === 1 && close(inst.id)}
                  title={w ? `${p.name} / ${branchLabel(w)}\n${tildify(w.hostPath)}` : p.name}
                  className={cn(
                    "group flex h-8 max-w-72 shrink-0 cursor-pointer items-center gap-2 rounded-md pr-1 pl-3 text-sm",
                    activeId === inst.id ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60",
                  )}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", p.color)} />
                  <span className="shrink-0">{p.name}</span>
                  {w && !w.isMain && <span className="truncate text-xs text-muted-foreground">/ {w.name}</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      close(inst.id)
                    }}
                    className="shrink-0 rounded p-0.5 opacity-50 group-hover:opacity-100 hover:bg-muted"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )
            })}
            {settingsOpen && (
              <div
                onClick={() => setActiveId(SETTINGS)}
                onAuxClick={(e) => e.button === 1 && closeSettings()}
                className={cn(
                  "group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md pr-1 pl-3 text-sm",
                  activeId === SETTINGS ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60",
                )}
              >
                <Settings className="size-3.5" /> 設定
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    closeSettings()
                  }}
                  className="shrink-0 rounded p-0.5 opacity-50 group-hover:opacity-100 hover:bg-muted"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          </div>
          <OpenProjectMenu projects={projects} onOpen={open} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={toggleDark} title={dark ? "ライトにする" : "ダークにする"}>
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon-sm" title="全体の設定" onClick={() => nav.openSettings()}>
              <Settings className="size-4" />
            </Button>
          </div>
        </header>

        <HealthBanner />
        {activeId === "home" && (
          <ProjectsHome projects={projects} loading={projectsQuery.isPending} error={projectsQuery.error} onOpen={open} onRemoved={closeProject} />
        )}
        {activeId === SETTINGS && <SettingsPage focus={settingsFocus} />}
        {instances.map((inst) => {
          const project = projects.find((p) => p.id === inst.projectId)
          if (!project) return null
          return (
            <ProjectWorkspace
              key={inst.id}
              instanceId={inst.id}
              project={project}
              worktreeId={inst.worktreeId}
              onWorktreeChange={(w) => changeWorktree(inst.id, w)}
              active={activeId === inst.id}
            />
          )
        })}
      </div>
    </AppNavContext.Provider>
  )
}

// ブランチにない HEAD は "(detached) 2ff64ad" と出す
export function branchLabel(w: Worktree) {
  if (w.missing) return "(見つかりません)"
  return w.branch ?? `(detached) ${w.head}`
}

// git がないときの帯
function HealthBanner() {
  const { data } = useHealth()
  if (!data || data.git.ok) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-4 py-1.5 text-sm text-destructive">
      <AlertTriangle className="size-4" /> git が見つかりません。git をインストールしてから起動し直してください
    </div>
  )
}

function OpenProjectMenu({ projects, onOpen }: { projects: Project[]; onOpen: (projectId: string, worktreeId?: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" title="新しいタブで開く" />}>
        <Plus className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" align="start">
        {projects.map((p, i) => (
          <DropdownMenuGroup key={p.id}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", p.color)} />
              {p.name}
              <span className="ml-auto font-mono text-[10px] font-normal">{tildify(p.path)}</span>
            </DropdownMenuLabel>
            {p.worktrees.map((w) => (
              <DropdownMenuItem key={w.id} disabled={w.missing} onClick={() => onOpen(p.id, w.id)} className="pl-6">
                <GitBranch className="size-3.5" />
                <span className="truncate">{worktreeLabel(p, w.id)}</span>
                {w.missing && <span className="text-[10px] text-muted-foreground">見つかりません</span>}
                {w.changes > 0 && (
                  <Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[10px]">
                    {w.changes}
                  </Badge>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        {projects.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">登録済みのプロジェクトはありません</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// ホーム (プロジェクト一覧)
// ---------------------------------------------------------------------------

function ProjectsHome({
  projects,
  loading,
  error,
  onOpen,
  onRemoved,
}: {
  projects: Project[]
  loading: boolean
  error: Error | null
  onOpen: (projectId: string, worktreeId?: string) => void
  onRemoved: (projectId: string) => void
}) {
  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">登録済みのプロジェクト。ワークツリーをクリックするとタブで開きます (複数のワークツリーを並べて開けます)。</p>
          </div>
          <ProjectDialog
            triggerLabel={
              <>
                <Plus className="size-4" /> プロジェクトを登録
              </>
            }
          />
        </div>
        {loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {error && <p className="text-sm text-destructive">{errorMessage(error)}</p>}
        {!loading && !error && projects.length === 0 && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            プロジェクトはまだ登録されていません。「プロジェクトを登録」から git リポジトリのディレクトリを指定してください。
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={(w) => onOpen(p.id, w)} onRemoved={() => onRemoved(p.id)} />
          ))}
        </div>
      </div>
    </main>
  )
}

function ProjectCard({ project, onOpen, onRemoved }: { project: Project; onOpen: (worktreeId: string) => void; onRemoved: () => void }) {
  const totalChanges = project.worktrees.reduce((a, w) => a + w.changes, 0)
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const latest = project.worktrees
    .map((w) => w.lastCommit?.date)
    .filter((d): d is string => !!d)
    .sort()
    .pop()
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className={cn("size-2.5 rounded-full", project.color)} />
        <span className="font-semibold">{project.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{tildify(project.path)}</span>
        <div className="ml-auto flex items-center gap-1">
          {project.pathMappings.length > 0 && project.worktrees.some((w) => w.containerPath) && (
            <Badge variant="outline" className="text-[10px]">
              devcontainer
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" title="プロジェクトのメニュー" />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> 編集
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRemoving(true)} variant="destructive">
                <Trash2 className="size-3.5" /> 登録を解除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ProjectDialog project={project} open={editing} onOpenChange={setEditing} />
      <RemoveProjectDialog project={project} open={removing} onOpenChange={setRemoving} onRemoved={onRemoved} />
      {project.missing && <p className="mb-2 text-xs text-destructive">ディレクトリが見つかりません</p>}
      {project.error && <p className="mb-2 text-xs text-destructive">{project.error}</p>}
      <div className="space-y-1">
        {project.worktrees.map((w) => (
          <button
            key={w.id}
            onClick={() => onOpen(w.id)}
            disabled={w.missing}
            title={w.missing ? "worktree が見つかりません" : undefined}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm odd:bg-muted/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs">{branchLabel(w)}</span>
            {!w.isMain && <span className="truncate text-[11px] text-muted-foreground">{w.relPath}</span>}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
              ↑{w.ahead} ↓{w.behind}
            </span>
            {w.changes > 0 ? (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                {w.changes}
              </Badge>
            ) : (
              <span className="w-5" />
            )}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {project.worktrees.length} worktrees · 未コミット {totalChanges} ファイル{latest && ` · 最終コミット ${relTime(latest)}`}
      </p>
    </div>
  )
}

// 登録の解除の確認。sherpa に保存したものだけを消し、リポジトリのファイルには触れない
function RemoveProjectDialog({
  project,
  open,
  onOpenChange,
  onRemoved,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE", body: {} })
      onRemoved()
      onOpenChange(false)
      await qc.invalidateQueries({ queryKey: ["projects"] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登録を解除: {project.name}</DialogTitle>
          <DialogDescription>
            sherpa に保存した設定 (表示名・パスマッピング・除外パターン・SPEC 欄の入力) を消し、このプロジェクトのタブを閉じます。リポジトリのファイルは消しません。
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>キャンセル</DialogClose>
          <Button variant="destructive" onClick={remove} disabled={busy}>
            登録を解除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
