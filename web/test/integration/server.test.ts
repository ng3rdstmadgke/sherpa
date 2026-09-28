import { statSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEFAULT_EXCLUDES } from "@/lib/excludes"
import type { FileNode } from "@/lib/types"
import { gitEnvFor, gitWith, makeFixture, type Fixture } from "../fixtures/make-repo"

// server/ の関数を、一時ディレクトリの git リポジトリに対して確かめる

let fx: Fixture
let S: {
  worktrees: typeof import("@/server/worktrees")
  projects: typeof import("@/server/projects")
  files: typeof import("@/server/files")
  git: typeof import("@/server/git")
  search: typeof import("@/server/search")
}
let indexMtime: number[] = []

const indexFiles = () => [path.join(fx.proj, ".git/index"), path.join(fx.proj, ".git/worktrees/wt1/index")]

beforeAll(async () => {
  fx = makeFixture()
  process.env.SHERPA_HOME = fx.root
  process.env.SHERPA_DB = path.join(fx.root, "sherpa.db")
  S = {
    worktrees: await import("@/server/worktrees"),
    projects: await import("@/server/projects"),
    files: await import("@/server/files"),
    git: await import("@/server/git"),
    search: await import("@/server/search"),
  }
  indexMtime = indexFiles().map((f) => statSync(f).mtimeMs)
})

afterAll(() => fx?.cleanup())

const row = () => ({
  id: "proj",
  path: fx.proj,
  name: "proj",
  color: "bg-sky-500",
  excludes: ["build/keep.txt"],
  defaultCompareBranch: null,
  pathMappings: [{ container: fx.fake, host: fx.proj }],
})
const ctx = (id = "main") => S.projects.makeCtx(row(), id, DEFAULT_EXCLUDES)
const names = (nodes: FileNode[]) => nodes.map((n) => n.name)
const find = (nodes: FileNode[], p: string): FileNode | undefined => {
  for (const n of nodes) {
    if (n.path === p) return n
    const c = n.children && find(n.children, p)
    if (c) return c
  }
}
const code = async (p: Promise<unknown>) => p.then(
  () => "ok",
  (e: { code?: string; status?: number }) => `${e.code}:${e.status}`,
)

describe("worktree の検出とパスの読み替え", () => {
  it("devcontainer.json の workspaceFolder からマッピングを作る", async () => {
    expect(await S.worktrees.detectMappings(fx.proj)).toEqual([{ container: fx.fake, host: fx.proj }])
  })

  it("workspaceFolder がなければ、worktree の .git に記録されたパスから作る", async () => {
    const { rmSync, readFileSync, writeFileSync } = await import("node:fs")
    const file = path.join(fx.proj, ".devcontainer/devcontainer.json")
    const saved = readFileSync(file)
    rmSync(file)
    try {
      expect(await S.worktrees.detectMappings(fx.proj)).toEqual([{ container: fx.fake, host: fx.proj }])
    } finally {
      writeFileSync(file, saved)
    }
  })

  it("コンテナ内のパスを読み替え、消えた worktree と、id と名前の違う worktree を扱う", async () => {
    const list = await S.worktrees.discoverWorktrees(fx.proj, row().pathMappings)
    const byId = Object.fromEntries(list.map((w) => [w.id, w]))
    expect(list.map((w) => w.id)).toEqual(["main", "det", "gone", "wt1", "wt2admin"])
    expect(byId.wt1).toMatchObject({ hostPath: fx.wt1, containerPath: `${fx.fake}/.worktree/wt1`, relPath: ".worktree/wt1", missing: false })
    expect(byId.wt2admin).toMatchObject({ name: "wt2-dir", hostPath: fx.wt2, missing: false })
    expect(byId.wt2admin.containerPath).toBeUndefined()
    expect(byId.gone.missing).toBe(true)
    // マッピングがなければ、偽のコンテナ内のパス (空のディレクトリはある) は有効な worktree にならない
    const noMap = await S.worktrees.discoverWorktrees(fx.proj, [])
    expect(noMap.find((w) => w.id === "wt1")?.missing).toBe(true)
  })

  it("別の worktree を除外パターンに足す", async () => {
    const c = await ctx()
    expect(c.nested.sort()).toEqual([".worktree/det", ".worktree/gone", ".worktree/wt1", ".worktree/wt2-dir"])
    expect(await code(ctx("gone"))).toBe("WORKTREE_MISSING:404")
    expect(await code(ctx("nope"))).toBe("NOT_FOUND:404")
  })

  it("ブランチにない HEAD", async () => {
    expect(await S.projects.readBranch(path.join(fx.proj, ".git/worktrees/det"))).toBeNull()
    expect(await S.projects.readBranch(path.join(fx.proj, ".git/worktrees/wt1"))).toBe("feature/x")
  })
})

