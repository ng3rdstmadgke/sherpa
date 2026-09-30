import { describe, expect, it } from "vitest"
import { globToRegExp, matchesAny, parseSearchGlobs } from "@/lib/glob"
import { isSpec, parseSpecPaths, specBaseDir } from "@/lib/spec"
import { buildMatcher } from "@/lib/search"
import { relTime, formatSize } from "@/lib/format"
import { checkRequest, hostname, isPreviewRequest } from "@/lib/request-guard"
import { DEFAULT_EXCLUDES, parseExcludeLines } from "@/lib/excludes"
import { buildMarkdownDiff, diffSides, withinHighlightLimit, type MdNode } from "@/lib/diff"
import type { DiffLine } from "@/lib/types"
import { createSlugger } from "@/lib/slug"
import { closeAllTabs, createLayout, findGroup, groups, moveTab, openTab } from "@/components/workspace/editor-layout"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"

describe("glob", () => {
  it("** は 0 個以上のディレクトリ、* は / をまたがない", () => {
    expect(globToRegExp("**/node_modules/**").test("node_modules/a.js")).toBe(true)
    expect(globToRegExp("**/node_modules/**").test("app/node_modules/x/a.js")).toBe(true)
    expect(globToRegExp("*.md").test("a.md")).toBe(true)
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false)
    expect(globToRegExp("**/*.md").test("docs/a.md")).toBe(true)
    expect(globToRegExp("docs/*").test("docs/a/b.md")).toBe(false)
    expect(globToRegExp("a.b").test("axb")).toBe(false)
  })
  it("matchesAny はディレクトリ (末尾 / 付き) にも当てる", () => {
    expect(matchesAny("app/node_modules", DEFAULT_EXCLUDES)).toBe(true)
    expect(matchesAny("tmp", ["tmp/**"])).toBe(true)
    expect(matchesAny("src/a.ts", DEFAULT_EXCLUDES)).toBe(false)
    expect(matchesAny("x/.terraform/modules", DEFAULT_EXCLUDES)).toBe(true)
  })
  it("parseSearchGlobs: / のないものはどの階層にも、ディレクトリはその下すべてに当てはまる", () => {
    const g = parseSearchGlobs("*.md, docs/adr/, ./tmp")
    expect(g).toEqual(["**/*.md", "**/*.md/**", "docs/adr", "docs/adr/**", "**/tmp", "**/tmp/**"])
    expect(matchesAny("a/b/c.md", g)).toBe(true)
    expect(matchesAny("docs/adr/0001.txt", g)).toBe(true)
    expect(matchesAny("x/tmp/y.log", g)).toBe(true)
    expect(matchesAny("src/a.ts", g)).toBe(false)
    expect(parseSearchGlobs("  ,  ")).toEqual([])
  })
})

describe("spec", () => {
  it("parseSpecPaths", () => {
    expect(parseSpecPaths("agent-tasks/x/*, ./docs/superpowers, a/b.md, c/**/*.md")).toEqual(["agent-tasks/x/**", "docs/superpowers/**", "a/b.md", "c/**/*.md"])
    expect(parseSpecPaths("")).toEqual([])
  })
  it("isSpec は .md で、除外パターンに当たらないもの", () => {
    const p = parseSpecPaths("agent-tasks/*")
    expect(isSpec("agent-tasks/f/spec.md", p, DEFAULT_EXCLUDES)).toBe(true)
    expect(isSpec("agent-tasks/f/spec.txt", p, DEFAULT_EXCLUDES)).toBe(false)
    expect(isSpec("agent-tasks/node_modules/x.md", p, DEFAULT_EXCLUDES)).toBe(false)
    expect(isSpec("docs/a.md", p, DEFAULT_EXCLUDES)).toBe(false)
  })
  it("specBaseDir はワイルドカードより前のディレクトリ", () => {
    expect(specBaseDir("agent-tasks/feature/x/**")).toBe("agent-tasks/feature/x")
    expect(specBaseDir("**/*.md")).toBe("")
    expect(specBaseDir("docs/a.md")).toBe("docs")
    expect(specBaseDir("a.md")).toBe("")
  })
  it("parseExcludeLines", () => {
    expect(parseExcludeLines(" a/**\n\n b \n")).toEqual(["a/**", "b"])
  })
})

