"use client"

import { useMemo, useState } from "react"
import { cn } from "cn"
import { FileText } from "lucide-react"
import { listWorktreeDir, useWt } from "@/lib/api"
import { PathSuggestInput } from "@/components/path-suggest-input"

// worktree バーの SPEC 欄。SPEC セクションに出すドキュメントの場所を、カンマ区切りで worktree ごとに指定する。
// Enter かフォーカスが外れたときに確定し、Esc で入力前に戻す。
// worktree を切り替えたら作り直す (key に worktree を渡す) ので、下書きはその worktree の値から始まる
export function SpecPathsInput({ value, onChange, count }: { value: string; onChange: (v: string) => void; count: number }) {
  const [draft, setDraft] = useState(value)
  const wt = useWt()
  const list = useMemo(() => listWorktreeDir(wt), [wt])
  const commit = () => draft !== value && onChange(draft)

  return (
    <label
      className="flex h-7 w-[26rem] min-w-40 shrink items-center gap-1.5 rounded-md border bg-background pr-1 pl-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
      title="SPEC に出す場所 (カンマ区切りで複数指定。末尾の /* はその下の階層すべて)"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs text-muted-foreground">SPEC:</span>
      <PathSuggestInput
        variant="bare"
        value={draft}
        onChange={setDraft}
        list={list}
        listKey={`wt:${wt.projectId}/${wt.worktreeId}`}
        separator=","
        dirGlob="*"
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
            e.currentTarget.blur()
          } else if (e.key === "Escape") {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
        placeholder=".ai/agent-tasks/226_add_gateway/*, agent-tasks/226_add_gateway/*"
        className="w-full bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60"
      />
      {value && (
        <span className={cn("shrink-0 rounded px-1 font-mono text-[10px]", count ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive")}>
          {count ? `${count} 件` : "0 件"}
        </span>
      )}
    </label>
  )
}
