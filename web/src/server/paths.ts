import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ApiError } from "./errors"

// パスの検証 (docs/agent-tasks/init/implementation-plan.md §6.2)

export const home = () => process.env.SHERPA_HOME || os.homedir()

export function expandHome(p: string) {
  if (p === "~") return home()
  if (p.startsWith("~/")) return path.join(home(), p.slice(2))
  return p
}

// worktree の直下からの相対パスを確かめる。"" (直下) は allowRoot のときだけ受け付ける
export function checkRel(rel: string | null | undefined, allowRoot = false): string {
  const r = (rel ?? "").replace(/\/+$/, "")
  if (!r) {
    if (allowRoot) return ""
    throw new ApiError("INVALID_PATH", "パスを指定してください")
  }
  if (r.includes("\0") || r.startsWith("/") || r.includes("\\")) throw new ApiError("INVALID_PATH", "パスが正しくありません")
  const parts = r.split("/")
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new ApiError("INVALID_PATH", "パスが正しくありません")
  return r
}

export function isInside(root: string, p: string) {
  const rel = path.relative(root, p)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// root の下の相対パスを絶対パスにする。シンボリックリンクを解決した先も root の下にあることを確かめる
export async function resolveInside(root: string, rel: string, opts: { allowRoot?: boolean; followLinks?: boolean } = {}) {
  const r = checkRel(rel, opts.allowRoot)
  const abs = path.resolve(root, r)
  if (!isInside(root, abs)) throw new ApiError("OUTSIDE", "worktree の外は読めません", 403)
  if (opts.followLinks !== false) {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(abs).catch(() => null)])
    if (real && !isInside(realRoot, real)) throw new ApiError("OUTSIDE", "worktree の外を指すリンクは読めません", 403)
  }
  return abs
}
