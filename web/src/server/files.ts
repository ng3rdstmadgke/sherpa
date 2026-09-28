import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { matchesAny } from "@/lib/glob"
import { isSpec, parseSpecPaths, specBaseDir } from "@/lib/spec"
import type { FileContent, FileNode, PathEntry, SpecResult, TreeResult } from "@/lib/types"
import { ApiError, notFound } from "./errors"
import { git, gitText } from "./exec"
import { catBlob, IMAGE_EXT } from "./git"
import { checkRel, isInside, resolveInside } from "./paths"
import type { WtCtx } from "./projects"

// ファイルの一覧・内容・SPEC (docs/architecture/files.md)

const MAX_ENTRIES = 100_000

type Entry = { path: string; type: "file" | "dir"; ignored?: boolean; lazy?: boolean; symlink?: boolean }

const byName = (a: FileNode, b: FileNode) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1)

// パスの一覧を木にする。lazy のディレクトリの下にある行は捨てる
export function buildTree(entries: Entry[]): FileNode[] {
  const lazy = new Set(entries.filter((e) => e.lazy).map((e) => e.path))
  const underLazy = (p: string) => {
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) if (lazy.has(p.slice(0, i))) return true
    return false
  }
  const roots: FileNode[] = []
  const dirs = new Map<string, FileNode>()
  const dirNode = (p: string): FileNode[] => {
    if (!p) return roots
    let d = dirs.get(p)
    if (!d) {
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
      d = { name: p.slice(p.lastIndexOf("/") + 1), path: p, type: "dir", children: [] }
      dirs.set(p, d)
      dirNode(parent).push(d)
    }
    return d.children!
  }
  for (const e of entries) {
    if (underLazy(e.path)) continue
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ""
    if (e.type === "dir") {
      const kids = dirNode(e.path)
      const d = dirs.get(e.path)!
      if (e.ignored) d.ignored = true
      if (e.lazy && !kids.length) {
        d.lazy = true
        delete d.children
      }
      continue
    }
    const node: FileNode = { name: e.path.slice(e.path.lastIndexOf("/") + 1), path: e.path, type: "file" }
    if (e.ignored) node.ignored = true
    if (e.symlink) node.symlink = true
    dirNode(parent).push(node)
  }
  const sort = (list: FileNode[]) => {
    list.sort(byName)
    for (const n of list) if (n.children) sort(n.children)
  }
  sort(roots)
  return roots
}

export const excludePathspecs = (excludes: string[]) => excludes.map((p) => `:(exclude,glob)${p}`)

// 管理下のファイルと Untracked (「gitignore」OFF の一覧)
export async function visiblePaths(ctx: WtCtx): Promise<string[]> {
  const out = await gitText(ctx, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", ".", ...excludePathspecs(ctx.excludes)])
  return out.split("\0").filter((p) => p && !matchesAny(p.replace(/\/$/, ""), ctx.excludes))
}

// 無視されたディレクトリ (--directory で 1 行にまとめたもの) とファイル
export async function ignoredEntries(ctx: WtCtx): Promise<Entry[]> {
  const out = await gitText(ctx, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
    "-z",
    "--",
    ".",
    ...excludePathspecs(ctx.excludes),
  ])
  const entries: Entry[] = []
  for (const raw of out.split("\0")) {
    if (!raw) continue
    const isDir = raw.endsWith("/")
    const p = raw.replace(/\/$/, "")
    if (matchesAny(p, ctx.excludes)) continue
    // 別の worktree を含むディレクトリ (.worktree/ など) は、その場で中身を読む
    if (isDir && ctx.nested.some((n) => n.startsWith(p + "/"))) entries.push(...(await readIgnoredDir(ctx, p, true)))
    else entries.push(isDir ? { path: p, type: "dir", ignored: true, lazy: true } : { path: p, type: "file", ignored: true })
  }
  return entries
}

