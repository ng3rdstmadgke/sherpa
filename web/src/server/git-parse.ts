import type { Branch, Change, ChangeStatus, Commit, DiffLine, FileCommit, Match, SearchHit } from "@/lib/types"

// git / rg の出力のパース。純粋な関数 (単体テストの対象)

// git diff --raw --numstat -z -M の出力を Change[] にする
export function parseRawNumstat(out: string): Change[] {
  const t = out.split("\0")
  const byPath = new Map<string, Change>()
  const order: string[] = []
  let i = 0
  while (i < t.length) {
    const tok = t[i]
    if (!tok) {
      i++
      continue
    }
    if (tok.startsWith(":")) {
      // :<mode> <mode> <hash> <hash> <status>\0<path>[\0<path>]
      const letter = tok.split(" ")[4]?.[0] ?? "M"
      if (letter === "R" || letter === "C") {
        const oldPath = t[i + 1]
        const path = t[i + 2]
        add({ path, oldPath: letter === "R" ? oldPath : undefined, status: letter === "R" ? "R" : "A", additions: 0, deletions: 0 })
        i += 3
      } else {
        add({ path: t[i + 1], status: mapStatus(letter), additions: 0, deletions: 0 })
        i += 2
      }
      continue
    }
    // numstat: <add>\t<del>\t<path> か、名前の変更は <add>\t<del>\t\0<old>\0<new>
    const [a, d, p] = tok.split("\t")
    let path = p
    if (p === "") {
      path = t[i + 2]
      i += 3
    } else {
      i += 1
    }
    const c = byPath.get(path)
    if (!c) continue
    if (a === "-" && d === "-") c.binary = true
    else {
      c.additions = Number(a) || 0
      c.deletions = Number(d) || 0
    }
  }
  return order.map((p) => byPath.get(p)!)

  function add(c: Change) {
    if (!byPath.has(c.path)) order.push(c.path)
    byPath.set(c.path, c)
  }
}

function mapStatus(letter: string): ChangeStatus {
  if (letter === "A") return "A"
  if (letter === "D") return "D"
  return "M" // M / T / U (コンフリクト中) は M にする
}

// git for-each-ref --format=%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(symref)
export function parseForEachRef(out: string): Branch[] {
  const branches: Branch[] = []
  for (const line of out.split("\n")) {
    if (!line) continue
    const [ref, name, date, symref] = line.split("\0")
    if (symref) continue // origin/HEAD
    branches.push({ name, ref, remote: ref.startsWith("refs/remotes/"), date })
  }
  return branches
}

export const LOG_FORMAT = "%x1e%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%b%x1d"

// git log --format=LOG_FORMAT の 1 件を、コミットと、その後ろの出力 (--shortstat や --raw など) に分ける
function splitLog(out: string): { commit: Omit<Commit, "fileCount">; tail: string }[] {
  const recs: { commit: Omit<Commit, "fileCount">; tail: string }[] = []
  for (const rec of out.split("\x1e")) {
    if (!rec.trim()) continue
    const end = rec.indexOf("\x1d")
    const head = end >= 0 ? rec.slice(0, end) : rec
    const tail = end >= 0 ? rec.slice(end + 1) : ""
    const [hash, shortHash, parents, author, date, message, body] = head.split("\x1f")
    recs.push({ commit: { hash, shortHash, parents: parents ? parents.split(" ") : [], author, date, message, body: (body ?? "").trim() }, tail })
  }
  return recs
}

// git log --format=LOG_FORMAT --shortstat の出力を Commit[] にする
export function parseLog(out: string): Commit[] {
  return splitLog(out).map(({ commit, tail }) => {
    const files = /(\d+) files? changed/.exec(tail)
    return { ...commit, fileCount: files ? Number(files[1]) : 0 }
  })
}

// 1 ファイルの履歴 (git log --follow --format=LOG_FORMAT --raw --numstat -z -- <path>) を、コミットとそのファイルの変更にする
export function parseFileLog(out: string): FileCommit[] {
  return splitLog(out).flatMap(({ commit, tail }) => {
    // -z のときは、書式の後ろに \0 と改行が入ってから --raw が続く
    const [change] = parseRawNumstat(tail.replace(/^[\0\n]+/, ""))
    return change ? [{ ...commit, fileCount: 1, change }] : []
  })
}

// unified diff (-U<大きな値>) を DiffLine[] にする。バイナリなら binary
export function parseUnifiedDiff(out: string): { lines: DiffLine[]; binary: boolean; empty: boolean } {
  const lines: DiffLine[] = []
  let binary = false
  let inHunk = false
  let oldNo = 0
  let newNo = 0
  const src = out.split("\n")
  if (src[src.length - 1] === "") src.pop()
  for (const l of src) {
    if (!inHunk || l.startsWith("diff --git ")) {
      if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) binary = true
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (m) {
        inHunk = true
        oldNo = Number(m[1]) || 1
        newNo = Number(m[2]) || 1
      } else if (l.startsWith("diff --git ")) inHunk = false
      continue
    }
    if (l.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (m) {
        oldNo = Number(m[1]) || 1
        newNo = Number(m[2]) || 1
      }
      continue
    }
    const c = l[0]
    const text = l.slice(1)
    if (c === "+") lines.push({ type: "add", text, newNo: newNo++ })
    else if (c === "-") lines.push({ type: "del", text, oldNo: oldNo++ })
    else if (c === " " || l === "") lines.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ })
    // "\ No newline at end of file" は捨てる
  }
  return { lines, binary, empty: !out.trim() }
}

// UTF-8 のバイト位置を、JS の文字列 (UTF-16) の位置にする
export function byteToUtf16(text: string, byteOffset: number): number {
  let bytes = 0
  let i = 0
  while (i < text.length && bytes < byteOffset) {
    const cp = text.codePointAt(i)!
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    i += cp >= 0x10000 ? 2 : 1
  }
  return i
}

type RgMatch = {
  type: string
  data: {
    path?: { text?: string; bytes?: string }
    lines?: { text?: string; bytes?: string }
    line_number?: number
    submatches?: { start: number; end: number }[]
  }
}

// rg --json の 1 行を SearchHit にする (match 以外は null)
export function parseRgLine(line: string): SearchHit | null {
  if (!line.startsWith('{"type":"match"')) return null
  let m: RgMatch
  try {
    m = JSON.parse(line) as RgMatch
  } catch {
    return null
  }
  const d = m.data
  const path = d.path?.text ?? (d.path?.bytes ? Buffer.from(d.path.bytes, "base64").toString("utf8") : "")
  const raw = d.lines?.text ?? (d.lines?.bytes ? Buffer.from(d.lines.bytes, "base64").toString("utf8") : "")
  const text = raw.replace(/\r?\n$/, "")
  const matches: Match[] = (d.submatches ?? []).map((s) => ({ start: byteToUtf16(text, s.start), end: byteToUtf16(text, s.end) }))
  return { path: path.replace(/^\.\//, ""), line: d.line_number ?? 0, text, matches }
}