describe("ファイルの一覧", () => {
  it("gitignore OFF: 管理下と Untracked だけ。除外パターンに当たるものは出さない", async () => {
    const { nodes, truncated } = await S.files.listTree(await ctx(), false)
    expect(truncated).toBe(false)
    expect(names(nodes)).toEqual([".devcontainer", "docs", "src", ".gitignore", "README.md", "bin.dat", "img.png", "link-in", "link-out", "notes.txt", "メモ 1.md"])
    // build/keep.txt はプロジェクトの除外パターン
    expect(find(nodes, "build")).toBeUndefined()
    // git rm したファイルは index にないので出さない
    expect(find(nodes, "src/old.txt")).toBeUndefined()
    expect(find(nodes, "docs/renamed.md")).toBeDefined()
  })

  it("gitignore ON: 無視されたディレクトリは lazy にまとめ、別の worktree と除外パターンは出さない", async () => {
    const { nodes } = await S.files.listTree(await ctx(), true)
    expect(find(nodes, "tmp")).toMatchObject({ lazy: true, ignored: true })
    expect(find(nodes, "agent-tasks")).toMatchObject({ lazy: true, ignored: true })
    expect(find(nodes, "node_modules")).toBeUndefined()
    expect(find(nodes, "app")).toBeUndefined()
    expect(find(nodes, "infra")).toBeUndefined()
    // .worktree/ の中身は別の worktree だけなので、消える
    expect(find(nodes, ".worktree")).toBeUndefined()
    // 中身だけを無視するパターン (**/.cache/*): 中身がすべて無視されているので 1 行にまとまり、その下の行は出さない
    expect(find(nodes, "build/.cache")).toMatchObject({ lazy: true, ignored: true })
    expect(find(nodes, "build/.cache/a")).toBeUndefined()
  })

  it("lazy のディレクトリの中身", async () => {
    const c = await ctx()
    const tmp = await S.files.listChildren(c, "tmp")
    expect(tmp).toEqual([
      { name: "other", path: "tmp/other", type: "dir", ignored: true, lazy: true },
      { name: "memo.md", path: "tmp/memo.md", type: "file", ignored: true },
    ])
    // 別の git リポジトリの .git は除外パターン
    expect(names(await S.files.listChildren(c, "tmp/other"))).toEqual(["a.txt"])
    expect(await code(S.files.listChildren(c, "../x"))).toBe("INVALID_PATH:400")
  })

  it("worktree の一覧 (wt1) には main の変更が出ない", async () => {
    const { nodes } = await S.files.listTree(await ctx("wt1"), false)
    expect(find(nodes, "src/feature.ts")).toBeDefined()
    expect(find(nodes, "wt1-new.txt")).toBeDefined()
    expect(find(nodes, "notes.txt")).toBeUndefined()
  })

  it("サジェスト: gitignore の印", async () => {
    const list = await S.files.listDir(await ctx(), "")
    const byName = Object.fromEntries(list.map((e) => [e.name, e]))
    expect(byName.tmp).toEqual({ name: "tmp", kind: "dir", badges: ["gitignore"] })
    expect(byName.src).toEqual({ name: "src", kind: "dir", badges: undefined })
    expect(byName.node_modules).toBeUndefined()
    expect(byName[".git"]).toBeUndefined()
    expect((await S.files.listDir(await ctx(), "agent-tasks/feature/")).map((e) => e.name)).toEqual(["x"])
  })

  it("SPEC は無視されていても探す", async () => {
    const r = await S.files.listSpec(await ctx(), "agent-tasks/*")
    expect(r.count).toBe(2)
    expect(find(r.nodes, "agent-tasks/feature/x/spec.md")).toBeDefined()
    expect(find(r.nodes, "agent-tasks/feature/x/log.txt")).toBeUndefined()
    expect((await S.files.listSpec(await ctx(), "")).count).toBe(0)
    expect((await S.files.listSpec(await ctx(), "docs/*, **/*.md")).count).toBeGreaterThanOrEqual(5)
    // node_modules の中の .md は出さない
    const all = await S.files.listSpec(await ctx(), "**/*.md")
    expect(find(all.nodes, "node_modules/pkg/README.md")).toBeUndefined()
  })
})