describe("buildMatcher", () => {
  const find = (q: string, o: Partial<{ caseSensitive: boolean; regex: boolean }>, text: string) => {
    const m = buildMatcher(q, { caseSensitive: false, regex: false, ...o })
    if (!m || "error" in m) throw new Error("no matcher")
    return m.find(text)
  }
  it("空は null、正しくない正規表現はエラー", () => {
    expect(buildMatcher("", { caseSensitive: false, regex: false })).toBeNull()
    expect(buildMatcher("(", { caseSensitive: false, regex: true })).toEqual({ error: "正規表現が正しくありません" })
  })
  it("大文字小文字・正規表現・記号のエスケープ", () => {
    expect(find("abc", {}, "ABC abc")).toHaveLength(2)
    expect(find("abc", { caseSensitive: true }, "ABC abc")).toEqual([{ start: 4, end: 7 }])
    expect(find("a.c", {}, "abc a.c")).toEqual([{ start: 4, end: 7 }])
    expect(find("a.c", { regex: true }, "abc a.c")).toHaveLength(2)
  })
  it("空文字に一致する正規表現で止まらない", () => {
    expect(find("x*", { regex: true }, "abx")).toEqual([{ start: 2, end: 3 }])
  })
})

describe("format", () => {
  const now = new Date("2026-09-27T12:00:00Z").getTime()
  const ago = (sec: number) => new Date(now - sec * 1000).toISOString()
  it("relTime", () => {
    expect(relTime(ago(10), now)).toBe("たった今")
    expect(relTime(ago(5 * 60), now)).toBe("5分前")
    expect(relTime(ago(2 * 3600), now)).toBe("2時間前")
    expect(relTime(ago(30 * 3600), now)).toBe("昨日")
    expect(relTime(ago(3 * 86400), now)).toBe("3日前")
    expect(relTime(ago(14 * 86400), now)).toBe("2週間前")
    expect(relTime(ago(60 * 86400), now)).toBe("2か月前")
    expect(relTime(ago(800 * 86400), now)).toBe("2年前")
    expect(relTime("", now)).toBe("")
    expect(relTime("not-a-date", now)).toBe("")
  })
  it("formatSize", () => {
    expect(formatSize(10)).toBe("10 B")
    expect(formatSize(2048)).toBe("2 KB")
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
  })
})

describe("display", () => {
  it("フォントサイズは 10〜24 の整数にし、数でなければ既定値", async () => {
    const { normalizeFontSize, normalizeDisplay, displayCssVars, DISPLAY_DEFAULTS } = await import("@/lib/display")
    expect(normalizeFontSize(15, 13)).toBe(15)
    expect(normalizeFontSize("16", 13)).toBe(16)
    expect(normalizeFontSize(8, 13)).toBe(10)
    expect(normalizeFontSize(99, 13)).toBe(24)
    expect(normalizeFontSize(13.6, 13)).toBe(14)
    expect(normalizeFontSize("abc", 13)).toBe(13)
    expect(normalizeFontSize("", 13)).toBe(13)
    expect(normalizeDisplay(undefined)).toEqual(DISPLAY_DEFAULTS)
    expect(displayCssVars({ codeFontSize: 15, markdownFontSize: 18 })).toEqual({ "--sherpa-code-font-size": "15px", "--sherpa-markdown-font-size": "18px" })
  })
})

