import { matchesAny, parseSearchGlobs } from "@/lib/glob"
import { buildMatcher, type SearchOptions } from "@/lib/search"
import type { ContentSearchResult, NameSearchResult, SearchHit } from "@/lib/types"
import { ApiError } from "./errors"
import { rgPath, run } from "./exec"
import { visiblePaths } from "./files"
import { parseRgLine } from "./git-parse"
import type { WtCtx } from "./projects"

// 検索 (docs/architecture/search.md)

export type SearchParams = SearchOptions & { q: string; include: string; exclude: string; ignored: boolean }

const MAX_HITS = 2000
const MAX_FILES = 5000

function scope(ctx: WtCtx, p: SearchParams) {
  const include = parseSearchGlobs(p.include)
  const exclude = parseSearchGlobs(p.exclude)
  const inScope = (path: string) =>
    !matchesAny(path, ctx.excludes) && (!include.length || matchesAny(path, include)) && !(exclude.length && matchesAny(path, exclude))
  // rg に渡す -g (余計な列挙をさせないための前処理。正は inScope)
  const globs = [...ctx.excludes.map((g) => `!${g}`), ...include, ...exclude.map((g) => `!${g}`)].flatMap((g) => ["-g", g])
  return { inScope, globs }
}

async function rg(args: string[], ctx: WtCtx, onLine: (line: string) => boolean | void) {
  try {
    return await run(rgPath(), args, { cwd: ctx.root, timeout: 20_000, onLine })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError("RG_NOT_FOUND", "ripgrep (rg) が見つかりません", 500)
    throw e
  }
}

export async function searchContent(ctx: WtCtx, p: SearchParams): Promise<ContentSearchResult> {
  if (!p.q) return { hits: [], truncated: false }
  const { inScope, globs } = scope(ctx, p)
  const args = [
    "--json",
    "--line-number",
    "--no-config",
    "--hidden",
    "--engine",
    "auto",
    "--max-count",
    "100",
    "--max-filesize",
    "2M",
    "--max-columns",
    "1000",
    "--max-columns-preview",
    p.caseSensitive ? "-s" : "-i",
    ...(p.regex ? [] : ["-F"]),
    ...(p.ignored ? ["--no-ignore"] : []),
    ...globs,
    "-e",
    p.q,
    ".",
  ]
  const hits: SearchHit[] = []
  let truncated = false
  const r = await rg(args, ctx, (line) => {
    const h = parseRgLine(line)
    if (!h || !inScope(h.path)) return
    hits.push(h)
    if (hits.length >= MAX_HITS) {
      truncated = true
      return false
    }
  })
  if (r.code === 2 && /regex|parse error/i.test(r.stderr)) throw new ApiError("INVALID_REGEX", "正規表現が正しくありません")
  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
  return { hits, truncated: truncated || r.truncated }
}

// ファイル名の検索 (「gitignore」ON のとき。無視されたファイルも含める)
export async function searchNames(ctx: WtCtx, p: SearchParams): Promise<NameSearchResult> {
  const matcher = buildMatcher(p.q, p)
  if (!matcher) return { files: [], truncated: false }
  if ("error" in matcher) throw new ApiError("INVALID_REGEX", matcher.error)
  const { inScope, globs } = scope(ctx, p)
  const visible = new Set(await visiblePaths(ctx))
  const files: NameSearchResult["files"] = []
  let truncated = false
  const r = await rg(["--files", "--no-config", "--hidden", ...(p.ignored ? ["--no-ignore"] : []), ...globs, "."], ctx, (line) => {
    const path = line.replace(/^\.\//, "")
    if (!path || !inScope(path)) return
    if (!matcher.find(path.slice(path.lastIndexOf("/") + 1)).length) return
    files.push({ path, ignored: !visible.has(path) })
    if (files.length >= MAX_FILES) {
      truncated = true
      return false
    }
  })
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, truncated: truncated || r.truncated }
}
