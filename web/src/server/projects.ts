import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { asc, eq } from "drizzle-orm"
import { normalizeDisplay, normalizeFontSize, type DisplaySettings } from "@/lib/display"
import { DEFAULT_EXCLUDES } from "@/lib/excludes"
import type { DetectResult, PathMapping, Project, ProjectInput, Worktree } from "@/lib/types"
import { getDb, schema } from "./db"
import { ApiError, notFound } from "./errors"
import { expandHome, home, isInside } from "./paths"
import { detectMappings, discoverWorktrees, parseGitFile, type WorktreeInfo } from "./worktrees"
import type { GitCtx } from "./exec"

// 登録したプロジェクトと、worktree を対象にする処理の文脈 (WtCtx)

export type ProjectRow = {
  id: string
  path: string
  name: string
  color: string
  excludes: string[]
  defaultCompareBranch: string | null
  pathMappings: PathMapping[]
}

// worktree を対象にする処理に渡す文脈
export type WtCtx = GitCtx & {
  project: ProjectRow
  worktree: WorktreeInfo
  worktrees: WorktreeInfo[]
  root: string // = workTree
  // 除外パターン (全体 + プロジェクト + この worktree の中にある別の worktree)
  excludes: string[]
  // この worktree の中にある別の worktree (相対パス)
  nested: string[]
}

const COLORS = ["bg-sky-500", "bg-emerald-500", "bg-orange-500", "bg-violet-500", "bg-rose-500", "bg-amber-500", "bg-teal-500", "bg-indigo-500"]

export function globalExcludes(): string[] {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "excludes")).get()
  return (row?.value as string[] | undefined) ?? DEFAULT_EXCLUDES
}

export function setGlobalExcludes(excludes: string[]) {
  getDb()
    .insert(schema.settings)
    .values({ key: "excludes", value: excludes })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: excludes } })
    .run()
}

// 表示の設定 (フォントサイズ)。行がなければ既定値
export function displaySettings(): DisplaySettings {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "display")).get()
  return normalizeDisplay(row?.value as Partial<DisplaySettings> | undefined)
}

export function setDisplaySettings(input: Partial<DisplaySettings>) {
  // 送られなかった項目と、正しくない値は、今の値のまま
  const cur = displaySettings()
  const value: DisplaySettings = {
    codeFontSize: normalizeFontSize(input.codeFontSize, cur.codeFontSize),
    markdownFontSize: normalizeFontSize(input.markdownFontSize, cur.markdownFontSize),
  }
  getDb()
    .insert(schema.settings)
    .values({ key: "display", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
}

export function listProjectRows(): ProjectRow[] {
  const db = getDb()
  const rows = db.select().from(schema.projects).orderBy(asc(schema.projects.sortOrder)).all()
  const maps = db.select().from(schema.pathMappings).orderBy(asc(schema.pathMappings.id)).all()
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    name: r.name,
    color: r.color,
    excludes: r.excludes,
    defaultCompareBranch: r.defaultCompareBranch,
    pathMappings: maps.filter((m) => m.projectId === r.id).map((m) => ({ container: m.container, host: m.host })),
  }))
}

export function getProjectRow(id: string): ProjectRow {
  const row = listProjectRows().find((p) => p.id === id)
  if (!row) throw new ApiError("PROJECT_NOT_FOUND", "プロジェクトが見つかりません", 404)
  return row
}

export function specPathsOf(projectId: string): Map<string, string> {
  const rows = getDb().select().from(schema.worktreeSettings).where(eq(schema.worktreeSettings.projectId, projectId)).all()
  return new Map(rows.map((r) => [r.worktreeId, r.specPaths]))
}

export function setSpecPaths(projectId: string, worktreeId: string, input: string) {
  getDb()
    .insert(schema.worktreeSettings)
    .values({ projectId, worktreeId, specPaths: input })
    .onConflictDoUpdate({ target: [schema.worktreeSettings.projectId, schema.worktreeSettings.worktreeId], set: { specPaths: input } })
    .run()
}

