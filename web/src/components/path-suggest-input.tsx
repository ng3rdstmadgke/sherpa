"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { cn } from "cn"
import { File, Folder } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import type { PathEntry } from "@/lib/types"

// パス入力のサジェスト。入力中のパスの最後の "/" までをディレクトリとして、その中身のうち続く文字で始まるものを出す。
// - Tab: 選択中 (なければ先頭) の候補で補完する。↑↓: 候補を選ぶ。Esc: 閉じる
// - Enter は ↑↓ で候補を選んでいるときだけ補完に使い、それ以外は呼び出し元の動作 (確定・改行) に任せる
// - separator を渡すと、カンマ区切り (",") や 1 行 1 つ ("\n") の複数指定で、カーソルのある項目だけを補完する
// - dirGlob を渡すと、ディレクトリの直後に「その下すべて」(dir/* など) も候補に出す

type Suggestion = { value: string; label: string; kind: "dir" | "file" | "glob"; badges?: string[] }

type Props = {
  value: string
  onChange: (v: string) => void
  // ディレクトリの中身を返す (サーバーの API)。listKey はキャッシュの区別に使う
  list: (dir: string) => Promise<PathEntry[]>
  listKey: string
  separator?: "," | "\n"
  multiline?: boolean
  dirsOnly?: boolean
  dirGlob?: string
  // field: shadcn の Input / Textarea と同じ見た目。bare: 枠なし (呼び出し元で枠を付ける)
  variant?: "field" | "bare"
  className?: string
  placeholder?: string
  onBlur?: () => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
}

const MAX = 50

const FIELD =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
const FIELD_INPUT = "h-8 py-1 text-base"
const FIELD_TEXTAREA = "field-sizing-content min-h-16 py-2 text-base"

// カーソル位置の項目 (区切り文字の間) のうち、先頭の空白を除いたカーソルまでの部分
function currentToken(value: string, caret: number, separator?: string) {
  let start = separator ? value.lastIndexOf(separator, caret - 1) + 1 : 0
  while (start < caret && value[start] === " ") start++
  return { start, text: value.slice(start, caret) }
}

function splitToken(token: string) {
  const slash = token.lastIndexOf("/")
  return { dir: token.slice(0, slash + 1), prefix: token.slice(slash + 1).toLowerCase() }
}

function suggest(token: string, entries: PathEntry[], props: Props): Suggestion[] {
  if (token.includes("*")) return []
  const { dir, prefix } = splitToken(token)
  const items: Suggestion[] = entries
    .filter((e) => (!props.dirsOnly || e.kind === "dir") && e.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
    .slice(0, MAX)
    .map((e) => ({ value: dir + e.name + (e.kind === "dir" ? "/" : ""), label: e.name, kind: e.kind, badges: e.badges }))
  if (props.dirGlob && dir && !prefix) items.unshift({ value: dir + props.dirGlob, label: `${props.dirGlob} (その下すべて)`, kind: "glob" })
  return items
}

export function PathSuggestInput(props: Props) {
  const { value, onChange, separator, multiline } = props
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState(-1)
  const [above, setAbove] = useState(false)
  const pendingCaret = useRef<number | null>(null)

  const token = currentToken(value, caret, separator)
  const dir = splitToken(token.text).dir
  const entries = useQuery({
    queryKey: ["suggest", props.listKey, dir],
    queryFn: () => props.list(dir),
    enabled: open && !token.text.includes("*"),
    staleTime: 30_000,
  })
  const items = open ? suggest(token.text, entries.data ?? [], props) : []

  // 補完したあと、カーソルを補完した文字の直後に置く
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  })

  const show = () => {
    const el = ref.current
    if (!el) return
    setCaret(el.selectionStart ?? el.value.length)
    // 下に十分な空きがなければ上に開く
    setAbove(window.innerHeight - el.getBoundingClientRect().bottom < 240)
    setOpen(true)
  }

  const accept = (s: Suggestion) => {
    // カーソルの後ろにある同じ項目の続き (次の区切り文字まで) も置き換える
    const nextSep = separator ? value.indexOf(separator, caret) : -1
    const end = nextSep >= 0 ? nextSep : value.length
    const next = value.slice(0, token.start) + s.value + value.slice(end)
    const pos = token.start + s.value.length
    onChange(next)
    pendingCaret.current = pos
    setCaret(pos)
    setIndex(-1)
    // ディレクトリなら続けて中身を出す
    setOpen(s.kind === "dir")
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (open && items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const d = e.key === "ArrowDown" ? 1 : -1
        setIndex((i) => (i + d + items.length) % items.length)
        return
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault()
        accept(items[Math.max(index, 0)])
        return
      }
      if (e.key === "Enter" && index >= 0) {
        e.preventDefault()
        accept(items[index])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
    }
    props.onKeyDown?.(e)
  }

  const common = {
    ref,
    value,
    spellCheck: false,
    placeholder: props.placeholder,
    className: cn((props.variant ?? "field") === "field" && [FIELD, multiline ? FIELD_TEXTAREA : FIELD_INPUT], props.className),
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      onChange(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      setIndex(-1)
      setOpen(true)
    },
    onFocus: show,
    onClick: show,
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") show()
    },
    onBlur: () => {
      setOpen(false)
      props.onBlur?.()
    },
    onKeyDown,
  }

  return (
    <div className="relative min-w-0 flex-1">
      {multiline ? <textarea {...common} /> : <input {...common} />}
      {items.length > 0 && (
        <div
          role="listbox"
          className={cn(
            "absolute left-0 z-50 max-h-60 w-full min-w-64 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            above ? "bottom-full mb-1" : "top-full mt-1",
          )}
          // 候補のクリックで入力欄のフォーカスが外れないようにする
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((s, i) => (
            <button
              key={s.value}
              role="option"
              aria-selected={i === index}
              onClick={() => accept(s)}
              onMouseEnter={() => setIndex(i)}
              className={cn("flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm", i === index && "bg-accent")}
            >
              {s.kind === "file" ? <File className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-sky-500" />}
              <span className="truncate font-mono text-xs">{s.label}</span>
              {s.badges?.map((b) => (
                <span key={b} className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {b}
                </span>
              ))}
            </button>
          ))}
          <p className="border-t px-2 pt-1 text-[10px] text-muted-foreground">Tab で補完 · ↑↓ で選択 · Esc で閉じる</p>
        </div>
      )}
    </div>
  )
}