// 無視されたディレクトリの中身 (fs.readdir)。除外パターンと別の worktree を除き、シンボリックリンクはたどらない
async function readIgnoredDir(ctx: WtCtx, rel: string, expandNested = false): Promise<Entry[]> {
  const dirents = await readdir(path.join(ctx.root, rel), { withFileTypes: true }).catch(() => [])
  const out: Entry[] = []
  for (const d of dirents) {
    const p = rel ? `${rel}/${d.name}` : d.name
    if (matchesAny(p, ctx.excludes)) continue
    if (d.isDirectory()) {
      if (expandNested && ctx.nested.some((n) => n.startsWith(p + "/"))) out.push(...(await readIgnoredDir(ctx, p, true)))
      else out.push({ path: p, type: "dir", ignored: true, lazy: true })
    } else out.push({ path: p, type: "file", ignored: true, symlink: d.isSymbolicLink() || undefined })
  }
  return out
}

export async function listTree(ctx: WtCtx, withIgnored: boolean): Promise<TreeResult> {
  const [visible, ignored] = await Promise.all([visiblePaths(ctx), withIgnored ? ignoredEntries(ctx) : Promise.resolve([])])
  const entries: Entry[] = visible.map((p) => (p.endsWith("/") ? { path: p.slice(0, -1), type: "dir", lazy: true } : { path: p, type: "file" }))
  entries.push(...ignored)
  const truncated = entries.length > MAX_ENTRIES
  return { nodes: buildTree(truncated ? entries.slice(0, MAX_ENTRIES) : entries), truncated }
}

// 「gitignore」ON で lazy のディレクトリを開いたとき。中身はすべて無視されたもの
export async function listChildren(ctx: WtCtx, rel: string): Promise<FileNode[]> {
  const r = checkRel(rel)
  await resolveInside(ctx.root, r)
  const entries = await readIgnoredDir(ctx, r)
  return entries
    .map((e): FileNode => ({
      name: e.path.slice(e.path.lastIndexOf("/") + 1),
      path: e.path,
      type: e.type,
      ignored: true,
      ...(e.lazy ? { lazy: true } : {}),
      ...(e.symlink ? { symlink: true } : {}),
    }))
    .sort(byName)
}

// パス入力のサジェスト (worktree の中)。dir は "" か末尾 / 付き
export async function listDir(ctx: WtCtx, dir: string): Promise<PathEntry[]> {
  const rel = checkRel(dir.replace(/\/+$/, ""), true)
  const abs = await resolveInside(ctx.root, rel, { allowRoot: true })
  const dirents = await readdir(abs, { withFileTypes: true }).catch(() => [])
  const items = dirents
    .map((d) => ({ name: d.name, kind: (d.isDirectory() ? "dir" : "file") as PathEntry["kind"], p: rel ? `${rel}/${d.name}` : d.name }))
    .filter((e) => !matchesAny(e.p, ctx.excludes))
  if (!items.length) return []
  const input = items.map((e) => (e.kind === "dir" ? e.p + "/" : e.p)).join("\0")
  const r = await git(ctx, ["check-ignore", "--stdin", "-z"], { input, ok: [0, 1] })
  const ignored = new Set(r.stdout.toString("utf8").split("\0").map((p) => p.replace(/\/$/, "")))
  return items.map((e) => ({ name: e.name, kind: e.kind, badges: ignored.has(e.p) ? ["gitignore"] : undefined }))
}

// ---------------------------------------------------------------------------
// 内容
// ---------------------------------------------------------------------------

const MAX_TEXT = 5 * 1024 * 1024
const MAX_HIGHLIGHT = 1024 * 1024

export async function readContent(ctx: WtCtx, rel: string): Promise<FileContent> {
  const abs = await resolveInside(ctx.root, rel, { followLinks: false })
  let st = await lstat(abs).catch(() => null)
  if (!st) throw notFound("ファイルが見つかりません (削除されたか、名前が変わりました)")
  let target = abs
  if (st.isSymbolicLink()) {
    const link = await readlink(abs)
    const real = await realpath(abs).catch(() => null)
    const outside = !real || !isInside(await realpath(ctx.root), real)
    if (outside) return { kind: "symlink", target: link, outside: !!real || !isInside(ctx.root, path.resolve(path.dirname(abs), link)) }
    target = real
    st = await stat(real)
  }
  if (st.isDirectory()) throw new ApiError("INVALID_PATH", "ディレクトリです")
  if (IMAGE_EXT.test(rel)) return { kind: "image", size: st.size }
  if (st.size > MAX_TEXT) return { kind: "too-large", size: st.size }
  const buf = await readFile(target)
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", size: st.size }
  let invalidUtf8 = false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    invalidUtf8 = true
  }
  const content = new TextDecoder("utf-8").decode(buf)
  let lines = 0
  for (let i = 0; i < content.length && lines <= 5000; i++) if (content.charCodeAt(i) === 10) lines++
  const highlight = st.size <= MAX_HIGHLIGHT && content.length <= 200_000 && lines <= 5000
  return { kind: "text", content, size: st.size, highlight, invalidUtf8: invalidUtf8 || undefined }
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
}