describe("ファイルの内容", () => {
  it("テキスト・画像・バイナリ・シンボリックリンク", async () => {
    const c = await ctx()
    expect(await S.files.readContent(c, "README.md")).toMatchObject({ kind: "text", content: "# proj changed\n\nline 2\nline 3\n", highlight: true })
    expect(await S.files.readContent(c, "img.png")).toMatchObject({ kind: "image" })
    expect(await S.files.readContent(c, "bin.dat")).toEqual({ kind: "binary", size: 5 })
    expect(await S.files.readContent(c, "link-out")).toEqual({ kind: "symlink", target: "/etc/hostname", outside: true })
    expect(await S.files.readContent(c, "link-in")).toMatchObject({ kind: "text", content: "# proj changed\n\nline 2\nline 3\n" })
    expect(await code(S.files.readContent(c, "src/old.txt"))).toBe("NOT_FOUND:404")
    expect(await code(S.files.readContent(c, "src"))).toBe("INVALID_PATH:400")
    expect(await code(S.files.readContent(c, "../proj/README.md"))).toBe("INVALID_PATH:400")
  })

  it("raw: 外を指すリンクは読まない。rev のファイルを読む", async () => {
    const c = await ctx()
    expect(await code(S.files.rawFile(c, "link-out", null))).toBe("OUTSIDE:403")
    const res = await S.files.rawFile(c, "img.png", null)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-security-policy")).toBe("sandbox")
    const old = await S.files.rawFile(c, "src/old.txt", fx.commits.base)
    expect(await old.text()).toBe("old\n")
    expect(await code(S.files.rawFile(c, "README.md", "HEAD"))).toBe("INVALID_REQUEST:400")
  })
})

