import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompareResult, ContentSearchResult, DetectResult, FileContent, PathEntry, Project, TreeResult } from "@/lib/types"
import { makeFixture, type Fixture } from "../fixtures/make-repo"

// Route Handler を直接呼び、DB (一時ファイルの SQLite) を含めて確かめる

let fx: Fixture
type Handler = (req: Request, ctx: { params: Promise<Record<string, unknown>> }) => Promise<Response>
let R: {
  health: { GET: Handler }
  projects: { GET: Handler; POST: Handler }
  project: { PATCH: Handler; DELETE: Handler }
  detect: { GET: Handler }
  wt: { GET: Handler; PUT: Handler }
  settings: { GET: Handler; PUT: Handler }
  ui: { GET: Handler; PUT: Handler }
  dirs: { GET: Handler }
}

beforeAll(async () => {
  fx = makeFixture()
  process.env.SHERPA_HOME = fx.root
  process.env.SHERPA_DB = path.join(fx.root, "api.db")
  const r = (m: unknown) => m as never
  R = {
    health: r(await import("@/app/api/health/route")),
    projects: r(await import("@/app/api/projects/route")),
    project: r(await import("@/app/api/projects/[projectId]/route")),
    detect: r(await import("@/app/api/projects/detect/route")),
    wt: r(await import("@/app/api/projects/[projectId]/worktrees/[worktreeId]/[...rest]/route")),
    settings: r(await import("@/app/api/settings/route")),
    ui: r(await import("@/app/api/ui-state/route")),
    dirs: r(await import("@/app/api/fs/dirs/route")),
  }
})

afterAll(async () => {
  const { stopAll } = await import("@/server/watch")
  await stopAll()
  fx?.cleanup()
})

