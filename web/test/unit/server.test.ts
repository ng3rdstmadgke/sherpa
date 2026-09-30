import { describe, expect, it } from "vitest"
import { byteToUtf16, parseFileLog, parseForEachRef, parseLog, parseRawNumstat, parseRgLine, parseUnifiedDiff } from "@/server/git-parse"
import { checkRel, isInside } from "@/server/paths"
import { mapPath, parseGitFile } from "@/server/worktrees"
import { buildTree, excludePathspecs } from "@/server/files"

describe("parseRawNumstat", () => {
  it("変更・追加・削除・名前の変更・バイナリ・日本語とスペースのパス", () => {
    const out = [
      ":100644 100644 aaa bbb M",
      "src/a.ts",
      ":000000 100644 000 ccc A",
      "docs/メモ v2.md",
      ":100644 000000 ddd 000 D",
      "old.txt",
      ":100644 100644 eee fff R087",
      "from/x.ts",
      "to/y.ts",
      ":100644 100644 111 222 M",
      "img.png",
      "3\t1\tsrc/a.ts",
      "5\t0\tdocs/メモ v2.md",
      "0\t2\told.txt",
      "1\t1\t",
      "from/x.ts",
      "to/y.ts",
      "-\t-\timg.png",
      "",
    ].join("\0")
    const c = parseRawNumstat(out)
    expect(c).toEqual([
      { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
      { path: "docs/メモ v2.md", status: "A", additions: 5, deletions: 0 },
      { path: "old.txt", status: "D", additions: 0, deletions: 2 },
      { path: "to/y.ts", oldPath: "from/x.ts", status: "R", additions: 1, deletions: 1 },
      { path: "img.png", status: "M", additions: 0, deletions: 0, binary: true },
    ])
  })
  it("空の出力", () => {
    expect(parseRawNumstat("")).toEqual([])
  })
  it("T と U (コンフリクト) は M", () => {
    expect(parseRawNumstat(":120000 100644 a b T\0x\0:100644 100644 a b U\0y\0")).toEqual([
      { path: "x", status: "M", additions: 0, deletions: 0 },
      { path: "y", status: "M", additions: 0, deletions: 0 },
    ])
  })
})

describe("parseForEachRef", () => {
  it("symref (origin/HEAD) は除く", () => {
    const out = [
      "refs/heads/main\0main\0" + "2026-09-01T00:00:00+09:00\0",
      "refs/remotes/upstream/HEAD\0upstream/HEAD\0" + "2026-09-01T00:00:00+09:00\0refs/remotes/upstream/main",
      "refs/remotes/upstream/main\0upstream/main\0" + "2026-09-02T00:00:00+09:00\0",
      "",
    ].join("\n")
    expect(parseForEachRef(out)).toEqual([
      { name: "main", ref: "refs/heads/main", remote: false, date: "2026-09-01T00:00:00+09:00" },
      { name: "upstream/main", ref: "refs/remotes/upstream/main", remote: true, date: "2026-09-02T00:00:00+09:00" },
    ])
  })
})

describe("parseFileLog", () => {
  it("-z の --raw --numstat から、そのファイルの変更 (名前の変更を含む) を取る", () => {
    const head = (h: string, subject: string) => `\x1e${h}\x1f${h.slice(0, 7)}\x1f${"0".repeat(40)}\x1fClaude\x1f2026-09-27T10:00:00+09:00\x1f${subject}\x1f\x1d\0\n`
    const out =
      head("a".repeat(40), "変更") +
      [":100644 100644 aaa bbb M", "docs/new name.md", "2\t1\tdocs/new name.md", ""].join("\0") +
      head("b".repeat(40), "名前を変える") +
      [":100644 100644 ccc ddd R090", "docs/old.md", "docs/new name.md", "1\t1\t", "docs/old.md", "docs/new name.md", ""].join("\0")
    const c = parseFileLog(out)
    expect(c.map((x) => x.message)).toEqual(["変更", "名前を変える"])
    expect(c[0].change).toEqual({ path: "docs/new name.md", status: "M", additions: 2, deletions: 1 })
    expect(c[1].change).toEqual({ path: "docs/new name.md", oldPath: "docs/old.md", status: "R", additions: 1, deletions: 1 })
  })
})

describe("parseLog", () => {
  it("--shortstat の件数と本文、マージ (親 2 つ)", () => {
    const rec = (h: string, parents: string, subject: string, body: string, stat: string) =>
      `\x1e${h}\x1f${h.slice(0, 7)}\x1f${parents}\x1fClaude\x1f2026-09-27T10:00:00+09:00\x1f${subject}\x1f${body}\x1d\n${stat}\n`
    const out =
      rec("a".repeat(40), "b".repeat(40), "ref #33 日本語の件名", "本文の 1 行目\n2 行目\n", "\n 2 files changed, 10 insertions(+), 1 deletion(-)") +
      rec("c".repeat(40), `${"d".repeat(40)} ${"e".repeat(40)}`, "Merge", "", "\n 1 file changed, 1 insertion(+)") +
      rec("f".repeat(40), "", "root", "", "")
    const c = parseLog(out)
    expect(c).toHaveLength(3)
    expect(c[0]).toMatchObject({ shortHash: "aaaaaaa", message: "ref #33 日本語の件名", body: "本文の 1 行目\n2 行目", fileCount: 2, author: "Claude" })
    expect(c[1].parents).toHaveLength(2)
    expect(c[1].fileCount).toBe(1)
    expect(c[2]).toMatchObject({ parents: [], fileCount: 0 })
  })
})

describe("parseUnifiedDiff", () => {
  it("全行を含む差分を DiffLine にする", () => {
    const out = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "\\ No newline at end of file",
      "",
    ].join("\n")
    const r = parseUnifiedDiff(out)
    expect(r.binary).toBe(false)
    expect(r.empty).toBe(false)
    expect(r.lines).toEqual([
      { type: "ctx", text: "one", oldNo: 1, newNo: 1 },
      { type: "del", text: "two", oldNo: 2 },
      { type: "add", text: "TWO", newNo: 2 },
      { type: "ctx", text: "three", oldNo: 3, newNo: 3 },
    ])
  })
  it("複数の hunk (-U3) は行番号を振り直す", () => {
    const out = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,2 @@\n c\n+d\n"
    const r = parseUnifiedDiff(out)
    expect(r.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["del", 1, undefined],
      ["add", undefined, 1],
      ["ctx", 10, 10],
      ["add", undefined, 11],
    ])
  })
  it("新規ファイル (-0,0) と空行の文脈行", () => {
    const out = "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+\n"
    expect(parseUnifiedDiff(out).lines).toEqual([
      { type: "add", text: "x", newNo: 1 },
      { type: "add", text: "", newNo: 2 },
    ])
  })
  it("バイナリと空", () => {
    expect(parseUnifiedDiff("diff --git a/p.png b/p.png\nindex 1..2\nBinary files a/p.png and b/p.png differ\n").binary).toBe(true)
    expect(parseUnifiedDiff("")).toEqual({ lines: [], binary: false, empty: true })
  })
})

