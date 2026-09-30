"use client"

import { useState } from "react"
import { cn } from "cn"
import { MAX_FILE_HISTORY, type Change, type FileCommit } from "@/lib/types"
import { errorMessage, useFileHistory } from "@/lib/api"
import { relTime } from "@/lib/format"
import { DiffStat } from "./common"

// ファイルの履歴 (パスのバーの「History」)。一番上に未コミットの変更、その下にファイルを変えたコミットを新しい順に並べる。
// 行を選ぶと、本文をその差分にする (選んでいる行をもう一度押すとやめる)。↑ / ↓ で前後の行へ移る

// 一度に読む件数 (「さらに読み込む」でこの数ずつ増やす)
export const HISTORY_PAGE = 200

export const UNCOMMITTED = "uncommitted"

export function HistoryList(props: {
  path: string
  // 未コミットの変更 (なければ行を出さない)
  uncommitted?: Change
  commits: FileCommit[] | undefined
  loading: boolean
  error: unknown
  truncated: boolean
  // さらに読み込む (上限に届いたら undefined)
  onMore?: () => void
  selected?: string
  onSelect: (rev: string | undefined) => void
}) {
  const { uncommitted, commits, selected, onSelect } = props
  const revs = [...(uncommitted ? [UNCOMMITTED] : []), ...(commits ?? []).map((c) => c.hash)]
  const select = (rev: string) => onSelect(rev === selected ? undefined : rev)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const i = selected ? revs.indexOf(selected) : -1
    const next = revs[e.key === "ArrowDown" ? Math.min(i + 1, revs.length - 1) : Math.max(i - 1, 0)]
    if (!next || next === selected) return
    onSelect(next)
    const row = e.currentTarget.querySelector<HTMLElement>(`[data-rev="${next}"]`)
    row?.focus()
    row?.scrollIntoView({ block: "nearest" })
  }

  return (
    <div className="h-full overflow-auto text-xs" onKeyDown={onKeyDown}>
      {uncommitted && (
        <Row rev={UNCOMMITTED} selected={selected === UNCOMMITTED} onClick={() => select(UNCOMMITTED)} title="HEAD...作業ツリー">
          <span className="truncate font-medium">未コミットの変更</span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="truncate">作業ツリー</span>
            <span className="ml-auto">
              <DiffStat additions={uncommitted.additions} deletions={uncommitted.deletions} />
            </span>
          </span>
        </Row>
      )}
      {commits?.map((c) => (
        <Row
          key={c.hash}
          rev={c.hash}
          selected={selected === c.hash}
          onClick={() => select(c.hash)}
          title={[c.message, c.body, c.change.oldPath ? `${c.change.oldPath} → ${c.change.path}` : ""].filter(Boolean).join("\n\n")}
        >
          <span className="truncate font-medium">{c.message}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="shrink-0 font-mono">{c.shortHash}</span>
            <span className="truncate">{c.author}</span>
            <span className="shrink-0" title={c.date}>
              {relTime(c.date)}
            </span>
            <span className="ml-auto pl-1">
              {c.change.binary ? <span className="font-mono text-[11px]">bin</span> : <DiffStat additions={c.change.additions} deletions={c.change.deletions} />}
            </span>
          </span>
          {c.change.oldPath && <span className="truncate text-muted-foreground">← {c.change.oldPath}</span>}
        </Row>
      ))}
      {props.loading && !commits && <p className="px-3 py-2 text-muted-foreground">読み込み中…</p>}
      {!!props.error && <p className="px-3 py-2 text-destructive">{errorMessage(props.error)}</p>}
      {commits && !commits.length && <p className="px-3 py-2 text-muted-foreground">このファイルのコミットはまだありません</p>}
      {props.truncated && props.onMore && (
        <button onClick={props.onMore} disabled={props.loading} className="w-full px-3 py-2 text-left text-sky-700 hover:bg-accent disabled:opacity-50 dark:text-sky-300">
          {props.loading ? "読み込み中…" : "さらに読み込む"}
        </button>
      )}
    </div>
  )
}

function Row(props: { rev: string; selected: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      data-rev={props.rev}
      onClick={props.onClick}
      title={props.title}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b px-3 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        props.selected && "bg-sky-500/20 hover:bg-sky-500/25",
      )}
    >
      {props.children}
    </button>
  )
}

// 履歴を読む件数を持ち、「さらに読み込む」で増やす
export function useHistory(path: string, enabled: boolean) {
  const [max, setMax] = useState(HISTORY_PAGE)
  const q = useFileHistory(path, max, enabled)
  return { ...q, onMore: max < MAX_FILE_HISTORY ? () => setMax((m) => Math.min(m + HISTORY_PAGE, MAX_FILE_HISTORY)) : undefined }
}
