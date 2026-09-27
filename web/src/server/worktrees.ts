import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import type { PathMapping } from "@/lib/types"
import { isInside } from "./paths"

// worktree の検出とパスの読み替え (docs/implementation-plan.md §3.2)。
// git worktree list は使わない (コンテナ内のパスを prunable と誤判定するため)。.git/worktrees/*/gitdir を読む

export type WorktreeInfo = {
  id: string
  name: string
  hostPath: string
  containerPath?: string
  relPath: string
  isMain: boolean
  missing: boolean
  gitDir: string
}

// コンテナ内のパスをホストのパスに読み替える。どの対応にも当たらなければそのまま返す
export function mapPath(p: string, mappings: PathMapping[]): string {
  for (const m of mappings) {
    const c = m.container.replace(/\/+$/, "")
    if (!c) continue
    if (p === c) return m.host
    if (p.startsWith(c + "/")) return m.host.replace(/\/+$/, "") + p.slice(c.length)
  }
  return p
}

async function readText(p: string) {
  return readFile(p, "utf8").then(
    (s) => s,
    () => null,
  )
}

// "gitdir: <path>" の <path>
export function parseGitFile(text: string | null): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text ?? "")
  return m ? m[1] : null
}

export async function discoverWorktrees(root: string, mappings: PathMapping[]): Promise<WorktreeInfo[]> {
  const main: WorktreeInfo = {
    id: "main",
    name: path.basename(root),
    hostPath: root,
    relPath: "",
    isMain: true,
    missing: !(await isDir(path.join(root, ".git"))),
    gitDir: path.join(root, ".git"),
  }
  const adminRoot = path.join(root, ".git", "worktrees")
  const ids = await readdir(adminRoot).catch(() => [] as string[])
  const list: WorktreeInfo[] = []
  for (const id of ids.sort()) {
    const gitDir = path.join(adminRoot, id)
    const gitdirFile = (await readText(path.join(gitDir, "gitdir")))?.trim()
    if (!gitdirFile) continue
    const recorded = path.dirname(gitdirFile)
    const hostPath = mapPath(recorded, mappings)
    // .git のファイルがあり、それがこの管理用のディレクトリを指しているときだけ有効 (ディレクトリがあるだけでは判断しない)
    const pointer = parseGitFile(await readText(path.join(hostPath, ".git")))
    const valid = !!pointer && pointer.replace(/\/+$/, "").endsWith(`/worktrees/${id}`)
    list.push({
      id,
      name: path.basename(hostPath),
      hostPath,
      containerPath: hostPath !== recorded ? recorded : undefined,
      relPath: isInside(root, hostPath) ? path.relative(root, hostPath) : hostPath,
      isMain: false,
      missing: !valid,
      gitDir,
    })
  }
  return [main, ...list]
}

async function isDir(p: string) {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  )
}

// devcontainer のパスマッピングの自動検出。
// 1. devcontainer.json の workspaceFolder、2. worktree の .git ファイルに記録されたパス、3. /workspaces/<ディレクトリ名>
export async function detectMappings(root: string): Promise<PathMapping[]> {
  const base = path.basename(root)
  const candidates = [path.join(root, ".devcontainer/devcontainer.json"), path.join(root, ".devcontainer.json")]
  const sub = await readdir(path.join(root, ".devcontainer"), { withFileTypes: true }).catch(() => [])
  for (const d of sub) if (d.isDirectory()) candidates.push(path.join(root, ".devcontainer", d.name, "devcontainer.json"))
  for (const file of candidates) {
    const text = await readText(file)
    if (!text) continue
    const json = parseJsonc(text) as { workspaceFolder?: string } | undefined
    if (json?.workspaceFolder) {
      const folder = json.workspaceFolder.replace(/\$\{localWorkspaceFolderBasename\}/g, base).replace(/\/+$/, "")
      return [{ container: folder, host: root }]
    }
  }
  const ids = await readdir(path.join(root, ".git", "worktrees")).catch(() => [] as string[])
  for (const id of ids) {
    const gitdirFile = (await readText(path.join(root, ".git", "worktrees", id, "gitdir")))?.trim()
    if (!gitdirFile) continue
    // 記録されたパス (<X>/<rest>) の <rest> がホストの root の下にあれば、<X> がコンテナの中の root
    const segs = path.dirname(gitdirFile).split("/")
    for (let i = 1; i < segs.length; i++) {
      const rest = segs.slice(i).join("/")
      const pointer = parseGitFile(await readText(path.join(root, rest, ".git")))
      if (pointer && pointer.replace(/\/+$/, "").endsWith(`/worktrees/${id}`)) {
        const container = segs.slice(0, i).join("/")
        if (container && container !== root) return [{ container, host: root }]
        break
      }
    }
  }
  return [{ container: `/workspaces/${base}`, host: root }]
}