describe("rg の出力", () => {
  it("byteToUtf16: 日本語 (3 バイト) と絵文字 (4 バイト、サロゲートペア)", () => {
    const t = "日本語 test 😀x"
    expect(byteToUtf16(t, 0)).toBe(0)
    expect(byteToUtf16(t, 9)).toBe(3)
    expect(byteToUtf16(t, 10)).toBe(4)
    // "日本語 test " = 9 + 6 = 15 バイト、😀 = 4 バイト
    expect(byteToUtf16(t, 19)).toBe(t.indexOf("x"))
  })
  it("parseRgLine: match の行だけを SearchHit にする", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "./docs/日本.md" },
        lines: { text: "日本語のテスト test\n" },
        line_number: 3,
        submatches: [{ match: { text: "test" }, start: 22, end: 26 }],
      },
    })
    expect(parseRgLine(line)).toEqual({ path: "docs/日本.md", line: 3, text: "日本語のテスト test", matches: [{ start: 8, end: 12 }] })
    expect(parseRgLine('{"type":"begin","data":{}}')).toBeNull()
    expect(parseRgLine('{"type":"match", broken')).toBeNull()
  })
  it("parseRgLine: UTF-8 でないパスは bytes (base64)", () => {
    const line = JSON.stringify({
      type: "match",
      data: { path: { bytes: Buffer.from("a/b.txt").toString("base64") }, lines: { text: "x\r\n" }, line_number: 1, submatches: [{ start: 0, end: 1 }] },
    })
    expect(parseRgLine(line)).toEqual({ path: "a/b.txt", line: 1, text: "x", matches: [{ start: 0, end: 1 }] })
  })
})