// DB を使わずに文脈を作る (確認スクリプトとテスト用)
export async function makeCtx(project: ProjectRow, worktreeId: string, global: string[] = DEFAULT_EXCLUDES): Promise<WtCtx> {
  const worktrees = await discoverWorktrees(project.path, project.pathMappings)
  const worktree = worktrees.find((w) => w.id === worktreeId)
  if (!worktree) throw notFound("worktree が見つかりません")
  if (worktree.missing) throw new ApiError("WORKTREE_MISSING", "worktree が見つかりません", 404)
  const nested = worktrees.filter((w) => w !== worktree && w.hostPath !== worktree.hostPath && isInside(worktree.hostPath, w.hostPath)).map((w) => path.relative(worktree.hostPath, w.hostPath))
  return {
    project,
    worktree,
    worktrees,
    root: worktree.hostPath,
    gitDir: worktree.gitDir,
    workTree: worktree.hostPath,
    excludes: [...global, ...project.excludes, ...nested.flatMap((n) => [n, `${n}/**`])],
    nested,
  }
}

export async function getCtx(projectId: string, worktreeId: string): Promise<WtCtx> {
  return makeCtx(getProjectRow(projectId), worktreeId, globalExcludes())
}

// ---------------------------------------------------------------------------
// 一覧 (worktree の状態を含む)
// ---------------------------------------------------------------------------

export async function readBranch(gitDir: string): Promise<string | null> {
  const head = await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")
  const m = /^ref: refs\/heads\/(.+)$/m.exec(head.trim())
  return m ? m[1] : null
}

export async function buildProject(row: ProjectRow, global: string[], specs: Map<string, string>): Promise<Project> {
  const git = await import("./git")
  const exists = await stat(path.join(row.path, ".git")).then(
    (s) => s.isDirectory(),
    () => false,
  )
  const base: Project = { ...row, autoCompareBranch: null, missing: !exists, worktrees: [] }
  if (!exists) return base
  const infos = await discoverWorktrees(row.path, row.pathMappings)
  const mainCtx = await makeCtx(row, "main", global)
  let branches: Awaited<ReturnType<typeof git.listBranches>> = []
  try {
    branches = await git.listBranches(mainCtx)
  } catch (e) {
    return { ...base, error: (e as Error).message }
  }
  const auto = git.autoCompareBranch(branches)
  const compareName = row.defaultCompareBranch && branches.some((b) => b.name === row.defaultCompareBranch) ? row.defaultCompareBranch : auto
  const compareRef = branches.find((b) => b.name === compareName)?.ref ?? null
  const worktrees = await Promise.all(
    infos.map(async (w): Promise<Worktree> => {
      const common = { id: w.id, name: w.isMain ? row.name : w.name, hostPath: w.hostPath, containerPath: w.containerPath, relPath: w.relPath, isMain: w.isMain, specPaths: specs.get(w.id) ?? "" }
      const empty = { branch: null, head: "", ahead: 0, behind: 0, changes: 0, lastCommit: null }
      if (w.missing) return { ...common, ...empty, missing: true }
      try {
        const ctx = w.isMain ? mainCtx : await makeCtx(row, w.id, global)
        const [branch, last, ab, changes] = await Promise.all([
          readBranch(w.gitDir),
          git.lastCommit(ctx),
          compareRef ? git.aheadBehind(ctx, compareRef) : Promise.resolve({ ahead: 0, behind: 0 }),
          git.changes(ctx),
        ])
        return { ...common, missing: false, branch, head: last?.hash.slice(0, 7) ?? "", ahead: ab.ahead, behind: ab.behind, changes: changes.length, lastCommit: last }
      } catch {
        return { ...common, ...empty, missing: false }
      }
    }),
  )
  return { ...base, autoCompareBranch: auto, worktrees }
}

export async function listProjects(): Promise<Project[]> {
  const global = globalExcludes()
  return Promise.all(listProjectRows().map((r) => buildProject(r, global, specPathsOf(r.id))))
}

// ---------------------------------------------------------------------------
// 登録・編集・登録の解除
// ---------------------------------------------------------------------------

export function normalizeDir(p: string) {
  const abs = path.resolve(expandHome(p.trim()))
  return abs.length > 1 ? abs.replace(/\/+$/, "") : abs
}

async function gitKind(dir: string): Promise<"repo" | "linked" | "none"> {
  const st = await stat(path.join(dir, ".git")).catch(() => null)
  if (!st) return "none"
  if (st.isDirectory()) return (await stat(path.join(dir, ".git", "HEAD")).catch(() => null)) ? "repo" : "none"
  return parseGitFile(await readFile(path.join(dir, ".git"), "utf8").catch(() => "")) ? "linked" : "none"
}