describe("request-guard", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null })
  it("hostname はポートを外す", () => {
    expect(hostname("localhost:4800")).toBe("localhost")
    expect(hostname("[::1]:4747")).toBe("[::1]")
    expect(hostname("127.0.0.1")).toBe("127.0.0.1")
  })
  it("Host が 127.0.0.1 / localhost / [::1] 以外は 421", () => {
    expect(checkRequest("GET", h({ host: "evil.example" }))?.status).toBe(421)
    expect(checkRequest("GET", h({ host: "evil.example:4747" }))?.status).toBe(421)
    expect(checkRequest("GET", h({}))?.status).toBe(421)
    expect(checkRequest("GET", h({ host: "localhost:4800" }))).toBeNull()
    expect(checkRequest("GET", h({ host: "127.0.0.1:4747" }))).toBeNull()
    expect(checkRequest("GET", h({ host: "[::1]:4747" }))).toBeNull()
  })
  it("cross-site は 403", () => {
    expect(checkRequest("GET", h({ host: "localhost:4747", "sec-fetch-site": "cross-site" }))?.status).toBe(403)
    expect(checkRequest("GET", h({ host: "localhost:4747", "sec-fetch-site": "same-origin" }))).toBeNull()
  })
  it("HTML のプレビュー (preview/<合言葉>/<path>) の GET / HEAD だけは cross-site でも通す (合言葉は Route Handler で確かめる)", () => {
    const cross = h({ host: "localhost:4747", "sec-fetch-site": "cross-site" })
    expect(checkRequest("GET", cross, "/api/projects/proj/worktrees/main/preview/tok/docs/style.css")).toBeNull()
    expect(isPreviewRequest("HEAD", "/api/projects/proj/worktrees/main/preview/tok/index.html")).toBe(true)
    // 合言葉とパスのないもの・プレビューでない API・GET / HEAD 以外は断る
    expect(checkRequest("GET", cross, "/api/projects/proj/worktrees/main/preview/tok")?.status).toBe(403)
    expect(checkRequest("GET", cross, "/api/projects/proj/worktrees/main/preview-token")?.status).toBe(403)
    expect(checkRequest("GET", cross, "/api/projects/proj/worktrees/main/raw")?.status).toBe(403)
    expect(checkRequest("GET", cross, "/")?.status).toBe(403)
    expect(isPreviewRequest("POST", "/api/projects/proj/worktrees/main/preview/tok/index.html")).toBe(false)
  })
  it("書き込みは JSON だけ、Origin はローカルだけ", () => {
    expect(checkRequest("POST", h({ host: "localhost:4747" }))?.status).toBe(415)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "text/plain" }))?.status).toBe(415)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "application/json" }))).toBeNull()
    expect(checkRequest("PUT", h({ host: "localhost:4747", "content-type": "application/json; charset=utf-8", origin: "http://localhost:4800" }))).toBeNull()
    expect(checkRequest("DELETE", h({ host: "localhost:4747", "content-type": "application/json", origin: "http://evil.example" }))?.status).toBe(403)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "application/json", origin: "null" }))?.status).toBe(403)
  })
})

// git の unified diff と同じ形 (" " / "-" / "+" で始まる行) から DiffLine[] を作る
function diffLines(spec: string[]): DiffLine[] {
  let o = 0
  let n = 0
  return spec.map((s) => {
    const text = s.slice(1)
    if (s[0] === "-") return { type: "del", text, oldNo: ++o }
    if (s[0] === "+") return { type: "add", text, newNo: ++n }
    return { type: "ctx", text, oldNo: ++o, newNo: ++n }
  })
}

// 印を付けた木を「種類[class] テキスト」の並びにする (比べやすくするため)
function outline(nodes: MdNode[]): string[] {
  const text = (n: MdNode): string => ("value" in n ? String(n.value) : (n.children ?? []).map(text).join(""))
  return nodes.map((n) => {
    const cls = (n.data?.hProperties as { className?: string[] } | undefined)?.className?.join(" ")
    if (n.type === "mdDiff") return `${outline(n.children ?? []).join(" ")}[${cls}]`
    const inner = n.children?.find((c) => c.type === "mdDiff")?.data?.hProperties as { className?: string[] } | undefined
    const mark = cls ?? inner?.className?.join(" ")
    return `${n.type}${mark ? `[${mark}]` : ""}:${text(n)}`
  })
}