describe("git", () => {
  const numstat = (gitDir: string, workTree: string, ...args: string[]) =>
    gitWith(gitEnvFor(gitDir, workTree), workTree, "-c", "diff.autoRefreshIndex=false", "diff", "--numstat", "-M", ...args)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))

  it("ブランチの一覧と自動の比較対象", async () => {
    const c = await ctx()
    const branches = await S.git.listBranches(c)
    expect(branches.filter((b) => !b.remote).map((b) => b.name).sort()).toEqual(["develop", "feature/gone", "feature/x", "feature/y", "main", "orphan", "side"])
    expect(branches.some((b) => b.name === "upstream/main" && b.remote)).toBe(true)
    expect(branches.some((b) => b.name.endsWith("/HEAD"))).toBe(false)
    expect(S.git.autoCompareBranch(branches)).toBe("main")
    const auto = async (dir: string) => S.git.autoCompareBranch(await S.git.listBranches({ gitDir: path.join(dir, ".git"), workTree: dir }))
    expect(await auto(fx.masterOnly)).toBe("master")
    expect(await auto(fx.trunkOnly)).toBeNull()
    expect(await auto(fx.remoteOnly)).toBe("upstream/main")
  })

  it("未コミットの差分は git diff HEAD --numstat と一致し、Untracked を含む", async () => {
    const c = await ctx()
    const changes = await S.git.changes(c)
    const byPath = Object.fromEntries(changes.map((x) => [x.path, x]))
    for (const [a, d, p] of numstat(path.join(fx.proj, ".git"), fx.proj, "HEAD")) {
      const key = p.includes(" => ") ? "docs/renamed.md" : p
      expect(byPath[key], p).toBeDefined()
      if (a !== "-") expect([byPath[key].additions, byPath[key].deletions]).toEqual([Number(a), Number(d)])
    }
    expect(byPath["README.md"].status).toBe("M")
    expect(byPath["src/a.ts"]).toMatchObject({ status: "M", additions: 1, deletions: 0 })
    expect(byPath["src/old.txt"].status).toBe("D")
    expect(byPath["docs/renamed.md"]).toMatchObject({ status: "R", oldPath: "docs/rename-me.md" })
    expect(byPath["img.png"]).toMatchObject({ status: "M", binary: true })
    expect(byPath["notes.txt"]).toMatchObject({ status: "U", additions: 2 })
    expect(byPath["メモ 1.md"]).toMatchObject({ status: "U", additions: 1 })
    expect(byPath["bin.dat"]).toMatchObject({ status: "U", binary: true, additions: 0 })
    expect(byPath["link-out"]).toMatchObject({ status: "U", additions: 1 })
    // 無視されたもの・除外パターンは出さない
    expect(changes.some((x) => x.path.startsWith("tmp/") || x.path.startsWith("node_modules/"))).toBe(false)
  })

  it("コンテナで作った worktree (wt1) でも動く", async () => {
    const c = await ctx("wt1")
    expect((await S.git.changes(c)).map((x) => x.path)).toEqual(["wt1-new.txt"])
    expect((await S.git.lastCommit(c))?.message).toBe("Merge side")
  })

  it("COMPARE はマージベースとの比較。git diff <merge-base> --numstat と一致する", async () => {
    const c = await ctx("wt1")
    const r = await S.git.compare(c, "main", true)
    const mb = gitWith(gitEnvFor(path.join(fx.proj, ".git/worktrees/wt1"), fx.wt1), fx.wt1, "merge-base", "main", "HEAD").trim()
    expect(r.mergeBase).toBe(mb)
    expect(mb).toBe(fx.commits.base)
    expect([r.ahead, r.behind]).toEqual([3, 1])
    const direct = numstat(path.join(fx.proj, ".git/worktrees/wt1"), fx.wt1, mb)
    expect(r.files.filter((f) => f.status !== "U").map((f) => [String(f.additions), String(f.deletions), f.path])).toEqual(direct)
    // main で進んだ README の変更は混ざらない
    expect(r.files.map((f) => f.path)).toEqual(["side.txt", "src/feature.ts", "wt1-new.txt"])
    const off = await S.git.compare(c, "main", false)
    expect(off.files.map((f) => f.path)).toEqual(["side.txt", "src/feature.ts"])
    // HISTORY: main..HEAD (マージコミットを含む)
    expect(off.commits.map((x) => x.message)).toEqual(["Merge side", "side: side.txt", "feat: feature.ts を追加"])
    expect(off.commits[0].parents).toHaveLength(2)
    expect(off.commits[0].fileCount).toBe(1)
    expect(off.commits[2]).toMatchObject({ body: "本文の行", fileCount: 1, shortHash: fx.commits.feat1.slice(0, 7) })
    expect(off.moreCommits).toBe(0)
  })

  it("リモートのブランチとも比べられる", async () => {
    const r = await S.git.compare(await ctx(), "upstream/main", false)
    expect(r.ref).toBe("refs/remotes/upstream/main")
    expect([r.ahead, r.behind]).toEqual([0, 0])
  })

  it("コミットの詳細はマージの最初の親と比べる", async () => {
    const c = await ctx()
    const m = await S.git.commitDetail(c, fx.commits.merge)
    expect(m.files?.map((f) => f.path)).toEqual(["side.txt"])
    const f = await S.git.commitDetail(c, fx.commits.feat1.slice(0, 8))
    expect(f).toMatchObject({ hash: fx.commits.feat1, message: "feat: feature.ts を追加", body: "本文の行" })
    expect(f.files).toEqual([{ path: "src/feature.ts", status: "A", additions: 2, deletions: 0 }])
    expect(await code(S.git.commitDetail(c, "zzzz"))).toBe("INVALID_REQUEST:400")
    expect(await code(S.git.commitDetail(c, "abcdef12"))).toBe("NOT_FOUND:404")
  })

  it("エラー: ブランチがない、共通の祖先がない", async () => {
    const c = await ctx()
    expect(await code(S.git.compare(c, "nope", true))).toBe("BRANCH_NOT_FOUND:404")
    expect(await code(S.git.compare(c, "--output=/tmp/x", true))).toBe("BRANCH_NOT_FOUND:404")
    const orphan = await S.git.compare(c, "orphan", true)
    expect(orphan).toMatchObject({ mergeBase: null, files: [], commits: [] })
    expect(await code(S.git.fileDiff(c, "README.md", null, "branch:orphan"))).toBe("GIT_FAILED:409")
    expect(await code(S.git.fileDiff(c, "README.md", null, "weird"))).toBe("INVALID_REQUEST:400")
  })

  it("コミットのないリポジトリ", async () => {
    const r = { ...row(), id: "nc", path: fx.noCommit, pathMappings: [] }
    const c = await S.projects.makeCtx(r, "main", DEFAULT_EXCLUDES)
    expect(await S.git.lastCommit(c)).toBeNull()
    expect((await S.git.changes(c)).map((x) => [x.path, x.status])).toEqual([["a.txt", "U"]])
    expect(await S.git.listBranches(c)).toEqual([])
  })
})

