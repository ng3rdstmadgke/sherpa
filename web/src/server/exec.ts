import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { existsSync } from "node:fs"
import { sep } from "node:path"
import { ApiError } from "./errors"

// git / rg の実行 (docs/architecture/git.md §1)。シェルは通さない。同時に 8 個まで

export type RunResult = { stdout: Buffer; stderr: string; code: number; truncated: boolean }

type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  input?: string
  maxBytes?: number
  // 出力を行ごとに受け取る (rg --json)。false を返すと止める
  onLine?: (line: string) => boolean | void
}

const MAX_PROCS = 8
let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PROCS) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return withSlot(
    () =>
      new Promise<RunResult>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] })
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        let stderr = ""
        let rest = ""
        const decoder = new StringDecoder("utf8")
        const max = opts.maxBytes ?? 64 * 1024 * 1024
        const timer = setTimeout(() => {
          truncated = true
          child.kill("SIGKILL")
        }, opts.timeout ?? 10_000)
        child.stdout.on("data", (b: Buffer) => {
          if (opts.onLine) {
            // 複数バイトの文字が chunk の境目で切れても壊れないよう、StringDecoder で文字列にする
            const text = rest + decoder.write(b)
            const lines = text.split("\n")
            rest = lines.pop() ?? ""
            for (const l of lines) {
              if (opts.onLine(l) === false) {
                truncated = true
                child.kill()
                return
              }
            }
            return
          }
          size += b.length
          if (size > max) {
            truncated = true
            child.kill()
            return
          }
          chunks.push(b)
        })
        child.stderr.on("data", (b: Buffer) => {
          if (stderr.length < 10_000) stderr += b.toString("utf8")
        })
        child.on("error", (e: NodeJS.ErrnoException) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          if (opts.onLine && !truncated) {
            const last = rest + decoder.end()
            if (last) opts.onLine(last)
          }
          resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? -1, truncated })
        })
        child.stdin.on("error", () => {})
        child.stdin.end(opts.input ?? "")
      }),
  )
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export type GitCtx = { gitDir: string; workTree: string }

// diff.autoRefreshIndex=false: git diff は、内容は同じで stat だけ変わったファイルがあると index を書き直す (GIT_OPTIONAL_LOCKS を見ない)。
// 実際のリポジトリの index を書き換えないよう止める
const GIT_CONFIG = ["core.quotepath=false", "color.ui=false", "core.fsmonitor=false", "gc.auto=0", "maintenance.auto=false", "diff.autoRefreshIndex=false"]

export function gitEnv(ctx: GitCtx): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_DIR: ctx.gitDir,
    GIT_WORK_TREE: ctx.workTree,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  }
}

type GitOptions = Omit<RunOptions, "cwd" | "env"> & { ok?: number[] }

// git を実行する。ok に含まれない終了コードなら GIT_FAILED にする
export async function git(ctx: GitCtx, args: string[], opts: GitOptions = {}): Promise<RunResult> {
  const full = GIT_CONFIG.flatMap((c) => ["-c", c]).concat(args)
  let r: RunResult
  try {
    r = await run("git", full, { ...opts, cwd: ctx.workTree, env: gitEnv(ctx) })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // cwd がない場合も ENOENT になる
      if (!(await exists(ctx.workTree))) throw new ApiError("WORKTREE_MISSING", "worktree が見つかりません", 404)
      throw new ApiError("GIT_NOT_FOUND", "git が見つかりません", 500)
    }
    throw e
  }
  if (!(opts.ok ?? [0]).includes(r.code)) {
    const first = r.stderr.trim().split("\n")[0] || `git ${args[0]} が終了コード ${r.code} で失敗しました`
    throw new ApiError("GIT_FAILED", first, 500)
  }
  return r
}

export async function gitText(ctx: GitCtx, args: string[], opts: GitOptions = {}) {
  return (await git(ctx, args, opts)).stdout.toString("utf8")
}

async function exists(p: string) {
  const { stat } = await import("node:fs/promises")
  return stat(p).then(
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// rg と、ツールの有無
// ---------------------------------------------------------------------------

// rg は @vscode/ripgrep に同梱のものを使う (開発サーバーには rg が入っていない)。SHERPA_RG があればそれを使う。
// パッケージを import すると、バンドラーが rg の実行ファイルまで読み込もうとして失敗するので、パスを直接組み立てる
export function rgPath(): string {
  if (process.env.SHERPA_RG) return process.env.SHERPA_RG
  const bin = process.platform === "win32" ? "rg.exe" : "rg"
  const pkg = ["@vscode", `ripgrep-${process.platform}-${process.arch}`, "bin", bin]
  const candidate = [process.cwd(), "node_modules", ...pkg].join(sep)
  return existsSync(candidate) ? candidate : "rg"
}

type Tool = { ok: boolean; version?: string }
const g = globalThis as unknown as { __sherpaTools?: Promise<{ git: Tool; rg: Tool }> }

async function version(cmd: string): Promise<Tool> {
  try {
    const r = await run(cmd, ["--version"], { timeout: 5000 })
    return r.code === 0 ? { ok: true, version: r.stdout.toString("utf8").split("\n")[0].trim() } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export function tools() {
  g.__sherpaTools ??= Promise.all([version("git"), version(rgPath())]).then(([git, rg]) => ({ git, rg }))
  return g.__sherpaTools
}
