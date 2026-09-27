import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import { matchesAny } from "@/lib/glob"
import { parseSpecPaths, specBaseDir } from "@/lib/spec"
import type { WatchEvent } from "@/lib/types"
import { ignoredEntries } from "./files"
import { getCtx, specPathsOf } from "./projects"

// ファイルの監視と、SSE の購読者の管理 (docs/agent-tasks/init/implementation-plan.md §5)。
// 監視するのは、ブラウザで開いているタブの worktree だけ。購読がなくなって 30 秒たったら止める

type Sub = { keys: Set<string>; send: (e: WatchEvent) => void }

type Watch = {
  key: string
  projectId: string
  worktreeId: string
  refs: number
  watchers: FSWatcher[]
  stopTimer?: ReturnType<typeof setTimeout>
  flushTimer?: ReturnType<typeof setTimeout>
  paths: Set<string>
  structure: boolean
  git: boolean
  worktrees: boolean
  error?: string
}

type Hub = { subs: Set<Sub>; watches: Map<string, Watch> }

const g = globalThis as unknown as { __sherpaHub?: Hub }
const hub: Hub = (g.__sherpaHub ??= { subs: new Set(), watches: new Map() })

const STOP_AFTER = 30_000
const DEBOUNCE = 300

export const watchKey = (projectId: string, worktreeId: string) => `${projectId}/${worktreeId}`

export function broadcast(e: WatchEvent) {
  const key = "worktreeId" in e ? watchKey(e.projectId, e.worktreeId) : null
  for (const s of hub.subs) {
    if (key && !s.keys.has(key)) continue
    if (e.type === "worktrees" && ![...s.keys].some((k) => k.startsWith(e.projectId + "/"))) continue
    s.send(e)
  }
}

export function subscribe(keys: string[], send: (e: WatchEvent) => void): () => void {
  const sub: Sub = { keys: new Set(keys), send }
  hub.subs.add(sub)
  for (const k of sub.keys) acquire(k)
  return () => {
    hub.subs.delete(sub)
    for (const k of sub.keys) release(k)
  }
}

// 監視できなかった worktree (購読の直後に知らせる)
export function watchErrors(keys: string[]) {
  return keys.map((k) => hub.watches.get(k)).filter((w): w is Watch => !!w?.error)
}

function acquire(key: string) {
  const i = key.indexOf("/")
  if (i < 0) return
  let w = hub.watches.get(key)
  if (!w) {
    w = { key, projectId: key.slice(0, i), worktreeId: key.slice(i + 1), refs: 0, watchers: [], paths: new Set(), structure: false, git: false, worktrees: false }
    hub.watches.set(key, w)
    void start(w)
  }
  w.refs++
  if (w.stopTimer) clearTimeout(w.stopTimer)
  w.stopTimer = undefined
}

function release(key: string) {
  const w = hub.watches.get(key)
  if (!w) return
  w.refs--
  if (w.refs > 0) return
  w.stopTimer = setTimeout(() => stop(w), STOP_AFTER)
}

function stop(w: Watch) {
  if (w.refs > 0) return
  hub.watches.delete(w.key)
  for (const x of w.watchers) void x.close()
}

// プロジェクトの登録の解除や、設定の変更 (除外パターン) のときに監視を組み直す
export function restartProject(projectId: string) {
  for (const w of hub.watches.values()) {
    if (w.projectId !== projectId) continue
    for (const x of w.watchers) void x.close()
    w.watchers = []
    w.error = undefined
    void start(w)
  }
}

export function restartAll() {
  for (const id of new Set([...hub.watches.values()].map((w) => w.projectId))) restartProject(id)
}

function schedule(w: Watch) {
  if (w.flushTimer) return
  w.flushTimer = setTimeout(() => {
    w.flushTimer = undefined
    if (w.paths.size) broadcast({ type: "files", projectId: w.projectId, worktreeId: w.worktreeId, paths: [...w.paths], structure: w.structure })
    if (w.git) broadcast({ type: "git", projectId: w.projectId, worktreeId: w.worktreeId })
    if (w.worktrees) broadcast({ type: "worktrees", projectId: w.projectId })
    w.paths.clear()
    w.structure = w.git = w.worktrees = false
  }, DEBOUNCE)
}

function fail(w: Watch, e: unknown) {
  const code = (e as NodeJS.ErrnoException).code
  w.error = code === "ENOSPC" ? "inotify の上限に達したため、自動更新できません" : `自動更新できません: ${(e as Error).message}`
  broadcast({ type: "watch-error", projectId: w.projectId, worktreeId: w.worktreeId, message: w.error })
}

async function start(w: Watch) {
  try {
    const ctx = await getCtx(w.projectId, w.worktreeId)
    const root = ctx.root
    // .gitignore で無視されたディレクトリは監視しない。ただし SPEC の場所は監視する (AI の作業ファイルは無視されていることが多い)
    const ignoredDirs = (await ignoredEntries(ctx)).filter((e) => e.type === "dir").map((e) => e.path)
    const allowed = parseSpecPaths(specPathsOf(w.projectId).get(w.worktreeId) ?? "").map(specBaseDir)
    const ignored = (abs: string) => {
      const rel = path.relative(root, abs)
      if (!rel) return false
      if (rel.startsWith("..") || rel === ".git" || rel.startsWith(".git/")) return true
      if (matchesAny(rel, ctx.excludes)) return true
      if (!ignoredDirs.some((d) => rel === d || rel.startsWith(d + "/"))) return false
      return !allowed.some((a) => a === "" || rel === a || rel.startsWith(a + "/") || a.startsWith(rel + "/"))
    }
    const files = chokidar.watch(root, { ignored, ignoreInitial: true, followSymlinks: false })
    files.on("all", (ev, abs) => {
      const rel = path.relative(root, abs)
      if (!rel) return
      w.paths.add(rel)
      if (ev !== "change" || path.basename(rel) === ".gitignore") w.structure = true
      schedule(w)
    })
    files.on("error", (e) => fail(w, e))
    const common = path.join(ctx.project.path, ".git")
    const gitFiles = chokidar.watch([path.join(ctx.gitDir, "HEAD"), path.join(ctx.gitDir, "index"), path.join(common, "refs"), path.join(common, "packed-refs")], {
      ignoreInitial: true,
    })
    gitFiles.on("all", () => {
      w.git = true
      schedule(w)
    })
    gitFiles.on("error", (e) => fail(w, e))
    // worktree の追加・削除
    const admin = chokidar.watch(path.join(common, "worktrees"), { ignoreInitial: true, depth: 0 })
    admin.on("addDir", () => ((w.worktrees = true), schedule(w)))
    admin.on("unlinkDir", () => ((w.worktrees = true), schedule(w)))
    w.watchers = [files, gitFiles, admin]
    if (!hub.watches.has(w.key)) for (const x of w.watchers) void x.close()
  } catch (e) {
    fail(w, e)
  }
}

// すべての監視を止める (テストの後始末)
export async function stopAll() {
  for (const w of hub.watches.values()) {
    if (w.stopTimer) clearTimeout(w.stopTimer)
    if (w.flushTimer) clearTimeout(w.flushTimer)
    await Promise.all(w.watchers.map((x) => x.close()))
  }
  hub.watches.clear()
  hub.subs.clear()
}