describe("1 ファイルの差分", () => {
  it("未コミット: 変更のない行も含めて全行を返す", async () => {
    const d = await S.git.fileDiff(await ctx(), "src/a.ts", null, "uncommitted")
    expect(d).toMatchObject({ kind: "text", additions: 1, deletions: 0 })
    if (d.kind !== "text") throw new Error()
    expect(d.lines.map((l) => l.type)).toEqual(["ctx", "ctx", "ctx", "add"])
  })

  it("COMPARE (未コミットを含む / 含まない) とコミット", async () => {
    const c = await ctx("wt1")
    const wt = await S.git.fileDiff(c, "wt1-new.txt", null, "branch-wt:main")
    expect(wt).toMatchObject({ kind: "text", additions: 1 })
    const br = await S.git.fileDiff(c, "src/feature.ts", null, "branch:main")
    expect(br).toMatchObject({ kind: "text", additions: 2, deletions: 0 })
    const cm = await S.git.fileDiff(c, "src/feature.ts", null, `commit:${fx.commits.feat1}`)
    expect(cm).toMatchObject({ kind: "text", additions: 2 })
    // 変更のないファイルは、全行を変更のない行として返す
    const same = await S.git.fileDiff(c, "src/a.ts", null, "branch:main")
    expect(same).toMatchObject({ kind: "text", additions: 0, deletions: 0 })
    if (same.kind === "text") expect(same.lines).toHaveLength(3)
  })

  it("Untracked はすべて追加、名前の変更だけなら全行を変更のない行", async () => {
    const c = await ctx()
    expect(await S.git.fileDiff(c, "notes.txt", null, "uncommitted")).toMatchObject({ kind: "text", additions: 2, deletions: 0 })
    const rn = await S.git.fileDiff(c, "docs/renamed.md", "docs/rename-me.md", "uncommitted")
    expect(rn).toMatchObject({ kind: "text", additions: 0, deletions: 0 })
    if (rn.kind === "text") expect(rn.lines.map((l) => l.text)).toEqual(["# rename", "", "same content"])
    const del = await S.git.fileDiff(c, "src/old.txt", null, "uncommitted")
    expect(del).toMatchObject({ kind: "text", additions: 0, deletions: 1 })
  })

  it("画像とバイナリ", async () => {
    const c = await ctx()
    const head = gitWith(gitEnvFor(path.join(fx.proj, ".git"), fx.proj), fx.proj, "rev-parse", "HEAD").trim()
    expect(await S.git.fileDiff(c, "img.png", null, "uncommitted")).toEqual({
      kind: "image",
      before: { rev: head, path: "img.png" },
      after: { rev: null, path: "img.png" },
    })
    expect(await S.git.fileDiff(c, "bin.dat", null, "uncommitted")).toEqual({ kind: "binary" })
  })
})

