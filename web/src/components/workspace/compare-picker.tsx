"use client"

import { useState } from "react"
import { cn } from "cn"
import { Check, ChevronDown, GitCommitHorizontal, GitCompareArrows } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { useBranches } from "@/lib/api"
import { relTime } from "@/lib/format"

// 比較対象。タブ (worktree) 全体の設定で、次のすべてが参照する
// - Git メニューの COMPARE / HISTORY
// - ファイルメニューのエクスプローラの「変更のみ」と M / A などの記号
// - ファイル表示の「差分を見る」
// - worktree バーの ↑↓
// branch はブランチの名前か、コミットのハッシュ (4 桁以上の 16 進数。サーバーはブランチを先に探す)
export type CompareState = { branch: string; includeUncommitted: boolean }

export function compareRangeLabel(c: CompareState) {
  return `${c.branch}...${c.includeUncommitted ? "作業ツリー" : "HEAD"}`
}

const HASH = /^[0-9a-f]{4,64}$/

export function ComparePicker({ value, onChange, error }: { value: CompareState; onChange: (c: CompareState) => void; error?: Error | null }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const branches = useBranches().data ?? []
  const groups = [
    { heading: "ローカル", items: branches.filter((b) => !b.remote) },
    { heading: "リモート", items: branches.filter((b) => b.remote) },
  ]
  const isBranch = (name: string) => branches.some((b) => b.name === name)
  // コミットの候補: 入力が 16 進数ならそれ、選んでいるのがコミットならそれ (ブランチと同じ名前は出さない)
  const typed = search.trim().toLowerCase()
  const commits = [...new Set([HASH.test(typed) ? typed : "", value.branch && !isBranch(value.branch) ? value.branch : ""])].filter((h) => h && !isBranch(h))
  // 閉じるときに検索欄を空にする
  const toggle = (o: boolean) => {
    setOpen(o)
    if (!o) setSearch("")
  }
  const select = (branch: string) => {
    onChange({ ...value, branch })
    toggle(false)
  }
  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("gap-1.5 font-normal", (error || !value.branch) && "border-destructive/60 text-destructive")}
            title={error ? error.message : value.branch ? `比較対象: ${compareRangeLabel(value)}` : "比較対象を選んでください"}
          />
        }
      >
        <GitCompareArrows className="size-3.5" />
        <span className="text-xs text-muted-foreground">比較:</span>
        <span className="max-w-48 truncate font-mono text-xs">{value.branch || "未選択"}</span>
        {value.includeUncommitted && <span className="text-[10px] text-muted-foreground">+未コミット</span>}
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="ブランチを検索 / コミットのハッシュを入力" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>見つかりません</CommandEmpty>
            {commits.length > 0 && (
              <CommandGroup heading="コミット">
                {commits.map((h) => (
                  // value に入力をそのまま含めて、検索で消えないようにする
                  <CommandItem key={h} value={`commit:${h} ${typed}`} onSelect={() => select(h)}>
                    <Check className={cn("size-3.5", h === value.branch ? "opacity-100" : "opacity-0")} />
                    <GitCommitHorizontal className="size-3.5 opacity-60" />
                    <span className="truncate font-mono text-xs">{h}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.items.map((b) => (
                  <CommandItem
                    key={b.name}
                    value={b.name}
                    onSelect={() => select(b.name)}
                  >
                    <Check className={cn("size-3.5", b.name === value.branch ? "opacity-100" : "opacity-0")} />
                    <span className="truncate font-mono text-xs">{b.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{relTime(b.date)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox checked={value.includeUncommitted} onCheckedChange={(v) => onChange({ ...value, includeUncommitted: !!v })} />
            未コミットの変更を含む
          </label>
          <span className="font-mono text-[10px] text-muted-foreground">{compareRangeLabel(value)}</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