function markdownDiff(spec: string[], side?: "both" | "before" | "after") {
  const lines = diffLines(spec)
  const { before, after } = diffSides(lines)
  const md = unified().use(remarkParse).use(remarkGfm)
  return buildMarkdownDiff(md.parse(before.join("\n")) as MdNode, md.parse(after.join("\n")) as MdNode, lines, before, after, side)
}

describe("diff", () => {
  it("diffSides は変更前と変更後の行に分ける", () => {
    expect(diffSides(diffLines([" a", "-b", "+B", " c"]))).toEqual({ before: ["a", "b", "c"], after: ["a", "B", "c"] })
  })
  it("withinHighlightLimit は 5,000 行・20 万文字まで", () => {
    expect(withinHighlightLimit(new Array(5000).fill("x"))).toBe(true)
    expect(withinHighlightLimit(new Array(5001).fill("x"))).toBe(false)
    expect(withinHighlightLimit(["x".repeat(200_000)])).toBe(false)
  })
})

describe("Markdown のプレビューの差分", () => {
  it("変わった段落は、変更前を削除・変更後を追加にし、変わらないまとまりはそのまま", () => {
    const t = markdownDiff([" # T", " ", "-東京のみ。", "+東京と韓国。", " ", " 本文"])
    expect(outline(t.children!)).toEqual(["heading:T", "paragraph[md-diff-del]:東京のみ。", "paragraph[md-diff-add]:東京と韓国。", "paragraph:本文"])
  })
  it("リストと表は、項目・行ごとに印を付ける", () => {
    const list = markdownDiff([" - a", "-- b", "+- B", " - c", "+- d"])
    expect(outline(list.children![0].children!)).toEqual(["listItem:a", "listItem[md-diff-del]:b", "listItem[md-diff-add]:B", "listItem:c", "listItem[md-diff-add]:d"])
    const table = markdownDiff([" | a | b |", " | - | - |", " | 1 | 2 |", "-| 3 | 4 |", "+| 5 | 6 |"])
    expect(outline(table.children![0].children!)).toEqual(["tableRow:ab", "tableRow:12", "tableRow[md-diff-del]:34", "tableRow[md-diff-add]:56"])
  })
  it("表の見出しが変わったときは、表ごとに入れ替える", () => {
    const t = markdownDiff(["-| a | b |", "+| A | b |", " | - | - |", " | 1 | 2 |"])
    expect(outline(t.children!)).toEqual(["table:ab12[md-diff-del]", "table:Ab12[md-diff-add]"])
  })
  it("空の行を足して段落を分けたときも、変わったことにする", () => {
    const t = markdownDiff([" one", "+", " two"])
    expect(outline(t.children!)).toEqual(["paragraph[md-diff-del]:one\ntwo", "paragraph[md-diff-add]:one", "paragraph[md-diff-add]:two"])
  })
  it("タスクリストのチェックが変わった項目は、項目ごと (class は task-list-item を残す)", () => {
    const t = markdownDiff(["-- [ ] x", "+- [x] x", " - [ ] y"])
    expect(outline(t.children![0].children!)).toEqual(["listItem[task-list-item md-diff-del]:x", "listItem[task-list-item md-diff-add]:x", "listItem:y"])
  })
})

describe("Markdown のプレビューの差分 (Split)", () => {
  const spec = [" # T", "-東京のみ。", "+東京と韓国。", "+", "+追加", " ", " 本文"]
  it("左 (before) は削除の印のもの、右 (after) は追加の印のものだけを残す", () => {
    expect(outline(markdownDiff(spec, "before").children!)).toEqual(["heading:T", "paragraph[md-diff-del]:東京のみ。", "paragraph:本文"])
    expect(outline(markdownDiff(spec, "after").children!)).toEqual(["heading:T", "paragraph[md-diff-add]:東京と韓国。", "paragraph[md-diff-add]:追加", "paragraph:本文"])
  })
})