describe("検索", () => {
  const p = (q: string, o: Partial<import("@/server/search").SearchParams> = {}) => ({
    q,
    caseSensitive: false,
    regex: false,
    include: "",
    exclude: "",
    ignored: false,
    ...o,
  })
  const lines = async (q: string, o: Partial<import("@/server/search").SearchParams> = {}) =>
    (await S.search.searchContent(await ctx(), p(q, { include: "src", ...o }))).hits.map((h) => `${h.path}:${h.line}`)

  it("Aa / .* と、対象 / 対象外", async () => {
    expect(await lines("hello")).toEqual(["src/a.ts:1", "src/a.ts:2", "src/a.ts:3"])
    expect(await lines("Hello", { caseSensitive: true })).toEqual(["src/a.ts:1"])
    expect(await lines("hel+o\\b", { regex: true })).toEqual(["src/a.ts:1", "src/a.ts:3"])
    expect(await lines("hel+o", {})).toEqual([])
    // 後読み (PCRE2)
    expect(await lines("(?<=const )Hello", { regex: true, caseSensitive: true })).toEqual(["src/a.ts:1"])
    expect(await lines("hello", { include: "", exclude: "src" })).toEqual([])
    expect(await code(S.search.searchContent(await ctx(), p("(", { regex: true })))).toBe("INVALID_REGEX:400")
  })

  it("一致した位置は UTF-16 の位置", async () => {
    const r = await S.search.searchContent(await ctx(), p("test", { include: "*.md" }))
    const h = r.hits.find((x) => x.path === "docs/メモ v2.md")
    expect(h).toMatchObject({ line: 1, text: "日本語のテスト test", matches: [{ start: 8, end: 12 }] })
  })

  it("gitignore ON で無視されたファイルも探す。除外パターンと別の worktree は探さない", async () => {
    const off = await S.search.searchContent(await ctx(), p("ignored-marker"))
    expect(off.hits).toEqual([])
    const on = await S.search.searchContent(await ctx(), p("ignored-marker", { ignored: true }))
    expect(on.hits.map((h) => h.path)).toEqual(["tmp/memo.md"])
    const wt = await S.search.searchContent(await ctx(), p("new in wt1", { ignored: true }))
    expect(wt.hits).toEqual([])
  })

  it("ファイル名の検索 (gitignore ON)", async () => {
    const r = await S.search.searchNames(await ctx(), p("spec", { ignored: true }))
    expect(r.files).toEqual([{ path: "agent-tasks/feature/x/spec.md", ignored: true }])
    const readme = await S.search.searchNames(await ctx(), p("readme", { ignored: true }))
    // node_modules の中は出さない
    expect(readme.files).toEqual([{ path: "README.md", ignored: false }])
    expect(await code(S.search.searchNames(await ctx(), p("(", { regex: true, ignored: true })))).toBe("INVALID_REGEX:400")
  })
})

describe("読み取りだけ", () => {
  it("stat だけ変わったファイルがあっても、git diff で index を書き換えない", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs")
    const g = path.join(fx.wt1, "src/feature.ts")
    writeFileSync(g, readFileSync(g))
    await S.git.changes(await ctx())
    await S.git.changes(await ctx("wt1"))
    await S.git.compare(await ctx("wt1"), "main", true)
    await S.git.fileDiff(await ctx("wt1"), "src/feature.ts", null, "uncommitted")
    expect(indexFiles().map((x) => statSync(x).mtimeMs)).toEqual(indexMtime)
  })

  it("読んだあとも index が書き換わっていない", () => {
    expect(indexFiles().map((f) => statSync(f).mtimeMs)).toEqual(indexMtime)
  })
})