export async function detect(input: string): Promise<DetectResult> {
  const dir = normalizeDir(input)
  if (!isInside(home(), dir)) throw new ApiError("OUTSIDE", "ホームの下のディレクトリを指定してください", 403)
  const exists = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  )
  const kind = exists ? await gitKind(dir) : "none"
  const registered = listProjectRows().some((p) => p.path === dir)
  const result: DetectResult = {
    path: dir,
    exists,
    isGitRepo: kind === "repo",
    isLinkedWorktree: kind === "linked",
    registered,
    name: path.basename(dir),
    pathMappings: [],
    branches: [],
    autoCompareBranch: null,
  }
  if (kind !== "repo") return result
  const git = await import("./git")
  result.pathMappings = await detectMappings(dir)
  const ctx: GitCtx = { gitDir: path.join(dir, ".git"), workTree: dir }
  result.branches = await git.listBranches(ctx).catch(() => [])
  result.autoCompareBranch = git.autoCompareBranch(result.branches)
  return result
}

function slug(name: string, taken: Set<string>) {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  let s = base
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`
  return s
}

function cleanMappings(m: PathMapping[]) {
  return m.map((x) => ({ container: x.container.trim().replace(/\/+$/, ""), host: normalizeDir(x.host) })).filter((x) => x.container && x.host)
}

export async function createProject(input: ProjectInput): Promise<ProjectRow> {
  if (!input.path) throw new ApiError("INVALID_REQUEST", "ディレクトリを指定してください")
  const d = await detect(input.path)
  if (!d.exists) throw notFound("ディレクトリが見つかりません")
  if (d.isLinkedWorktree) throw new ApiError("LINKED_WORKTREE", "main worktree のディレクトリを登録してください")
  if (!d.isGitRepo) throw new ApiError("NOT_GIT_REPO", "git リポジトリではありません")
  if (d.registered) throw new ApiError("ALREADY_REGISTERED", "登録済みです", 409)
  const db = getDb()
  const rows = listProjectRows()
  const id = slug(path.basename(d.path), new Set(rows.map((r) => r.id)))
  const maxOrder = rows.length ? Math.max(...db.select({ o: schema.projects.sortOrder }).from(schema.projects).all().map((r) => r.o)) : 0
  const now = Date.now()
  db.transaction((tx) => {
    tx.insert(schema.projects)
      .values({
        id,
        path: d.path,
        name: input.name.trim() || d.name,
        color: COLORS[rows.length % COLORS.length],
        excludes: input.excludes,
        defaultCompareBranch: input.defaultCompareBranch || null,
        sortOrder: maxOrder + 1,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const m of cleanMappings(input.pathMappings)) tx.insert(schema.pathMappings).values({ projectId: id, ...m }).run()
  })
  return getProjectRow(id)
}

export function updateProject(id: string, input: ProjectInput): ProjectRow {
  const row = getProjectRow(id)
  const db = getDb()
  db.transaction((tx) => {
    tx.update(schema.projects)
      .set({ name: input.name.trim() || row.name, excludes: input.excludes, defaultCompareBranch: input.defaultCompareBranch || null, updatedAt: Date.now() })
      .where(eq(schema.projects.id, id))
      .run()
    tx.delete(schema.pathMappings).where(eq(schema.pathMappings.projectId, id)).run()
    for (const m of cleanMappings(input.pathMappings)) tx.insert(schema.pathMappings).values({ projectId: id, ...m }).run()
  })
  return getProjectRow(id)
}

export function deleteProject(id: string) {
  getProjectRow(id)
  getDb().delete(schema.projects).where(eq(schema.projects.id, id)).run()
}

// ---------------------------------------------------------------------------
// ホームの下のディレクトリのサジェスト (名前だけを返す)
// ---------------------------------------------------------------------------

export async function listHomeDirs(dirInput: string) {
  if (dirInput === "") return [{ name: "~", kind: "dir" as const }]
  const dir = normalizeDir(dirInput || "~/")
  if (!isInside(home(), dir)) return []
  const { realpath } = await import("node:fs/promises")
  const real = await realpath(dir).catch(() => null)
  if (!real || !isInside(await realpath(home()), real)) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const registered = new Set(listProjectRows().map((p) => p.path))
  const out: { name: string; kind: "dir"; badges?: string[] }[] = []
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    const badges: string[] = []
    if ((await gitKind(full)) !== "none") badges.push("git")
    if (registered.has(full)) badges.push("登録済み")
    out.push({ name: e.name, kind: "dir", badges: badges.length ? badges : undefined })
    if (out.length >= 2000) break
  }
  return out
}