describe("すべてのタブを閉じる", () => {
  it("分割したグループもなくし、空のグループ 1 つに戻す", () => {
    let l = openTab(createLayout(), { kind: "file", path: "a.md" })
    l = openTab(l, { kind: "file", path: "b.md" })
    l = moveTab(l, { kind: "file", path: "b.md" }, l.activeGroupId, l.activeGroupId, "right")
    expect(groups(l.root)).toHaveLength(2)
    const closed = closeAllTabs()
    expect(groups(closed.root)).toHaveLength(1)
    expect(groups(closed.root)[0].tabs).toEqual([])
    expect(closed.activeGroupId).toBe(groups(closed.root)[0].id)
  })
})

describe("タブの表示のしかた", () => {
  const groupOf = (l: ReturnType<typeof createLayout>) => findGroup(l.root, l.activeGroupId)!
  it("表示のしかたはグループの中のタブで共有する。rev はタブごと", () => {
    let l = openTab(createLayout(), { kind: "file", path: "a.md", display: "diff", format: "split", md: "source" })
    l = openTab(l, { kind: "file", path: "b.md" })
    expect(groupOf(l).view).toEqual({ display: "diff", format: "split", md: "source" })
    expect(groupOf(l).tabs).toEqual([
      { kind: "file", path: "a.md" },
      { kind: "file", path: "b.md" },
    ])
    // 行を指定して開くと、グループの表示を変える
    l = openTab(l, { kind: "file", path: "a.md", line: 3, display: "file", md: "source" })
    expect(groupOf(l).view).toEqual({ display: "file", format: "split", md: "source" })
    // undefined は既定に戻す
    l = openTab(l, { kind: "file", path: "a.md", history: true, rev: "abc1234" })
    l = openTab(l, { kind: "file", path: "b.md", format: undefined })
    expect(groupOf(l).view).toEqual({ display: "file", md: "source", history: true })
    // rev は開き直しても引き継ぎ、表示を指定したらやめる
    l = openTab(l, { kind: "file", path: "a.md" })
    expect(groupOf(l).tabs[0]).toEqual({ kind: "file", path: "a.md", rev: "abc1234" })
    l = openTab(l, { kind: "file", path: "a.md", display: "diff" })
    expect(groupOf(l).tabs[0]).toEqual({ kind: "file", path: "a.md" })
  })
  it("分割して作ったグループは元の表示を引き継ぎ、移したタブは移した先に従う", () => {
    let l = openTab(createLayout(), { kind: "file", path: "a.md", md: "source" })
    l = openTab(l, { kind: "file", path: "b.md" })
    const first = l.activeGroupId
    l = moveTab(l, { kind: "file", path: "b.md" }, first, first, "right")
    expect(groupOf(l).view).toEqual({ md: "source" })
    l = openTab(l, { kind: "file", path: "b.md", md: "preview" })
    expect(findGroup(l.root, first)!.view).toEqual({ md: "source" })
    l = moveTab(l, { kind: "file", path: "a.md" }, first, l.activeGroupId, "center")
    expect(groups(l.root)).toHaveLength(1)
    expect(groupOf(l).view).toEqual({ md: "preview" })
  })
})

describe("見出しのリンク先の名前 (GitHub と同じ)", () => {
  it("小文字にし、記号を消して、空白を - にする。日本語はそのまま", () => {
    const slug = createSlugger()
    expect(slug("1. 背景")).toBe("1-背景")
    expect(slug("Hello, World!")).toBe("hello-world")
    expect(slug("API の `raw` (GET)")).toBe("api-の-raw-get")
    expect(slug("snake_case と kebab-case")).toBe("snake_case-と-kebab-case")
    expect(slug("ファイル (エクスプローラ・SPEC・表示)")).toBe("ファイル-エクスプローラspec表示")
  })
  it("同じ名前は 2 つ目から -1, -2 を付ける", () => {
    const slug = createSlugger()
    expect([slug("概要"), slug("概要"), slug("概要"), slug("概要-1")]).toEqual(["概要", "概要-1", "概要-2", "概要-1-1"])
  })
})
