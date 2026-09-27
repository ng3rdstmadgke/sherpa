import { writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { WatchEvent } from "@/lib/types"
import { git, makeFixture, type Fixture } from "../fixtures/make-repo"

// ファイルの監視と通知 (chokidar)

let fx: Fixture
let W: typeof import("@/server/watch")
const events: WatchEvent[] = []
let unsubscribe = () => {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: (e: WatchEvent) => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (events.some(pred)) return true
    await sleep(100)
  }
  return false
}

const touched = (p: string) => (e: WatchEvent) => e.type === "files" && e.paths.includes(p)

beforeAll(async () => {
  fx = makeFixture()
  process.env.SHERPA_HOME = fx.root
  process.env.SHERPA_DB = path.join(fx.root, "watch.db")
  const projects = await import("@/server/projects")
  W = await import("@/server/watch")
  await projects.createProject({ path: fx.proj, name: "proj", pathMappings: [{ container: fx.fake, host: fx.proj }], excludes: [], defaultCompareBranch: null })
  projects.setSpecPaths("proj", "main", "agent-tasks/*")
  unsubscribe = W.subscribe(["proj/main", "proj/wt1"], (e) => events.push(e))
  // chokidar が監視を始めるまで待つ
  await sleep(1500)
})

afterAll(async () => {
  unsubscribe()
  await W?.stopAll()
  fx?.cleanup()
})

describe("監視", () => {
  it("作業ツリーの変更を通知する", async () => {
    writeFileSync(path.join(fx.proj, "src/new.ts"), "x\n")
    expect(await waitFor(touched("src/new.ts"))).toBe(true)
    const e = events.find(touched("src/new.ts"))
    expect(e).toMatchObject({ type: "files", projectId: "proj", worktreeId: "main", structure: true })
    writeFileSync(path.join(fx.proj, "README.md"), "changed again\n")
    expect(await waitFor((x) => touched("README.md")(x) && x.type === "files" && !x.structure)).toBe(true)
  })

  it("コンテナで作った worktree も監視する", async () => {
    writeFileSync(path.join(fx.wt1, "src/feature.ts"), "changed\n")
    expect(await waitFor((e) => e.type === "files" && e.worktreeId === "wt1" && e.paths.includes("src/feature.ts"))).toBe(true)
  })

  it("SPEC の場所は無視されていても監視し、ほかの無視されたディレクトリと除外パターンは監視しない", async () => {
    writeFileSync(path.join(fx.proj, "node_modules/pkg/index.js"), "changed\n")
    writeFileSync(path.join(fx.proj, "tmp/memo.md"), "changed\n")
    writeFileSync(path.join(fx.proj, "agent-tasks/feature/x/spec.md"), "# changed\n")
    expect(await waitFor(touched("agent-tasks/feature/x/spec.md"))).toBe(true)
    await sleep(800)
    expect(events.some(touched("node_modules/pkg/index.js"))).toBe(false)
    expect(events.some(touched("tmp/memo.md"))).toBe(false)
    // 別の worktree (.worktree/wt1) の変更は main worktree には届かない
    expect(events.some((e) => e.type === "files" && e.worktreeId === "main" && e.paths.some((p) => p.startsWith(".worktree/")))).toBe(false)
  })

  it("HEAD / index / refs の変化を git の通知にする", async () => {
    git(fx.proj, "add", "src/new.ts")
    expect(await waitFor((e) => e.type === "git" && e.worktreeId === "main")).toBe(true)
  })

  it("worktree の追加を通知する", async () => {
    git(fx.proj, "worktree", "add", "-q", "-b", "feature/z", ".worktree/wt3", "main")
    expect(await waitFor((e) => e.type === "worktrees" && e.projectId === "proj")).toBe(true)
  })

  it("購読していない worktree の通知は届かない", async () => {
    const other: WatchEvent[] = []
    const off = W.subscribe(["proj/det"], (e) => other.push(e))
    await sleep(1500)
    writeFileSync(path.join(fx.proj, "notes.txt"), "changed\n")
    expect(await waitFor(touched("notes.txt"))).toBe(true)
    off()
    expect(other.some((e) => e.type === "files" && e.worktreeId === "main")).toBe(false)
  })
})
