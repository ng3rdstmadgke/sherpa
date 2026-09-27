// 実際のリポジトリ (引数で渡す) に対する読み取り専用の確認 (docs/implementation-plan.md §10.3)。
// DB には登録せず、メモリ上のプロジェクトとしてサーバーの関数を呼び、git を直接実行した結果と比べる。
// git は必ず server/exec.ts の git() (GIT_OPTIONAL_LOCKS=0、GIT_DIR / GIT_WORK_TREE を明示) から実行する。
// 実行の前後で .git の index / HEAD / refs などの mtime と大きさを比べ、何も書き換えていないことを確かめる。
// 使い方: cd web && npx tsx scripts/check-real-repos.mts ~/repo-a ~/repo-b='archives/**'

import { readdir, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_EXCLUDES } from "@/lib/excludes"
import { matchesAny } from "@/lib/glob"
import type { FileNode } from "@/lib/types"
import { gitText } from "@/server/exec"
import { listTree, readContent } from "@/server/files"
import { autoCompareBranch, changes, commitDetail, compare, fileDiff, listBranches } from "@/server/git"
import { makeCtx, type ProjectRow, type WtCtx } from "@/server/projects"
import { searchContent, searchNames } from "@/server/search"
import { detectMappings, discoverWorktrees, parseGitFile } from "@/server/worktrees"

const HOME = os.homedir()
// 確認するリポジトリは引数で渡す。<path> か <path>=<除外パターン>,<除外パターン>
const REPOS: { name: string; root: string; excludes: string[] }[] = process.argv.slice(2).map((arg) => {
  const [p, ex = ""] = arg.split("=")
  const root = path.resolve(p.replace(/^~(?=\/|$)/, HOME))
  return { name: path.basename(root), root, excludes: ex.split(",").filter(Boolean) }
})
if (!REPOS.length) {
  console.error("使い方: npx tsx scripts/check-real-repos.mts <repo> [<repo>=<除外パターン>,…]")
  process.exit(2)
}

type Result = { repo: string; worktree: string; item: string; ok: boolean; detail: string; ms: number }
const results: Result[] = []

async function check(repo: string, worktree: string, item: string, fn: () => Promise<string | void>, limitMs?: number) {
  const t0 = Date.now()
  let ok = true
  let detail = ""
  try {
    detail = (await fn()) ?? ""
  } catch (e) {
    ok = false
    detail = (e as Error).message
  }
  const ms = Date.now() - t0
  if (ok && limitMs && ms > limitMs) {
    ok = false
    detail = `遅い (${ms} ms > ${limitMs} ms) ${detail}`
  }
  results.push({ repo, worktree, item, ok, detail, ms })
  console.log(`${ok ? "OK" : "NG"}  ${repo.padEnd(12)} ${worktree.padEnd(28)} ${item.padEnd(12)} ${String(ms).padStart(5)} ms  ${detail}`)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------------------
// 読み取り専用の確認: .git の中のファイルの mtime と大きさ
// ---------------------------------------------------------------------------

async function walkFiles(dir: string, out: Map<string, string>, depth = 20) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) await walkFiles(p, out, depth - 1)
    } else {
      const st = await stat(p).catch(() => null)
      if (st) out.set(p, `${st.mtimeMs}:${st.size}`)
    }
  }
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const git = path.join(root, ".git")
  const out = new Map<string, string>()
  for (const f of ["index", "HEAD", "packed-refs", "config", "FETCH_HEAD", "ORIG_HEAD"]) {
    const st = await stat(path.join(git, f)).catch(() => null)
    out.set(path.join(git, f), st ? `${st.mtimeMs}:${st.size}` : "none")
  }
  await walkFiles(path.join(git, "refs"), out)
  // .git/worktrees/*/ の直下のファイル (HEAD / index / gitdir / commondir など)
  const ids = await readdir(path.join(git, "worktrees")).catch(() => [] as string[])
  out.set(path.join(git, "worktrees"), ids.sort().join(","))
  for (const id of ids) await walkFiles(path.join(git, "worktrees", id), out, 0)
  return out
}

function diffSnapshots(a: Map<string, string>, b: Map<string, string>) {
  const changed: string[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) changed.push(k)
  return changed
}

// ---------------------------------------------------------------------------
// git を直接実行した結果
// ---------------------------------------------------------------------------

type Stat = { add: number; del: number; binary: boolean }

