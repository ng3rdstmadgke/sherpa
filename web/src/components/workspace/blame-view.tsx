"use client"

import { useMemo } from "react"
import { cn } from "cn"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { langFromPath, TokenLine, useLineTokens } from "@/components/viewers/code-viewer"
import { errorMessage, useBlame } from "@/lib/api"
import { relTime } from "@/lib/format"
import { UNCOMMITTED_HASH, type BlameCommit } from "@/lib/types"
import { CommitSummary } from "./commit-summary"

// blame (パスのバーの「Blame」)。作業ツリーの今の内容を 1 行ずつ並べ、左に、その行を最後に変えたコミットを出す。
// 同じコミットが続く行のまとまりごとに、先頭に短いハッシュ・作者・日時・件名を出す (スクロールしても、まとまりの中では上に残す)。
// ホバーでコミットの詳細のカード、クリックでコミットのタブを開く。左端の帯の濃さで新しさを示す (一番新しいコミットが一番濃い)

const NO_LINES: string[] = []

// onOpenCommit の path は、そのコミットでのファイルのパス (コミットのタブで、そのファイルだけを展開する)
export function BlameView({ path, onOpenCommit }: { path: string; onOpenCommit: (hash: string, path: string) => void }) {
  const { data, error, isPending } = useBlame(path, true)
  const lines = data?.lines ?? NO_LINES
  const tokens = useLineTokens(lines, langFromPath(path))
  // コミットの新しさ (0〜1)。コミットが 1 つだけなら 1
  const age = useMemo(() => {
    const times = Object.values(data?.commits ?? {})
      .filter((c) => c.hash !== UNCOMMITTED_HASH)
      .map((c) => Date.parse(c.date))
    const min = Math.min(...times)
    const max = Math.max(...times)
    return (c: BlameCommit) => (max > min ? (Date.parse(c.date) - min) / (max - min) : 1)
  }, [data])

  if (isPending) return <Message>読み込み中…</Message>
  if (error) return <Message error>{errorMessage(error)}</Message>
  if (!lines.length) return <Message>空のファイルです</Message>

  return (
    <table className="sherpa-code-text w-full border-collapse font-mono">
      <tbody>
        {data.hunks.map((h) =>
          lines.slice(h.start - 1, h.start - 1 + h.count).map((text, j) => {
            const n = h.start + j
            const commit = data.commits[h.hash]
            const uncommitted = h.hash === UNCOMMITTED_HASH
            return (
              <tr key={n} className={cn(j === 0 && h.start > 1 && "border-t")}>
                {j === 0 && (
                  <td
                    rowSpan={h.count}
                    data-find-ignore
                    className="border-r bg-muted/30 p-0 align-top"
                    // 新しさの帯。テーマの変数は出力されないことがあるので、色は直接書く
                    style={{ boxShadow: uncommitted ? "inset 3px 0 0 rgb(16 185 129)" : `inset 3px 0 0 rgb(217 119 6 / ${0.15 + 0.85 * age(commit)})` }}
                  >
                    <BlameCell commit={commit} uncommitted={uncommitted} onOpen={() => onOpenCommit(h.hash, commit.path || path)} />
                  </td>
                )}
                <td data-find-ignore className="w-12 pr-2 text-right align-top text-muted-foreground/70 select-none">
                  {n}
                </td>
                <td className="pr-4 pl-2 break-all whitespace-pre-wrap">{tokens?.[n - 1] ? <TokenLine tokens={tokens[n - 1]} /> : text}</td>
              </tr>
            )
          }),
        )}
      </tbody>
    </table>
  )
}

function BlameCell({ commit, uncommitted, onOpen }: { commit: BlameCommit; uncommitted: boolean; onOpen: () => void }) {
  // コードの 1 行と同じ高さの 1 行に収める (高さが違うと、1 行だけのまとまりでコードの行間が広がる)。長い件名は省略する
  const content = uncommitted ? (
    <span className="truncate text-emerald-700 dark:text-emerald-400">未コミット</span>
  ) : (
    <>
      <span className="shrink-0 font-mono">{commit.shortHash}</span>
      <span className="min-w-0 flex-1 truncate text-foreground/80">{commit.summary}</span>
      <span className="max-w-20 shrink-0 truncate">{commit.author}</span>
      <span className="shrink-0">{relTime(commit.date)}</span>
    </>
  )
  // 高さは .sherpa-code-text の行の高さ (文字の大きさ × 1.54) と同じ
  const className = "sticky top-0 flex h-[calc(var(--sherpa-code-font-size,13px)*1.54)] w-80 items-center gap-1.5 px-2 text-left font-sans text-[11px] text-muted-foreground"
  // 未コミットの行にはコミットがないので、カードもタブも出さない
  if (uncommitted) return <div className={className}>{content}</div>
  return (
    <HoverCard>
      <HoverCardTrigger delay={500} closeDelay={150} render={<button onClick={onOpen} className={cn(className, "hover:bg-accent")} />}>
        {content}
      </HoverCardTrigger>
      {/* コミットの欄の真下に、欄と同じ幅で出す (右のコードに重ねない)。下に入らなければ上に出し、横には逃がさない。
          高さは画面に空いている分まで (中はスクロール) */}
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={2}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        className="max-h-(--available-height) w-80 overflow-auto"
      >
        <CommitSummary hash={commit.hash} />
      </HoverCardContent>
    </HoverCard>
  )
}

function Message({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <p className={cn("p-6 text-center text-sm", error ? "text-destructive" : "text-muted-foreground")}>{children}</p>
}
