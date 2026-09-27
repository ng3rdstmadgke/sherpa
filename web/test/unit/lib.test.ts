import { describe, expect, it } from "vitest"
import { globToRegExp, matchesAny, parseSearchGlobs } from "@/lib/glob"
import { isSpec, parseSpecPaths, specBaseDir } from "@/lib/spec"
import { buildMatcher } from "@/lib/search"
import { relTime, formatSize } from "@/lib/format"
import { checkRequest, hostname } from "@/lib/request-guard"
import { DEFAULT_EXCLUDES, parseExcludeLines } from "@/lib/excludes"

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
  const find = (q: string, o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }>, text: string) => {
    const m = buildMatcher(q, { caseSensitive: false, wholeWord: false, regex: false, ...o })
    if (!m || "error" in m) throw new Error("no matcher")
    return m.find(text)
  }
  it("空は null、正しくない正規表現はエラー", () => {
    expect(buildMatcher("", { caseSensitive: false, wholeWord: false, regex: false })).toBeNull()
    expect(buildMatcher("(", { caseSensitive: false, wholeWord: false, regex: true })).toEqual({ error: "正規表現が正しくありません" })
  })
  it("大文字小文字・正規表現・記号のエスケープ", () => {
    expect(find("abc", {}, "ABC abc")).toHaveLength(2)
    expect(find("abc", { caseSensitive: true }, "ABC abc")).toEqual([{ start: 4, end: 7 }])
    expect(find("a.c", {}, "abc a.c")).toEqual([{ start: 4, end: 7 }])
    expect(find("a.c", { regex: true }, "abc a.c")).toHaveLength(2)
  })
  it("単語単位は日本語の文字も単語の一部として扱う", () => {
    expect(find("test", { wholeWord: true }, "テストtest")).toEqual([])
    expect(find("test", { wholeWord: true }, "テスト test")).toEqual([{ start: 4, end: 8 }])
    expect(find("test", { wholeWord: true }, "test_x")).toEqual([])
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
  it("書き込みは JSON だけ、Origin はローカルだけ", () => {
    expect(checkRequest("POST", h({ host: "localhost:4747" }))?.status).toBe(415)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "text/plain" }))?.status).toBe(415)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "application/json" }))).toBeNull()
    expect(checkRequest("PUT", h({ host: "localhost:4747", "content-type": "application/json; charset=utf-8", origin: "http://localhost:4800" }))).toBeNull()
    expect(checkRequest("DELETE", h({ host: "localhost:4747", "content-type": "application/json", origin: "http://evil.example" }))?.status).toBe(403)
    expect(checkRequest("POST", h({ host: "localhost:4747", "content-type": "application/json", origin: "null" }))?.status).toBe(403)
  })
})
