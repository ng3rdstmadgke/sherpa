"use client"

import { cn } from "cn"
import type { Commit } from "@/lib/types"
import { errorMessage, useCommit } from "@/lib/api"
import { relTime } from "@/lib/format"
import { basename, DiffStat, dirname, statusColor } from "./common"

// カードに出すファイルの数の上限 (多いと描画が重いため。残りは数だけ出す)
const STAT_LIMIT = 100

// コミットの詳細のカードの中身 (メッセージの全文と、git diff --stat と同じ内容)。Git メニューの HISTORY と blame の行にホバーしたときに出す。
// 変更ファイルは開いたときに読む (コミットのタブと同じキャッシュ)。commit を渡せば、読み込む前から件名などを出す
export function CommitSummary({ hash, commit }: { hash: string; commit?: Commit }) {
  const { data, error, isPending } = useCommit(hash)
  const c = commit ?? data
  if (!c) return <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ? errorMessage(error) : "読み込み中…"}</p>
  const files = data?.files ?? []
  const additions = files.reduce((a, f) => a + f.additions, 0)
  const deletions = files.reduce((a, f) => a + f.deletions, 0)
  const maxLines = Math.max(1, ...files.map((f) => f.additions + f.deletions))
  return (
    <div className="space-y-2">
      <div>
        <p className="font-semibold break-words">{c.message}</p>
        {c.body && <pre className="mt-1 max-h-48 overflow-auto font-sans text-xs whitespace-pre-wrap text-muted-foreground">{c.body}</pre>}
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        <span className="select-all">{c.hash}</span>
        <br />
        {c.author} · {new Date(c.date).toLocaleString("ja-JP")} ({relTime(c.date)})
      </p>
      <div className="border-t pt-2">
        {isPending ? (
          <p className="text-xs text-muted-foreground">読み込み中…</p>
        ) : error ? (
          <p className="text-xs text-destructive">{errorMessage(error)}</p>
        ) : (
          <>
            <ul className="max-h-60 space-y-0.5 overflow-auto">
              {files.slice(0, STAT_LIMIT).map((f) => (
                <li key={f.path} className="flex items-center gap-1.5 font-mono text-[11px]">
                  <span className={cn("w-3 shrink-0", statusColor[f.status])}>{f.status}</span>
                  {/* 長いパスはディレクトリの側から省き、それでも入らなければファイル名も省く (右の行数に重ねない) */}
                  <span className="flex min-w-0 flex-1 overflow-hidden" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {f.oldPath && `${f.oldPath} → `}
                      {dirname(f.path) && `${dirname(f.path)}/`}
                    </span>
                    {/* ファイル名は縮めない。ただし欄より長ければ欄の幅で省く */}
                    <span className="max-w-full shrink-0 truncate">{basename(f.path)}</span>
                  </span>
                  {f.binary ? (
                    <span className="shrink-0 text-muted-foreground">Bin</span>
                  ) : (
                    <>
                      <DiffStat additions={f.additions} deletions={f.deletions} />
                      {/* git diff --stat の +++-- に当たる棒。一番多いファイルを幅いっぱいにする */}
                      <span className="flex h-1.5 w-12 shrink-0 overflow-hidden rounded-sm bg-muted">
                        <span className="bg-emerald-500" style={{ width: `${(f.additions / maxLines) * 100}%` }} />
                        <span className="bg-red-500" style={{ width: `${(f.deletions / maxLines) * 100}%` }} />
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {files.length > STAT_LIMIT && <p className="mt-1 text-[11px] text-muted-foreground">ほかに {files.length - STAT_LIMIT} ファイル</p>}
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              {files.length} files changed, <span className="text-emerald-600">{additions} insertions(+)</span>,{" "}
              <span className="text-red-600">{deletions} deletions(-)</span>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