// ファイルのバイト列。worktree の中の HTML や SVG が sherpa の画面として動かないよう、sandbox の CSP を付ける
export async function rawFile(ctx: WtCtx, rel: string, rev: string | null): Promise<Response> {
  const r = checkRel(rel)
  let body: Buffer
  if (rev) body = await catBlob(ctx, rev, r)
  else {
    const abs = await resolveInside(ctx.root, r)
    const st = await stat(abs).catch(() => null)
    if (!st?.isFile()) throw notFound("ファイルが見つかりません")
    if (st.size > 50 * 1024 * 1024) throw new ApiError("INVALID_REQUEST", "大きすぎるため表示しません")
    body = await readFile(abs)
  }
  const ext = r.split(".").pop()?.toLowerCase() ?? ""
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "no-store",
    },
  })
}

// HTML のプレビューで返す型 (画像に加えて、ページを組み立てるもの)。ほかは application/octet-stream
const PREVIEW_MIME: Record<string, string> = {
  ...MIME,
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
}

// HTML のプレビュー (…/preview/<path>)。相対パスの CSS・画像・スクリプトも同じ形で読めるよう、パスを URL のパスで受ける。
// sandbox allow-scripts の CSP で、スクリプトは動くが sherpa と別の origin になる (sherpa の API を読めない。security.md §6)
export async function previewFile(ctx: WtCtx, rel: string): Promise<Response> {
  const r = checkRel(rel)
  const abs = await resolveInside(ctx.root, r)
  const st = await stat(abs).catch(() => null)
  if (!st?.isFile()) throw notFound("ファイルが見つかりません")
  if (st.size > 50 * 1024 * 1024) throw new ApiError("INVALID_REQUEST", "大きすぎるため表示しません")
  const body = await readFile(abs)
  const ext = r.split(".").pop()?.toLowerCase() ?? ""
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": PREVIEW_MIME[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox allow-scripts",
      "Cache-Control": "no-store",
    },
  })
}

// ---------------------------------------------------------------------------
// SPEC
// ---------------------------------------------------------------------------

const MAX_SPEC = 5000

export async function listSpec(ctx: WtCtx, input: string): Promise<SpecResult> {
  const patterns = parseSpecPaths(input)
  if (!patterns.length) return { nodes: [], count: 0, truncated: false }
  const bases = [...new Set(patterns.map(specBaseDir))].filter((b, _, all) => !all.some((o) => o !== b && (o === "" || b.startsWith(o + "/"))))
  const found = new Set<string>()
  let visited = 0
  let truncated = false
  const walk = async (rel: string) => {
    if (truncated) return
    if (++visited > 20_000) {
      truncated = true
      return
    }
    const dirents = await readdir(path.join(ctx.root, rel), { withFileTypes: true }).catch(() => [])
    for (const d of dirents) {
      const p = rel ? `${rel}/${d.name}` : d.name
      if (matchesAny(p, ctx.excludes)) continue
      if (d.isDirectory()) await walk(p)
      else if (d.isFile() && isSpec(p, patterns, ctx.excludes)) {
        found.add(p)
        if (found.size >= MAX_SPEC) {
          truncated = true
          return
        }
      }
    }
  }
  for (const b of bases) {
    try {
      const rel = checkRel(b, true)
      const abs = await resolveInside(ctx.root, rel, { allowRoot: true })
      const st = await stat(abs).catch(() => null)
      if (st?.isDirectory()) await walk(rel)
      else if (st?.isFile() && isSpec(rel, patterns, ctx.excludes)) found.add(rel)
    } catch {
      // 正しくないパターンは無視する
    }
  }
  const files = [...found].sort()
  return { nodes: buildTree(files.map((p) => ({ path: p, type: "file" }))), count: files.length, truncated }
}
