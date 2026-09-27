"use client"

import { useState } from "react"
import { Check, Copy, Info, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Project, Worktree } from "@/lib/types"
import { relTime } from "@/lib/format"
import { ProjectDialog } from "@/components/project-dialog"

// worktree バーの「詳細」ボタン。ブランチ名・ディレクトリなど、常に見せなくてよい情報をまとめて表示する
export function WorktreeInfo({
  project,
  worktree,
  compareBranch,
  ahead,
  behind,
}: {
  project: Project
  worktree: Worktree
  compareBranch: string
  ahead: number
  behind: number
}) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" title="ワークツリーの詳細 (ブランチ・ディレクトリ)" />}>
          <Info className="size-4" />
        </PopoverTrigger>
        <PopoverContent className="w-[480px] p-0" align="start">
          <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2.5 p-4 text-sm">
            <Row label="ブランチ">
              {worktree.branch ? <Copyable text={worktree.branch} /> : <span className="font-mono text-xs">(detached) {worktree.head}</span>}
            </Row>
            <Row label="ディレクトリ">
              <Copyable text={worktree.hostPath} />
            </Row>
            {worktree.containerPath && (
              <Row label="コンテナ内">
                <Copyable text={worktree.containerPath} />
                <p className="mt-0.5 text-[11px] text-muted-foreground">devcontainer の中のパス。git が記録しているこのパスを、上のディレクトリに読み替えている</p>
              </Row>
            )}
            <Row label="比較対象との差">
              <span className="font-mono text-xs">
                ↑{ahead} ↓{behind}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {compareBranch} に対して {ahead} コミット先行 / {behind} コミット遅れ
              </span>
            </Row>
            <Row label="最新のコミット">
              {worktree.lastCommit ? (
                <>
                  <span className="font-mono text-xs text-muted-foreground">{worktree.lastCommit.hash.slice(0, 7)}</span>{" "}
                  <span className="text-xs">{worktree.lastCommit.message}</span>
                  <span className="ml-1 text-xs text-muted-foreground">· {relTime(worktree.lastCommit.date)}</span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">コミットはまだありません</span>
              )}
            </Row>
          </dl>
          <div className="flex justify-end border-t px-3 py-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setOpen(false)
                setSettingsOpen(true)
              }}
            >
              <Settings className="size-3.5" /> プロジェクトの設定
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <ProjectDialog project={project} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-xs whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-start gap-1">
      {/* パスを確認するための表示なので、省略せずに折り返す */}
      <span className="pt-0.5 font-mono text-xs break-all">{text}</span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="コピー"
      >
        {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
}