const url = (p: string) => `http://127.0.0.1:4747${p}`
const json = (method: string, p: string, body: unknown) =>
  new Request(url(p), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

async function call<T>(h: Handler, req: Request, params: Record<string, unknown> = {}): Promise<{ status: number; body: T }> {
  const res = await h(req, { params: Promise.resolve(params) })
  return { status: res.status, body: (await res.json()) as T }
}

const wtGet = <T>(pid: string, wid: string, rest: string, query = "") =>
  call<T>(R.wt.GET, new Request(url(`/api/projects/${pid}/worktrees/${wid}/${rest}${query}`)), { projectId: pid, worktreeId: wid, rest: rest.split("/") })

const input = (p: string, extra: Record<string, unknown> = {}) => ({ path: p, name: "", pathMappings: [], excludes: [], defaultCompareBranch: null, ...extra })

describe("health", () => {
  it("git と rg の版", async () => {
    const r = await call<{ git: { ok: boolean }; rg: { ok: boolean; version: string }; home: string }>(R.health.GET, new Request(url("/api/health")))
    expect(r.body.git.ok).toBe(true)
    expect(r.body.rg).toMatchObject({ ok: true })
    expect(r.body.home).toBe(fx.root)
  })
})

describe("プロジェクトの登録", () => {
  it("detect: マッピングの自動検出とブランチ", async () => {
    const r = await call<DetectResult>(R.detect.GET, new Request(url(`/api/projects/detect?path=${encodeURIComponent("~/proj/")}`)))
    expect(r.body).toMatchObject({ path: fx.proj, exists: true, isGitRepo: true, isLinkedWorktree: false, registered: false, name: "proj", autoCompareBranch: "main" })
    expect(r.body.pathMappings).toEqual([{ container: fx.fake, host: fx.proj }])
    expect(r.body.branches.length).toBeGreaterThan(5)
    const det = await call<DetectResult>(R.detect.GET, new Request(url(`/api/projects/detect?path=${encodeURIComponent(fx.det)}`)))
    expect(det.body).toMatchObject({ isGitRepo: false, isLinkedWorktree: true })
    const out = await call<{ error: { code: string } }>(R.detect.GET, new Request(url("/api/projects/detect?path=/etc")))
    expect([out.status, out.body.error.code]).toEqual([403, "OUTSIDE"])
  })

  it("登録と、登録できない場合", async () => {
    const ok = await call<Project>(R.projects.POST, json("POST", "/api/projects", input("~/proj/", { pathMappings: [{ container: fx.fake, host: "~/proj" }], excludes: ["build/**"] })))
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ id: "proj", path: fx.proj, name: "proj", autoCompareBranch: "main", excludes: ["build/**"], missing: false })
    const byId = Object.fromEntries(ok.body.worktrees.map((w) => [w.id, w]))
    expect(byId.main).toMatchObject({ isMain: true, branch: "main", name: "proj" })
    expect(byId.main.changes).toBeGreaterThanOrEqual(9)
    expect(byId.wt1).toMatchObject({ branch: "feature/x", ahead: 3, behind: 1, changes: 1, containerPath: `${fx.fake}/.worktree/wt1`, relPath: ".worktree/wt1" })
    expect(byId.wt1.lastCommit?.message).toBe("Merge side")
    expect(byId.det).toMatchObject({ branch: null, missing: false })
    expect(byId.det.head).toMatch(/^[0-9a-f]{7}$/)
    expect(byId.gone.missing).toBe(true)
    expect(byId.wt2admin.name).toBe("wt2-dir")

    const err = async (body: unknown) => {
      const r = await call<{ error: { code: string } }>(R.projects.POST, json("POST", "/api/projects", body))
      return `${r.body.error.code}:${r.status}`
    }
    expect(await err(input(fx.proj))).toBe("ALREADY_REGISTERED:409")
    expect(await err(input(fx.plain))).toBe("NOT_GIT_REPO:400")
    expect(await err(input(fx.det))).toBe("LINKED_WORKTREE:400")
    expect(await err(input(path.join(fx.root, "nope")))).toBe("NOT_FOUND:404")
    expect(await err(input("/etc"))).toBe("OUTSIDE:403")
    const bad = await call<{ error: { code: string } }>(R.projects.POST, new Request(url("/api/projects"), { method: "POST", body: "{", headers: { "Content-Type": "application/json" } }))
    expect(bad.body.error.code).toBe("INVALID_REQUEST")
  })

  it("登録した順に並び、自動の比較対象がないリポジトリも登録できる", async () => {
    await call(R.projects.POST, json("POST", "/api/projects", input(fx.trunkOnly)))
    await call(R.projects.POST, json("POST", "/api/projects", input(fx.masterOnly)))
    const list = await call<Project[]>(R.projects.GET, new Request(url("/api/projects")))
    expect(list.body.map((p) => [p.id, p.autoCompareBranch])).toEqual([
      ["proj", "main"],
      ["trunk-only", null],
      ["master-only", "master"],
    ])
    expect(new Set(list.body.map((p) => p.color)).size).toBe(3)
  })

  it("ディレクトリのサジェスト (ホームの下の名前だけ)", async () => {
    const r = await call<PathEntry[]>(R.dirs.GET, new Request(url(`/api/fs/dirs?dir=${encodeURIComponent("~/")}`)))
    const byName = Object.fromEntries(r.body.map((e) => [e.name, e]))
    expect(byName.proj.badges).toEqual(["git", "登録済み"])
    expect(byName["remote-only"].badges).toEqual(["git"])
    expect(byName.plain.badges).toBeUndefined()
    // ファイルは返さない
    expect(r.body.every((e) => e.kind === "dir")).toBe(true)
    expect((await call<PathEntry[]>(R.dirs.GET, new Request(url("/api/fs/dirs?dir=/etc/")))).body).toEqual([])
    expect((await call<PathEntry[]>(R.dirs.GET, new Request(url("/api/fs/dirs?dir=")))).body).toEqual([{ name: "~", kind: "dir" }])
  })

  it("編集: 表示名・除外パターン・既定の比較対象", async () => {
    const r = await call<Project>(
      R.project.PATCH,
      json("PATCH", "/api/projects/proj", { name: "Proj!", pathMappings: [{ container: fx.fake, host: fx.proj }], excludes: ["docs/**"], defaultCompareBranch: "develop" }),
      { projectId: "proj" },
    )
    expect(r.body).toMatchObject({ name: "Proj!", excludes: ["docs/**"], defaultCompareBranch: "develop" })
    // 既定の比較対象 (develop) に対する ahead / behind
    expect(r.body.worktrees.find((w) => w.id === "wt1")).toMatchObject({ ahead: 3, behind: 1 })
    const tree = await wtGet<TreeResult>("proj", "main", "tree")
    expect(tree.body.nodes.some((n) => n.name === "docs")).toBe(false)
  })
})

