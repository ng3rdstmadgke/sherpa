"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { ArrowDown, ArrowUp, CaseSensitive, X } from "lucide-react"

// エディタグループ内の検索 (Ctrl+F)。
// グループの本文のうち [data-find-root] の中の文字を探し、CSS Custom Highlight API で強調する (DOM は書き換えない)。
// [data-find-ignore] の中 (差分の行番号など) と、SVG (mermaid の図) の中は対象外。

const HIGHLIGHT_ALL = "sherpa-find"
const HIGHLIGHT_CURRENT = "sherpa-find-current"

// 検索語がまたがってはいけない単位 (段落・コードの 1 行・表のセルなど)
const BLOCK = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,.line,tr,div,button,summary"

type Segment = { node: Text; start: number }

function collectText(roots: Element[]): { text: string; segments: Segment[] } {
  let text = ""
  const segments: Segment[] = []
  let prevBlock: Element | null = null
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const el = n.parentElement
        if (!el || el.closest("[data-find-ignore], svg, script, style")) return NodeFilter.FILTER_REJECT
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const block = n.parentElement!.closest(BLOCK)
      if (prevBlock && block !== prevBlock) text += "\n"
      prevBlock = block
      segments.push({ node: n, start: text.length })
      text += n.nodeValue
    }
  }
  return { text, segments }
}

function findRanges(roots: Element[], q: string, caseSensitive: boolean): Range[] {
  if (!q) return []
  const { text, segments } = collectText(roots)
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? q : q.toLowerCase()
  // 文字列上の位置を (テキストノード, ノード内の位置) に戻す
  const locate = (pos: number, isEnd: boolean) => {
    let lo = 0
    let hi = segments.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segments[mid].start < pos || (!isEnd && segments[mid].start === pos)) lo = mid
      else hi = mid - 1
    }
    const s = segments[lo]
    return { node: s.node, offset: Math.min(pos - s.start, s.node.length) }
  }
  const ranges: Range[] = []
  for (let i = hay.indexOf(needle); i >= 0 && ranges.length < 5000; i = hay.indexOf(needle, i + needle.length)) {
    const a = locate(i, false)
    const b = locate(i + needle.length, true)
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    ranges.push(r)
  }
  return ranges
}

function clearHighlights() {
  CSS.highlights?.delete(HIGHLIGHT_ALL)
  CSS.highlights?.delete(HIGHLIGHT_CURRENT)
}

export function FindBar({
  scope,
  query,
  onQueryChange,
  focusNonce,
  onClose,
}: {
  // 検索する範囲 (エディタグループの本文)
  scope: React.RefObject<HTMLElement | null>
  query: string
  onQueryChange: (q: string) => void
  // Ctrl+F が押されるたびに変わる値。検索欄にフォーカスし直すのに使う
  focusNonce: number
  onClose: () => void
}) {
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const current = ranges.length ? Math.min(index, ranges.length - 1) : -1

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  // 本文の変化 (タブの切り替え・シンタックスハイライトの完了・自動更新など) に合わせて探し直す
  useEffect(() => {
    const el = scope.current
    if (!el) return
    let frame = 0
    const run = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setRanges(findRanges([...el.querySelectorAll("[data-find-root]")], query, caseSensitive)))
    }
    run()
    const observer = new MutationObserver(run)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [scope, query, caseSensitive])

  useEffect(() => {
    if (typeof Highlight === "undefined" || !CSS.highlights) return
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges))
    if (current >= 0) {
      CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(ranges[current]))
      ranges[current].startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" })
    } else {
      CSS.highlights.delete(HIGHLIGHT_CURRENT)
    }
  }, [ranges, current])

  useEffect(() => clearHighlights, [])

  const move = (delta: number) => {
    if (!ranges.length) return
    setIndex((current + delta + ranges.length) % ranges.length)
  }

  return (
    <div className="absolute top-11 right-4 z-30 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-lg">
      <input
        ref={inputRef}
        data-find-input
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value)
          setIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            move(e.shiftKey ? -1 : 1)
          } else if (e.key === "Escape") {
            e.preventDefault()
            onClose()
          }
        }}
        placeholder="このタブ内を検索"
        className="h-7 w-56 rounded border bg-background px-2 text-sm outline-none focus:border-ring"
      />
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        title="大文字小文字を区別"
        className={cn("rounded p-1 hover:bg-accent", caseSensitive && "bg-accent text-accent-foreground ring-1 ring-ring")}
      >
        <CaseSensitive className="size-4" />
      </button>
      <span className={cn("w-16 text-center font-mono text-xs", query && !ranges.length ? "text-destructive" : "text-muted-foreground")}>
        {query ? (ranges.length ? `${current + 1}/${ranges.length}` : "結果なし") : ""}
      </span>
      <button onClick={() => move(-1)} title="前へ (Shift+Enter)" className="rounded p-1 hover:bg-accent disabled:opacity-40" disabled={!ranges.length}>
        <ArrowUp className="size-4" />
      </button>
      <button onClick={() => move(1)} title="次へ (Enter)" className="rounded p-1 hover:bg-accent disabled:opacity-40" disabled={!ranges.length}>
        <ArrowDown className="size-4" />
      </button>
      <button onClick={onClose} title="閉じる (Esc)" className="rounded p-1 hover:bg-accent">
        <X className="size-4" />
      </button>
    </div>
  )
}