// git diff --numstat -z -M の出力を パス → 行数 にする
function parseNumstat(out: string): Map<string, Stat> {
  const t = out.split("\0")
  const m = new Map<string, Stat>()
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue
    const [a, d, p] = t[i].split("\t")
    let file = p
    if (p === "") {
      file = t[i + 2]
      i += 2
    }
    m.set(file, { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" })
  }
  return m
}

async function directUntracked(ctx: WtCtx) {
  const out = await gitText(ctx, ["ls-files", "--others", "--exclude-standard", "-z"])
  return out.split("\0").filter((p) => p && !p.endsWith("/") && !matchesAny(p, ctx.excludes))
}

function compareStats(label: string, got: { path: string; additions: number; deletions: number; binary?: boolean }[], want: Map<string, Stat>) {
  const gotPaths = got.map((c) => c.path).sort()
  const wantPaths = [...want.keys()].sort()
  const missing = wantPaths.filter((p) => !gotPaths.includes(p))
  const extra = gotPaths.filter((p) => !want.has(p))
  assert(!missing.length && !extra.length, `${label}: パスが違う (足りない ${missing.slice(0, 3).join(", ")} / 余分 ${extra.slice(0, 3).join(", ")})`)
  for (const c of got) {
    const w = want.get(c.path)!
    if (w.binary || c.binary) continue
    assert(c.additions === w.add && c.deletions === w.del, `${label}: ${c.path} の行数が違う (+${c.additions} -${c.deletions} / git +${w.add} -${w.del})`)
  }
}

function flattenTree(nodes: FileNode[], out: FileNode[] = []) {
  for (const n of nodes) {
    out.push(n)
    if (n.children) flattenTree(n.children, out)
  }
  return out
}

async function lineCountStat(ctx: WtCtx, p: string): Promise<Stat> {
  const buf = await readFile(path.join(ctx.root, p)).catch(() => Buffer.alloc(0))
  if (buf.subarray(0, 8000).includes(0)) return { add: 0, del: 0, binary: true }
  let n = 0
  for (const b of buf) if (b === 10) n++
  if (buf.length && buf[buf.length - 1] !== 10) n++
  return { add: n, del: 0, binary: false }
}

// ---------------------------------------------------------------------------
// worktree ごとの確認
// ---------------------------------------------------------------------------

async function checkWorktree(repo: string, ctx: WtCtx, compareBranch: string | null) {
  const wt = ctx.worktree.id

  await check(
    repo,
    wt,
    "tree",
    async () => {
      const [plain, ignored] = await Promise.all([listTree(ctx, false), listTree(ctx, true)])
      const files = flattenTree(plain.nodes).filter((n) => n.type === "file")
      const all = flattenTree(ignored.nodes)
      assert(files.length > 0, "ファイルがない")
      for (const n of [...flattenTree(plain.nodes), ...all]) {
        assert(!matchesAny(n.path, ctx.excludes), `除外パターンのパスが出ている: ${n.path}`)
        assert(!/(^|\/)(node_modules|\.terraform|\.git)(\/|$)/.test(n.path), `node_modules などが出ている: ${n.path}`)
        for (const nested of ctx.nested) assert(n.path !== nested && !n.path.startsWith(nested + "/"), `別の worktree が出ている: ${n.path}`)
      }
      const direct = (await gitText(ctx, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]))
        .split("\0")
        .filter((p) => p && !p.endsWith("/") && !matchesAny(p, ctx.excludes))
      assert(files.length === direct.length, `ファイルの数が違う (${files.length} / git ${direct.length})`)
      const allFiles = all.filter((n) => n.type === "file").length
      const lazy = all.filter((n) => n.lazy).length
      assert(allFiles >= files.length, "gitignore ON のファイルが OFF より少ない")
      return `OFF ${files.length} ファイル / ON ${allFiles} ファイル + 無視されたディレクトリ ${lazy}${plain.truncated ? " (truncated)" : ""}`
    },
    2000,
  )

  let firstText = ""
  await check(repo, wt, "file", async () => {
    const tracked = (await gitText(ctx, ["ls-files", "-z"])).split("\0").filter(Boolean)
    const pick = ["README.md", "CLAUDE.md"].find((p) => tracked.includes(p)) ?? tracked.find((p) => /\.(md|ts|tf|py|ya?ml|json|sh)$/.test(p))
    assert(pick, "テキストのファイルがない")
    const c = await readContent(ctx, pick)
    assert(c.kind === "text", `text ではない (${c.kind})`)
    const fsText = await readFile(path.join(ctx.root, pick), "utf8")
    assert(c.content === fsText, "内容が fs と違う")
    firstText = fsText
    return `${pick} (${c.size} B)`
  })

  await check(
    repo,
    wt,
    "search",
    async () => {
      const word = /[A-Za-z]{5,}/.exec(firstText)?.[0] ?? "main"
      const opts = { caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "", ignored: false }
      const r = await searchContent(ctx, { ...opts, q: word })
      assert(r.hits.length > 0, `「${word}」がヒットしない`)
      for (const h of r.hits) {
        assert(!matchesAny(h.path, ctx.excludes), `除外パターンのパスがヒットした: ${h.path}`)
        for (const m of h.matches) assert(h.text.slice(m.start, m.end).toLowerCase() === word.toLowerCase(), `一致の位置が違う: ${h.path}:${h.line}`)
      }
      const n = await searchNames(ctx, { ...opts, q: "spec", ignored: true })
      for (const f of n.files) assert(/spec/i.test(f.path.split("/").pop()!), `ファイル名に spec がない: ${f.path}`)
      return `「${word}」${r.hits.length} 件${r.truncated ? " (truncated)" : ""} / ファイル名「spec」${n.files.length} 件 (無視されたもの ${n.files.filter((f) => f.ignored).length})`
    },
    3000,
  )

  await check(repo, wt, "uncommitted", async () => {
    const got = await changes(ctx)
    const want = parseNumstat(await gitText(ctx, ["diff", "HEAD", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"]))
    for (const p of await directUntracked(ctx)) want.set(p, await lineCountStat(ctx, p))
    compareStats("未コミット", got, want)
    return `${got.length} ファイル`
  })

  if (!compareBranch) {
    await check(repo, wt, "compare", async () => {
      throw new Error("比較対象のブランチがない")
    })
    return
  }
  const ref = (await listBranches(ctx)).find((b) => b.name === compareBranch)!.ref
  let committedFiles: Awaited<ReturnType<typeof compare>>["files"] = []
  let commits: Awaited<ReturnType<typeof compare>>["commits"] = []

  await check(repo, wt, "compare", async () => {
    const mb = (await gitText(ctx, ["merge-base", ref, "HEAD"])).trim()
    const [off, on] = await Promise.all([compare(ctx, compareBranch, false), compare(ctx, compareBranch, true)])
    assert(off.mergeBase === mb, "マージベースが違う")
    compareStats(`${compareBranch}...HEAD`, off.files, parseNumstat(await gitText(ctx, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", mb, "HEAD"])))
    const wantOn = parseNumstat(await gitText(ctx, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", mb]))
    for (const p of await directUntracked(ctx)) wantOn.set(p, await lineCountStat(ctx, p))
    compareStats(`${compareBranch}...作業ツリー`, on.files, wantOn)
    const [behind, ahead] = (await gitText(ctx, ["rev-list", "--left-right", "--count", `${ref}...HEAD`])).trim().split(/\s+/).map(Number)
    assert(off.ahead === ahead && off.behind === behind, `ahead / behind が違う (↑${off.ahead} ↓${off.behind} / git ↑${ahead} ↓${behind})`)
    committedFiles = off.files
    commits = off.commits
    return `${compareBranch}: ${off.files.length} ファイル (未コミットを含めて ${on.files.length}) ↑${ahead} ↓${behind}`
  })

  await check(repo, wt, "history", async () => {
    const want = (await gitText(ctx, ["rev-list", "--max-count=500", `${ref}..HEAD`])).split("\n").filter(Boolean)
    assert(commits.length === want.length, `コミットの数が違う (${commits.length} / git ${want.length})`)
    commits.forEach((c, i) => assert(c.hash === want[i], `${i} 番目のコミットが違う`))
    if (!commits.length) return "コミットなし (比較対象と同じか遅れている)"
    const detail = await commitDetail(ctx, commits[0].hash)
    assert(detail.files && detail.files.length === detail.fileCount, "コミットの詳細の変更ファイルがない")
    const f = committedFiles.find((x) => !x.binary)
    if (f) {
      const d = await fileDiff(ctx, f.path, f.oldPath ?? null, `branch:${compareBranch}`)
      assert(d.kind === "text", `差分が text ではない (${d.kind})`)
      assert(d.additions === f.additions && d.deletions === f.deletions, `${f.path} の差分の行数が違う (+${d.additions} -${d.deletions} / +${f.additions} -${f.deletions})`)
    }
    return `${commits.length} コミット、詳細 ${detail.shortHash} ${detail.files.length} ファイル${f ? `、差分 ${f.path} +${f.additions} -${f.deletions}` : ""}`
  })
}

// ---------------------------------------------------------------------------

for (const { name, root, excludes } of REPOS) {
  const before = await snapshot(root)
  const pathMappings = await detectMappings(root)
  const project: ProjectRow = { id: name, path: root, name, color: "", excludes, defaultCompareBranch: null, pathMappings }

  let infos: Awaited<ReturnType<typeof discoverWorktrees>> = []
  await check(name, "-", "worktrees", async () => {
    infos = await discoverWorktrees(root, pathMappings)
    const ids = (await readdir(path.join(root, ".git", "worktrees")).catch(() => [] as string[])).sort()
    const found = infos.filter((w) => !w.isMain).map((w) => w.id).sort()
    assert(JSON.stringify(ids) === JSON.stringify(found), `worktree の一覧が違う (${found.join(",")} / ${ids.join(",")})`)
    for (const w of infos) {
      assert(!w.missing, `${w.id} が見つからない (${w.hostPath})`)
      if (w.isMain) continue
      assert(w.containerPath, `${w.id} のコンテナ内のパスがない`)
      assert(w.hostPath.startsWith(root + "/"), `${w.id} のホストのパスが読み替えられていない (${w.hostPath})`)
      const pointer = parseGitFile(await readFile(path.join(w.hostPath, ".git"), "utf8"))
      assert(pointer?.endsWith(`/worktrees/${w.id}`), `${w.id} の .git が管理用のディレクトリを指していない`)
    }
    const map = pathMappings.map((m) => `${m.container} → ${m.host.replace(HOME, "~")}`).join(", ")
    return `${map} | ${infos.map((w) => (w.isMain ? "main" : `${w.id}→${w.name}→${w.relPath}`)).join(", ")}`
  })

  const mainCtx = await makeCtx(project, "main", DEFAULT_EXCLUDES)
  let auto: string | null = null
  await check(name, "-", "branches", async () => {
    const got = await listBranches(mainCtx)
    const out = await gitText(mainCtx, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"])
    const want = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\0"))
      .filter(([, sym]) => !sym)
      .map(([r]) => r)
      .sort()
    assert(JSON.stringify(got.map((b) => b.ref).sort()) === JSON.stringify(want), `ブランチの一覧が違う (${got.length} / git ${want.length})`)
    auto = autoCompareBranch(got)
    assert(auto, "自動の比較対象がない")
    return `ローカル ${got.filter((b) => !b.remote).length} / リモート ${got.filter((b) => b.remote).length}、自動の比較対象 ${auto}`
  })

  for (const w of infos) {
    if (w.missing) continue
    const ctx = w.isMain ? mainCtx : await makeCtx(project, w.id, DEFAULT_EXCLUDES)
    await checkWorktree(name, ctx, auto)
  }

  await check(name, "-", "read-only", async () => {
    const after = await snapshot(root)
    const changed = diffSnapshots(before, after)
    assert(!changed.length, `書き換わった: ${changed.slice(0, 5).map((p) => p.replace(HOME, "~")).join(", ")}`)
    return `.git の ${after.size} 件のファイルが変わっていない`
  })
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------

const items = ["worktrees", "branches", "tree", "file", "search", "uncommitted", "compare", "history", "read-only"]
console.log("\n" + ["repo".padEnd(12), ...items.map((i) => i.padEnd(11))].join(" "))
for (const { name } of REPOS) {
  const row = items.map((i) => {
    const rs = results.filter((r) => r.repo === name && r.item === i)
    if (!rs.length) return "-".padEnd(11)
    const ng = rs.filter((r) => !r.ok).length
    return (ng ? `NG ${ng}/${rs.length}` : `OK ${rs.length}`).padEnd(11)
  })
  console.log([name.padEnd(12), ...row].join(" "))
}
const ng = results.filter((r) => !r.ok)
console.log(`\n${results.length} 項目中 ${results.length - ng.length} 項目 OK${ng.length ? `、${ng.length} 項目 NG` : ""}`)
process.exit(ng.length ? 1 : 0)