describe("worktree の API", () => {
  it("tree / file / compare / diff / search / commits", async () => {
    const tree = await wtGet<TreeResult>("proj", "wt1", "tree", "?ignored=1")
    expect(tree.status).toBe(200)
    expect(tree.body.nodes.map((n) => n.name)).toContain("src")
    const file = await wtGet<FileContent>("proj", "wt1", "file", "?path=src/feature.ts")
    expect(file.body).toMatchObject({ kind: "text", content: "export const feature = true\nexport const n = 2\n" })
    const cmp = await wtGet<CompareResult>("proj", "wt1", "compare", "?branch=main&includeUncommitted=1")
    expect(cmp.body).toMatchObject({ ahead: 3, behind: 1 })
    expect(cmp.body.files.map((f) => f.path)).toEqual(["side.txt", "src/feature.ts", "wt1-new.txt"])
    const diff = await wtGet<{ kind: string; additions: number }>("proj", "wt1", "diff", `?path=src/feature.ts&base=${encodeURIComponent("branch:main")}`)
    expect(diff.body).toMatchObject({ kind: "text", additions: 2 })
    const s = await wtGet<ContentSearchResult>("proj", "wt1", "search/content", "?q=feature&caseSensitive=1")
    expect(s.body.hits.map((h) => h.path)).toEqual(["src/feature.ts"])
    const c = await wtGet<{ files: unknown[] }>("proj", "wt1", `commits/${fx.commits.merge}`)
    expect(c.body.files).toHaveLength(1)
  })

  it("エラー", async () => {
    const e = async (p: Promise<{ status: number; body: unknown }>) => {
      const r = (await p) as { status: number; body: { error: { code: string } } }
      return `${r.body.error.code}:${r.status}`
    }
    expect(await e(wtGet("proj", "wt1", "nope"))).toBe("NOT_FOUND:404")
    expect(await e(wtGet("proj", "gone", "tree"))).toBe("WORKTREE_MISSING:404")
    expect(await e(wtGet("nope", "main", "tree"))).toBe("PROJECT_NOT_FOUND:404")
    expect(await e(wtGet("proj", "main", "file", "?path=../x"))).toBe("INVALID_PATH:400")
    expect(await e(wtGet("proj", "main", "file"))).toBe("INVALID_PATH:400")
    expect(await e(wtGet("proj", "main", "compare"))).toBe("NO_COMPARE_BRANCH:400")
    expect(await e(wtGet("proj", "main", "compare", "?branch=nope"))).toBe("BRANCH_NOT_FOUND:404")
    expect(await e(wtGet("proj", "main", "search/content", "?q=(&regex=1"))).toBe("INVALID_REGEX:400")
    expect(await e(wtGet("proj", "main", "raw", "?path=link-out"))).toBe("OUTSIDE:403")
  })

  it("raw は画像の型と sandbox の CSP を付ける", async () => {
    const res = await R.wt.GET(new Request(url("/api/projects/proj/worktrees/main/raw?path=img.png")), {
      params: Promise.resolve({ projectId: "proj", worktreeId: "main", rest: ["raw"] }),
    })
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("preview は合言葉を確かめ、パスを URL のパスで受ける", async () => {
    const { token } = (await wtGet<{ token: string }>("proj", "main", "preview-token")).body
    const preview = (projectId: string, worktreeId: string, rest: string[]) =>
      R.wt.GET(new Request(url(`/api/projects/${projectId}/worktrees/${worktreeId}/${rest.join("/")}`)), {
        params: Promise.resolve({ projectId, worktreeId, rest }),
      })
    const res = await preview("proj", "main", ["preview", token, "img.png"])
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts")
    // 合言葉が違う・別の worktree の合言葉では読めない
    expect((await preview("proj", "main", ["preview", "x".repeat(token.length), "img.png"])).status).toBe(403)
    expect((await preview("proj", "wt1", ["preview", token, "img.png"])).status).toBe(403)
  })

  it("SPEC 欄の保存", async () => {
    const put = await call(R.wt.PUT, json("PUT", "/api/projects/proj/worktrees/wt1/spec-paths", { input: "agent-tasks/*" }), {
      projectId: "proj",
      worktreeId: "wt1",
      rest: ["spec-paths"],
    })
    expect(put.status).toBe(200)
    const list = await call<Project[]>(R.projects.GET, new Request(url("/api/projects")))
    expect(list.body[0].worktrees.find((w) => w.id === "wt1")?.specPaths).toBe("agent-tasks/*")
    const spec = await wtGet<{ count: number }>("proj", "main", "spec", `?input=${encodeURIComponent("agent-tasks/*")}`)
    expect(spec.body.count).toBe(2)
  })
})

describe("設定と画面の状態", () => {
  it("全体の設定 (除外パターン)", async () => {
    const init = await call<{ excludes: string[] }>(R.settings.GET, new Request(url("/api/settings")))
    expect(init.body.excludes).toContain("**/node_modules/**")
    const put = await call<{ excludes: string[] }>(R.settings.PUT, json("PUT", "/api/settings", { excludes: ["**/node_modules/**", "", "src/**"] }))
    expect(put.body.excludes).toEqual(["**/node_modules/**", "src/**"])
    const tree = await wtGet<TreeResult>("proj", "wt1", "tree")
    expect(tree.body.nodes.some((n) => n.name === "src")).toBe(false)
    await call(R.settings.PUT, json("PUT", "/api/settings", { excludes: init.body.excludes }))
  })

  it("全体の設定 (フォントサイズ): 送った項目だけを変え、範囲に丸める", async () => {
    type S = { excludes: string[]; codeFontSize: number; markdownFontSize: number }
    const init = await call<S>(R.settings.GET, new Request(url("/api/settings")))
    expect(init.body).toMatchObject({ codeFontSize: 13, markdownFontSize: 14 })
    const put = await call<S>(R.settings.PUT, json("PUT", "/api/settings", { codeFontSize: 16 }))
    expect(put.body).toMatchObject({ codeFontSize: 16, markdownFontSize: 14, excludes: init.body.excludes })
    const clamp = await call<S>(R.settings.PUT, json("PUT", "/api/settings", { markdownFontSize: 99, codeFontSize: "x" }))
    expect(clamp.body).toMatchObject({ codeFontSize: 16, markdownFontSize: 24 })
    await call(R.settings.PUT, json("PUT", "/api/settings", { codeFontSize: 13, markdownFontSize: 14 }))
  })

  it("ui-state: 書く・前方一致で消す", async () => {
    await call(R.ui.PUT, json("PUT", "/api/ui-state", { set: { instances: [{ id: "t-1" }], "ws:t-1": { view: "git" }, "ws:t-2": { view: "files" }, "ws_x": 1, theme: "dark" } }))
    await call(R.ui.PUT, json("PUT", "/api/ui-state", { deletePrefixes: ["ws:t-1"], set: { activeId: "t-2" } }))
    const r = await call<Record<string, unknown>>(R.ui.GET, new Request(url("/api/ui-state")))
    expect(r.body).toEqual({ instances: [{ id: "t-1" }], "ws:t-2": { view: "files" }, ws_x: 1, theme: "dark", activeId: "t-2" })
    const { getTheme } = await import("@/server/ui-state")
    expect(getTheme()).toBe("dark")
  })
})

describe("登録の解除", () => {
  it("DB の行だけを消し、リポジトリは残す", async () => {
    const { existsSync } = await import("node:fs")
    const r = await call(R.project.DELETE, json("DELETE", "/api/projects/proj", {}), { projectId: "proj" })
    expect(r.status).toBe(200)
    expect(existsSync(path.join(fx.proj, ".git"))).toBe(true)
    const list = await call<Project[]>(R.projects.GET, new Request(url("/api/projects")))
    expect(list.body.map((p) => p.id)).toEqual(["trunk-only", "master-only"])
    expect((await wtGet<{ error: { code: string } }>("proj", "main", "tree")).body.error.code).toBe("PROJECT_NOT_FOUND")
    const again = await call<{ error: { code: string } }>(R.project.DELETE, json("DELETE", "/api/projects/proj", {}), { projectId: "proj" })
    expect(again.status).toBe(404)
    // もう一度登録すると新しいプロジェクトになり、SPEC 欄の入力は戻らない
    const re = await call<Project>(R.projects.POST, json("POST", "/api/projects", input(fx.proj, { pathMappings: [{ container: fx.fake, host: fx.proj }] })))
    expect(re.body.worktrees.find((w) => w.id === "wt1")?.specPaths).toBe("")
  })
})
