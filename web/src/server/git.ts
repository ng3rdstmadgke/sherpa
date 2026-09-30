import { lstat, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { matchesAny } from "@/lib/glob"
import { AUTO_COMPARE_BRANCHES, MAX_FILE_HISTORY, type Branch, type Change, type Commit, type CompareResult, type DiffLine, type DiffResult, type FileHistory } from "@/lib/types"
import { ApiError } from "./errors"
import { git, gitText, type GitCtx } from "./exec"
import { LOG_FORMAT, parseFileLog, parseForEachRef, parseLog, parseRawNumstat, parseUnifiedDiff } from "./git-parse"
import type { WtCtx } from "./projects"

// 機能ごとの git のコマンド (docs/architecture/git.md)

const DIFF_OPTS = ["--no-ext-diff", "--no-textconv", "--no-color"]
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i
const HEX = /^[0-9a-f]{4,64}$/

export const literal = (p: string) => `:(literal)${p}`

// ---------------------------------------------------------------------------
// ブランチ・HEAD
// ---------------------------------------------------------------------------

export async function listBranches(ctx: GitCtx): Promise<Branch[]> {
  const out = await gitText(ctx, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(symref)",
    "refs/heads",
    "refs/remotes",
  ])
  return parseForEachRef(out)
}

// ローカルの main → master → develop。なければリモートの同じ名前 (origin を優先し、あとは名前の順)
export function autoCompareBranch(branches: Branch[]): string | null {
  for (const name of AUTO_COMPARE_BRANCHES) if (branches.some((b) => !b.remote && b.name === name)) return name
  for (const name of AUTO_COMPARE_BRANCHES) {
    const remotes = branches
      .filter((b) => b.remote && b.name.split("/").slice(1).join("/") === name)
      .map((b) => b.name)
      .sort((a, b) => (a.startsWith("origin/") ? -1 : b.startsWith("origin/") ? 1 : a.localeCompare(b)))
    if (remotes.length) return remotes[0]
  }
  return null
}

// ブランチの名前を完全な ref にする。一覧にない名前は受け付けない (オプションやファイルと取り違えないように)
export async function resolveBranch(ctx: GitCtx, name: string): Promise<string> {
  const b = (await listBranches(ctx)).find((x) => x.name === name)
  if (!b) throw new ApiError("BRANCH_NOT_FOUND", `${name} が見つかりません`, 404)
  return b.ref
}

