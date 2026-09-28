"use client"

import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { cn } from "cn"
import { ChevronsUpDown } from "lucide-react"
import type { BundledLanguage, ThemedToken } from "shiki"
import { diffSides, withinHighlightLimit } from "@/lib/diff"
import type { DiffLine } from "@/lib/types"

// 差分の表示 (Unified / Split)。lines はファイル全体の 1 行ずつの差分 (変更のない行も含む)。
// 既定では変更の前後 context 行だけを表示し、それ以外は「N 行を表示」の行に省略する (クリックで展開)。
// expandAll のときは省略せず、ファイル全体の中で差分を表示する。
// lang を渡すと、変更前と変更後をそれぞれ丸ごとシンタックスハイライトして、行ごとに当てる (複数行のコメントなども正しく色が付く)

type Item = { kind: "lines"; lines: DiffLine[] } | { kind: "gap"; start: number; lines: DiffLine[] }

function buildItems(lines: DiffLine[], context: number, expandAll: boolean, expanded: Set<number>): Item[] {
  const visible = lines.map(() => expandAll)
  if (!expandAll) {
    lines.forEach((l, i) => {
      if (l.type === "ctx") return
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) visible[k] = true
    })
  }
  const items: Item[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    const show = visible[i]
    while (i < lines.length && visible[i] === show) i++
    const run = lines.slice(start, i)
    // 省略する行が少ないときは、そのまま表示する
    if (show || expanded.has(start) || run.length <= 2) {
      const last = items[items.length - 1]
      if (last?.kind === "lines") last.lines.push(...run)
      else items.push({ kind: "lines", lines: run })
    } else {
      items.push({ kind: "gap", start, lines: run })
    }
  }
  return items
}

type Tokens = { before: ThemedToken[][]; after: ThemedToken[][] }

// 変更前・変更後の全体をハイライトする。大きすぎるときと、ハイライトできない言語はしない
function useDiffTokens(lines: DiffLine[], lang: string | undefined) {
  const sides = useMemo(() => diffSides(lines), [lines])
  const enabled = !!lang && lang !== "text" && withinHighlightLimit(sides.before) && withinHighlightLimit(sides.after)
  const [result, setResult] = useState<{ lines: DiffLine[]; tokens: Tokens } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    import("shiki").then(async ({ codeToTokens }) => {
      const tokenize = (code: string[]) =>
        codeToTokens(code.join("\n"), { lang: lang as BundledLanguage, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false }).then((r) => r.tokens)
      try {
        const [before, after] = await Promise.all([tokenize(sides.before), tokenize(sides.after)])
        if (!cancelled) setResult({ lines, tokens: { before, after } })
      } catch {
        // 知らない言語などは色を付けずに表示する
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, lang, lines, sides])
  // 別の差分に切り替わった直後は、前の差分の色を使わない
  return enabled && result?.lines === lines ? result.tokens : null
}

// 1 行の本文。削除の行は変更前、それ以外は変更後の行の色を使う
function LineText({ line, tokens }: { line: DiffLine; tokens: Tokens | null }) {
  const row = tokens && (line.type === "del" ? tokens.before[line.oldNo! - 1] : tokens.after[line.newNo! - 1])
  if (!row) return line.text
  // .shiki の規則 (globals.css) で、テーマの色・太字などを効かせる
  return (
    <span className="shiki">
      {row.map((t, i) => (
        <span key={i} style={t.htmlStyle as CSSProperties}>
          {t.content}
        </span>
      ))}
    </span>
  )
}

const rowColor = {
  add: "bg-emerald-500/15",
  del: "bg-red-500/15",
  ctx: "",
}
const sign = { add: "+", del: "-", ctx: " " }

function Num({ n }: { n?: number }) {
  return (
    <td data-find-ignore className="w-12 pr-2 text-right align-top text-muted-foreground/70 select-none">
      {n ?? ""}
    </td>
  )
}

function GapRow({ lines, onExpand }: { lines: DiffLine[]; onExpand: () => void }) {
  const first = lines[0]
  const last = lines[lines.length - 1]
  return (
    <tr data-find-ignore className="bg-sky-500/10 text-sky-700 dark:text-sky-300">
      <td colSpan={4} className="p-0">
        <button onClick={onExpand} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-sky-500/15" title="クリックで展開">
          <ChevronsUpDown className="size-3.5" />
          <span>{lines.length} 行を表示</span>
          <span className="font-mono text-muted-foreground">
            @@ -{first.oldNo}〜{last.oldNo} +{first.newNo}〜{last.newNo} @@
          </span>
        </button>
      </td>
    </tr>
  )
}

function UnifiedRows({ lines, tokens }: { lines: DiffLine[]; tokens: Tokens | null }) {
  return lines.map((l, j) => (
    <tr key={j} className={rowColor[l.type]}>
      <Num n={l.oldNo} />
      <Num n={l.newNo} />
      <td data-find-ignore className="w-4 text-center text-muted-foreground select-none">
        {sign[l.type]}
      </td>
      <td className="pr-4 break-all whitespace-pre-wrap">
        <LineText line={l} tokens={tokens} />
      </td>
    </tr>
  ))
}

// 削除行と追加行を左右に並べる
function toSplitRows(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine }[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === "ctx") {
      rows.push({ left: lines[i], right: lines[i] })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++])
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}

function SplitRows({ lines, tokens }: { lines: DiffLine[]; tokens: Tokens | null }) {
  return toSplitRows(lines).map((r, j) => (
    <tr key={j}>
      <Num n={r.left?.oldNo} />
      <td className={cn("border-r pr-2 break-all whitespace-pre-wrap", r.left?.type === "del" && rowColor.del, !r.left && "bg-muted/40")}>
        {r.left && <LineText line={r.left} tokens={tokens} />}
      </td>
      <Num n={r.right?.newNo} />
      <td className={cn("pr-2 break-all whitespace-pre-wrap", r.right?.type === "add" && rowColor.add, !r.right && "bg-muted/40")}>
        {r.right && <LineText line={r.right} tokens={tokens} />}
      </td>
    </tr>
  ))
}

export function DiffViewer({
  lines,
  mode,
  context = 3,
  expandAll = false,
  lang,
}: {
  lines: DiffLine[]
  mode: "unified" | "split"
  context?: number
  expandAll?: boolean
  lang?: string
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const tokens = useDiffTokens(lines, lang)
  if (!lines.some((l) => l.type !== "ctx")) return <p className="p-4 text-sm text-muted-foreground">差分はありません</p>

  const items = buildItems(lines, context, expandAll, expanded)
  const expand = (start: number) => setExpanded((prev) => new Set(prev).add(start))

  return (
    <table className={cn("sherpa-code-text w-full border-collapse font-mono", mode === "split" && "table-fixed")}>
      {mode === "split" && (
        <colgroup>
          <col className="w-12" />
          <col />
          <col className="w-12" />
          <col />
        </colgroup>
      )}
      <tbody>
        {items.map((item, i) =>
          item.kind === "gap" ? (
            <GapRow key={`g${item.start}`} lines={item.lines} onExpand={() => expand(item.start)} />
          ) : mode === "unified" ? (
            <UnifiedRows key={i} lines={item.lines} tokens={tokens} />
          ) : (
            <SplitRows key={i} lines={item.lines} tokens={tokens} />
          ),
        )}
      </tbody>
    </table>
  )
}
