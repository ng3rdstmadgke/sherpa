import type { DiffLine } from "./types"

// 差分の行 (ファイル全体。partial でないもの) から、変更前と変更後のテキストを組み立てる。
// 変更前の i 行目は oldNo = i + 1、変更後の i 行目は newNo = i + 1 になる
export function diffSides(lines: DiffLine[]) {
  const before: string[] = []
  const after: string[] = []
  for (const l of lines) {
    if (l.type !== "add") before.push(l.text)
    if (l.type !== "del") after.push(l.text)
  }
  return { before, after }
}

// シンタックスハイライトやプレビューをする大きさの上限。ファイルの表示 (server/files.ts) と同じ 20 万文字・5,000 行
export function withinHighlightLimit(lines: string[]) {
  if (lines.length > 5000) return false
  let chars = 0
  for (const l of lines) chars += l.length + 1
  return chars <= 200_000
}

// ---- Markdown のプレビューの差分 ----
// 変更前と変更後の mdast を、git の行の差分を手がかりにまとまり (段落・見出し・表・図など) ごとに突き合わせ、
// 変わったまとまりに印を付けた 1 つの木にする。変更のないまとまりは変更後のものをそのまま使う。
// side が before / after のときは、Split の片側として、削除 / 追加の印のものだけを残す

type Pos = { start: { line: number }; end: { line: number } }
export type MdNode = { type: string; position?: Pos; children?: MdNode[]; checked?: boolean | null; data?: Record<string, unknown> }

export type MdDiffSide = "both" | "before" | "after"
type Ctx = { lines: DiffLine[]; del: Set<number>; add: Set<number>; before: string[]; after: string[]; side: MdDiffSide }

// 中のまとまりごとに突き合わせ直す入れ物 (リストは項目ごと、表は行ごと)
const NESTED = new Set(["list", "listItem", "blockquote", "table"])

const range = (n: MdNode) => (n.position ? [n.position.start.line, n.position.end.line] : [0, -1])

// 行番号 → その行を含むまとまりの番号
function lineIndex(nodes: MdNode[]) {
  const m = new Map<number, number>()
  nodes.forEach((n, i) => {
    const [s, e] = range(n)
    for (let k = s; k <= e; k++) m.set(k, i)
  })
  return m
}

const touches = (n: MdNode, set: Set<number>) => {
  const [s, e] = range(n)
  for (let k = s; k <= e; k++) if (set.has(k)) return true
  return false
}

// 入れ物の中の変わった行が、すべて中のまとまりのどれかに入っているか (入っていない変更は、中を比べても見つからない)
function coveredByChildren(n: MdNode, set: Set<number>, text: string[]) {
  const inner = lineIndex(n.children ?? [])
  const [s, e] = range(n)
  for (let k = s; k <= e; k++) if (set.has(k) && !inner.has(k) && text[k - 1]?.trim()) return false
  return true
}

function mark(n: MdNode, kind: "add" | "del", side: MdDiffSide): MdNode[] {
  // リンクの定義などは表示されないので、印を付けない。変更前の側だけ変更前のものを使う
  if (n.type === "definition" || n.type === "footnoteDefinition") return (side === "before" ? kind === "del" : kind === "add") ? [n] : []
  if ((side === "before" && kind === "add") || (side === "after" && kind === "del")) return []
  const className = [`md-diff-${kind}`]
  // li と tr は包むと表やリストが崩れるので、そのものに class を付ける (タスクリストの class は残す)
  if (n.type === "listItem")
    return [{ ...n, data: { ...n.data, hProperties: { className: typeof n.checked === "boolean" ? ["task-list-item", ...className] : className } } }]
  if (n.type === "tableRow") return [{ ...n, data: { ...n.data, hProperties: { className } } }]
  // 段落は中身を span で包む (詰めたリストの中では段落の p が外されるため、段落の外では包めない)
  if (n.type === "paragraph") return [{ ...n, children: [{ type: "mdDiff", data: { hName: "span", hProperties: { className } }, children: n.children }] }]
  // それ以外は div で包む (mdast-util-to-hast は知らない種類の節を div にする)
  return [{ type: "mdDiff", data: { hProperties: { className } }, children: [n] }]
}

function diffNodes(olds: MdNode[], news: MdNode[], ctx: Ctx): MdNode[] {
  const oldAt = lineIndex(olds)
  const newAt = lineIndex(news)
  // 変更のない行で結ばれた、変更前と変更後のまとまりを 1 組にする (変更前は i、変更後は olds.length + j)
  const parent = Array.from({ length: olds.length + news.length }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const order: number[] = []
  const seen = new Set<number>()
  const visit = (id: number | undefined) => {
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  for (const l of ctx.lines) {
    const o = l.type !== "add" && l.oldNo !== undefined ? oldAt.get(l.oldNo) : undefined
    const nj = l.type !== "del" && l.newNo !== undefined ? newAt.get(l.newNo) : undefined
    const n = nj === undefined ? undefined : olds.length + nj
    if (o !== undefined && n !== undefined) parent[find(o)] = find(n)
    visit(o)
    visit(n)
  }
  // 組ごとにまとめる (並びは差分の中で最初に出てきた順)
  const groups = new Map<number, { olds: MdNode[]; news: MdNode[] }>()
  for (const id of order) {
    const r = find(id)
    if (!groups.has(r)) groups.set(r, { olds: [], news: [] })
    const g = groups.get(r)!
    if (id < olds.length) g.olds.push(olds[id])
    else g.news.push(news[id - olds.length])
  }

  const out: MdNode[] = []
  for (const g of groups.values()) {
    const pair = g.olds.length === 1 && g.news.length === 1 && g.olds[0].type === g.news[0].type
    const [o, n] = [g.olds[0], g.news[0]]
    if (pair && !touches(o, ctx.del) && !touches(n, ctx.add)) {
      out.push(n)
      continue
    }
    if (
      pair &&
      NESTED.has(n.type) &&
      // タスクリストの チェックが変わった項目は、項目ごと (チェックは項目のほうに付くため)
      o.checked === n.checked &&
      coveredByChildren(o, ctx.del, ctx.before) &&
      coveredByChildren(n, ctx.add, ctx.after) &&
      // 表の見出しの行が変わったときは、行ごとにすると消えた見出しが本文の行に並ぶので、表ごとにする
      (n.type !== "table" || (!touches(o.children![0], ctx.del) && !touches(n.children![0], ctx.add)))
    ) {
      out.push({ ...n, children: diffNodes(o.children ?? [], n.children ?? [], ctx) })
      continue
    }
    out.push(...g.olds.flatMap((x) => mark(x, "del", ctx.side)), ...g.news.flatMap((x) => mark(x, "add", ctx.side)))
  }
  return out
}

// before / after は diffSides の結果、oldRoot / newRoot はそれを remark で読んだ木
export function buildMarkdownDiff(
  oldRoot: MdNode,
  newRoot: MdNode,
  lines: DiffLine[],
  before: string[],
  after: string[],
  side: MdDiffSide = "both",
): MdNode {
  const del = new Set<number>()
  const add = new Set<number>()
  for (const l of lines) {
    if (l.type === "del" && l.oldNo !== undefined) del.add(l.oldNo)
    if (l.type === "add" && l.newNo !== undefined) add.add(l.newNo)
  }
  return { ...newRoot, children: diffNodes(oldRoot.children ?? [], newRoot.children ?? [], { lines, del, add, before, after, side }) }
}