describe("paths", () => {
  it("checkRel は .. / 絶対パス / \\0 を断る", () => {
    expect(checkRel("a/b.txt")).toBe("a/b.txt")
    expect(checkRel("a/b/")).toBe("a/b")
    expect(checkRel("", true)).toBe("")
    for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "a\0b", "a//b", "./a", "a\\b"]) expect(() => checkRel(bad)).toThrow()
  })
  it("isInside", () => {
    expect(isInside("/r", "/r/a")).toBe(true)
    expect(isInside("/r", "/r")).toBe(true)
    expect(isInside("/r", "/rx/a")).toBe(false)
    expect(isInside("/r", "/x")).toBe(false)
  })
})

describe("worktrees", () => {
  const maps = [{ container: "/workspaces/webapp/", host: "/home/u/webapp" }]
  it("mapPath はコンテナ内のパスをホストのパスに読み替える", () => {
    expect(mapPath("/workspaces/webapp/.worktree/x", maps)).toBe("/home/u/webapp/.worktree/x")
    expect(mapPath("/workspaces/webapp", maps)).toBe("/home/u/webapp")
    expect(mapPath("/workspaces/webappx/a", maps)).toBe("/workspaces/webappx/a")
    expect(mapPath("/home/u/other", maps)).toBe("/home/u/other")
  })
  it("parseGitFile", () => {
    expect(parseGitFile("gitdir: /workspaces/a/.git/worktrees/x\n")).toBe("/workspaces/a/.git/worktrees/x")
    expect(parseGitFile("nothing")).toBeNull()
    expect(parseGitFile(null)).toBeNull()
  })
})

describe("files", () => {
  it("buildTree: ディレクトリを先に名前の順に並べ、lazy のディレクトリの下の行は捨てる", () => {
    const t = buildTree([
      { path: "b.txt", type: "file" },
      { path: "a/z.ts", type: "file" },
      { path: "a/node/x.js", type: "file" },
      { path: ".terraform", type: "dir", ignored: true, lazy: true },
      { path: ".terraform/modules", type: "dir", ignored: true, lazy: true },
      { path: ".terraform/modules/m.json", type: "file", ignored: true },
      { path: "tmp/memo.md", type: "file", ignored: true },
    ])
    expect(t.map((n) => n.name)).toEqual([".terraform", "a", "tmp", "b.txt"])
    expect(t[0]).toEqual({ name: ".terraform", path: ".terraform", type: "dir", ignored: true, lazy: true })
    expect(t[1].children!.map((n) => n.name)).toEqual(["node", "z.ts"])
    expect(t[2].children![0]).toEqual({ name: "memo.md", path: "tmp/memo.md", type: "file", ignored: true })
  })
  it("excludePathspecs", () => {
    expect(excludePathspecs(["**/node_modules/**"])).toEqual([":(exclude,glob)**/node_modules/**"])
  })
})