export async function revParse(ctx: GitCtx, rev: string): Promise<string | null> {
  const r = await git(ctx, ["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`], { ok: [0, 1, 128] })
  return r.code === 0 ? r.stdout.toString("utf8").trim() : null
}

const emptyTrees = new Map<string, string>()

// コミットがないときに比べる空のツリー
export async function emptyTree(ctx: GitCtx): Promise<string> {
  const key = ctx.gitDir
  if (!emptyTrees.has(key)) emptyTrees.set(key, (await gitText(ctx, ["hash-object", "-t", "tree", "--stdin"], { input: "" })).trim())
  return emptyTrees.get(key)!
}

export async function headOrEmpty(ctx: GitCtx): Promise<string> {
  return (await revParse(ctx, "HEAD")) ?? (await emptyTree(ctx))
}

export async function lastCommit(ctx: GitCtx): Promise<{ hash: string; message: string; date: string } | null> {
  const r = await git(ctx, ["log", "-1", "--format=%H%x1f%s%x1f%aI", "HEAD", "--"], { ok: [0, 128] })
  if (r.code !== 0) return null
  const [hash, message, date] = r.stdout.toString("utf8").trim().split("\x1f")
  return hash ? { hash, message, date } : null
}

export async function aheadBehind(ctx: GitCtx, ref: string): Promise<{ ahead: number; behind: number }> {
  const r = await git(ctx, ["rev-list", "--left-right", "--count", `${ref}...HEAD`, "--"], { ok: [0, 128] })
  if (r.code !== 0) return { ahead: 0, behind: 0 }
  const [behind, ahead] = r.stdout.toString("utf8").trim().split(/\s+/).map(Number)
  return { ahead: ahead || 0, behind: behind || 0 }
}

async function mergeBase(ctx: GitCtx, ref: string): Promise<string | null> {
  const r = await git(ctx, ["merge-base", ref, "HEAD"], { ok: [0, 1, 128] })
  return r.code === 0 ? r.stdout.toString("utf8").trim() : null
}

// ---------------------------------------------------------------------------
// 変更ファイル
// ---------------------------------------------------------------------------

async function diffSummary(ctx: GitCtx, from: string, to: string | null): Promise<Change[]> {
  const out = await gitText(ctx, ["diff", ...DIFF_OPTS, "--raw", "--numstat", "-z", "-M", from, ...(to ? [to] : []), "--"])
  return parseRawNumstat(out)
}

function countLines(buf: Buffer) {
  if (!buf.length) return 0
  let n = 0
  for (const b of buf) if (b === 10) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

// Untracked のファイル。除外パターンと、worktree の中の別の worktree は除く
export async function untracked(ctx: WtCtx): Promise<Change[]> {
  const out = await gitText(ctx, ["ls-files", "--others", "--exclude-standard", "-z"])
  const paths = out.split("\0").filter((p) => p && !p.endsWith("/") && !matchesAny(p, ctx.excludes))
  return Promise.all(
    paths.map(async (p): Promise<Change> => {
      // シンボリックリンクはたどらない (worktree の外を読まないように)。git と同じく、リンク先の文字列の 1 行として数える
      const st = await lstat(path.join(ctx.root, p)).catch(() => null)
      if (st?.isSymbolicLink()) return { path: p, status: "U", additions: 1, deletions: 0 }
      const buf = await readFile(path.join(ctx.root, p)).catch(() => Buffer.alloc(0))
      const binary = buf.subarray(0, 8000).includes(0)
      return { path: p, status: "U", additions: binary ? 0 : countLines(buf), deletions: 0, binary: binary || undefined }
    }),
  )
}

const byPath = (a: Change, b: Change) => a.path.localeCompare(b.path)

// 未コミットの差分 (HEAD...作業ツリー)。Staged と Unstaged をまとめ、Untracked を含む
export async function changes(ctx: WtCtx): Promise<Change[]> {
  const [tracked, others] = await Promise.all([diffSummary(ctx, await headOrEmpty(ctx), null), untracked(ctx)])
  return [...tracked, ...others].sort(byPath)
}

// COMPARE: マージベースとの比較と、HISTORY (<ref>..HEAD) と ahead / behind
export async function compare(ctx: WtCtx, branch: string, includeUncommitted: boolean): Promise<CompareResult> {
  const ref = await resolveBranch(ctx, branch)
  const [mb, ab] = await Promise.all([mergeBase(ctx, ref), aheadBehind(ctx, ref)])
  const base: CompareResult = { branch, ref, mergeBase: mb, ahead: ab.ahead, behind: ab.behind, commits: [], moreCommits: 0, files: [] }
  if (!mb) return base
  const [files, commits] = await Promise.all([
    includeUncommitted
      ? Promise.all([diffSummary(ctx, mb, null), untracked(ctx)]).then(([a, b]) => [...a, ...b].sort(byPath))
      : diffSummary(ctx, mb, "HEAD").then((a) => a.sort(byPath)),
    history(ctx, ref),
  ])
  return { ...base, files, commits, moreCommits: Math.max(0, ab.ahead - commits.length) }
}

export async function history(ctx: GitCtx, ref: string, max = 500): Promise<Commit[]> {
  const out = await gitText(ctx, ["log", `--format=${LOG_FORMAT}`, "--shortstat", "--diff-merges=first-parent", `--max-count=${max}`, `${ref}..HEAD`, "--"])
  return parseLog(out)
}

function checkHash(hash: string) {
  if (!HEX.test(hash)) throw new ApiError("INVALID_REQUEST", "コミットのハッシュが正しくありません")
}

export async function commitDetail(ctx: GitCtx, hash: string): Promise<Commit> {
  checkHash(hash)
  const full = await revParse(ctx, hash)
  if (!full) throw new ApiError("NOT_FOUND", "コミットが見つかりません", 404)
  const [c] = parseLog(await gitText(ctx, ["log", "-1", `--format=${LOG_FORMAT}`, "--shortstat", "--diff-merges=first-parent", full, "--"]))
  const parent = c.parents[0] ?? (await emptyTree(ctx))
  const files = (await diffSummary(ctx, parent, full)).sort(byPath)
  return { ...c, files, fileCount: files.length }
}

// 1 ファイルの履歴 (HEAD から。名前の変更もたどる)。max 件を超えたら truncated
export async function fileHistory(ctx: GitCtx, p: string, max = 200): Promise<FileHistory> {
  const n = Math.min(Math.max(1, Math.floor(max) || 1), MAX_FILE_HISTORY)
  // マージコミットは出さない (--follow は差分でファイルを追うので、マージにも差分を出すと、取り込んだブランチの変更がマージにも重なって出る)
  const args = ["log", ...DIFF_OPTS, "--follow", "-M", `--format=${LOG_FORMAT}`, "--raw", "--numstat", "-z"]
  // コミットがまだない (HEAD がない) ときは 128
  const r = await git(ctx, [...args, `--max-count=${n + 1}`, "HEAD", "--", literal(p)], { ok: [0, 128] })
  if (r.code !== 0) return { commits: [], truncated: false }
  const commits = parseFileLog(r.stdout.toString("utf8"))
  return { commits: commits.slice(0, n), truncated: commits.length > n }
}

// ---------------------------------------------------------------------------
// 1 ファイルの差分
// ---------------------------------------------------------------------------

type Sides = { from: string; to: string | null }

async function resolveSides(ctx: WtCtx, base: string): Promise<Sides> {
  if (base === "uncommitted") return { from: await headOrEmpty(ctx), to: null }
  const m = /^(branch|branch-wt|commit):(.+)$/.exec(base)
  if (!m) throw new ApiError("INVALID_REQUEST", "比較元が正しくありません")
  if (m[1] === "commit") {
    checkHash(m[2])
    const full = await revParse(ctx, m[2])
    if (!full) throw new ApiError("NOT_FOUND", "コミットが見つかりません", 404)
    const parents = (await gitText(ctx, ["rev-list", "--parents", "-n", "1", full, "--"])).trim().split(" ").slice(1)
    return { from: parents[0] ?? (await emptyTree(ctx)), to: full }
  }
  const ref = await resolveBranch(ctx, m[2])
  const mb = await mergeBase(ctx, ref)
  if (!mb) throw new ApiError("GIT_FAILED", `${m[2]} と共通の祖先がありません`, 409)
  return { from: mb, to: m[1] === "branch" ? await revParse(ctx, "HEAD") : null }
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024

function stats(lines: DiffLine[]) {
  return { additions: lines.filter((l) => l.type === "add").length, deletions: lines.filter((l) => l.type === "del").length }
}

function textLines(text: string, type: "add" | "ctx"): DiffLine[] {
  const src = text.replace(/\n$/, "")
  if (!text) return []
  return src.split("\n").map((t, i) => (type === "add" ? { type, text: t, newNo: i + 1 } : { type, text: t, oldNo: i + 1, newNo: i + 1 }))
}

export async function fileDiff(ctx: WtCtx, p: string, oldPath: string | null, base: string): Promise<DiffResult> {
  const { from, to } = await resolveSides(ctx, base)
  const paths = [literal(p), ...(oldPath && oldPath !== p ? [literal(oldPath)] : [])]
  const args = (u: string) => ["diff", ...DIFF_OPTS, "-M", u, from, ...(to ? [to] : []), "--", ...paths]
  let r = await git(ctx, args("-U100000"), { maxBytes: MAX_DIFF_BYTES })
  let partial = false
  if (r.truncated) {
    r = await git(ctx, args("-U3"), { maxBytes: MAX_DIFF_BYTES })
    partial = true
  }
  const out = r.stdout.toString("utf8")
  const parsed = parseUnifiedDiff(out)
  if (parsed.binary) {
    if (!IMAGE_EXT.test(p)) return { kind: "binary" }
    const added = /\nnew file mode /.test(out)
    const deleted = /\ndeleted file mode /.test(out)
    return { kind: "image", before: added ? null : { rev: from, path: oldPath ?? p }, after: deleted ? null : { rev: to, path: p } }
  }
  if (parsed.lines.length) return { kind: "text", lines: parsed.lines, ...stats(parsed.lines), partial: partial || undefined }

  // 差分がない (名前の変更だけのときも、内容の差分は空): Untracked ならすべて追加の行、そうでなければファイル全体を変更のない行として返す
  const abs = path.join(ctx.root, p)
  if (!to) {
    const tracked = (await gitText(ctx, ["ls-files", "-z", "--", literal(p)])).length > 0
    const st = await stat(abs).catch(() => null)
    if (st?.isFile()) {
      const buf = await readFile(abs)
      if (buf.subarray(0, 8000).includes(0)) return IMAGE_EXT.test(p) ? { kind: "image", before: null, after: { rev: null, path: p } } : { kind: "binary" }
      const lines = textLines(buf.toString("utf8"), tracked ? "ctx" : "add")
      return { kind: "text", lines, ...stats(lines) }
    }
    return { kind: "text", lines: [], additions: 0, deletions: 0 }
  }
  const blob = await git(ctx, ["cat-file", "blob", `${to}:${p}`], { ok: [0, 128] })
  const lines = blob.code === 0 ? textLines(blob.stdout.toString("utf8"), "ctx") : []
  return { kind: "text", lines, ...stats(lines) }
}

// rev のファイルの中身 (画像の差分など)
export async function catBlob(ctx: GitCtx, rev: string, p: string): Promise<Buffer> {
  checkHash(rev)
  const r = await git(ctx, ["cat-file", "blob", `${rev}:${p}`], { ok: [0, 128], maxBytes: 50 * 1024 * 1024 })
  if (r.code !== 0) throw new ApiError("NOT_FOUND", "ファイルが見つかりません", 404)
  return r.stdout
}
