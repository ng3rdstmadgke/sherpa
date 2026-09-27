"use client"

import { cn } from "cn"
import type { UseQueryResult } from "@tanstack/react-query"
import { ResizableHandle } from "@/components/ui/resizable"
import type { Change, CompareResult } from "@/lib/types"
import { ApiRequestError, errorMessage, useChanges } from "@/lib/api"
import { relTime } from "@/lib/format"
import { DiffStat, FileIcon, setTabDrag, statusColor } from "./common"
import { PathTree, treeIndent } from "./path-tree"
import type { DiffBase, DocTab } from "./editor-layout"
import { compareRangeLabel, type CompareState } from "./compare-picker"
import { Section, SectionGroup } from "./panel-section"

// 比較対象 (compare) は worktree バーで選ぶ。ここでは参照するだけ
// compareQuery は ProjectWorkspace で取ったもの (エクスプローラの記号などと同じ結果を使う)
export function GitPanel({
  compare,
  compareQuery,
  onOpen,
}: {
  compare: CompareState
  compareQuery: UseQueryResult<CompareResult>
  onOpen: (tab: DocTab) => void
}) {
  const changesQuery = useChanges()
  const changes = changesQuery.data ?? []
  const result = compareQuery.data
  const files = result?.files ?? []
  const commits = result?.commits ?? []
  const compareBase: DiffBase = { type: "branch", ...compare }
  // COMPARE と HISTORY に出す状態の文言 (読み込み中・比較対象がない・共通の祖先がない・エラー)
  const compareStatus = !compare.branch
    ? "比較対象のブランチを選んでください"
    : compareQuery.isPending
      ? "読み込み中…"
      : compareQuery.error
        ? compareQuery.error instanceof ApiRequestError && compareQuery.error.code === "BRANCH_NOT_FOUND"
          ? `${compare.branch} が見つかりません`
          : errorMessage(compareQuery.error)
        : result && !result.mergeBase
          ? `${compare.branch} と共通の祖先がありません`
          : null

  return (
    <SectionGroup storageKey="git-panel-layout">
      <Section id="uncommitted" title="未コミットの差分" count={changes.length} caption="HEAD...作業ツリー" defaultSize="30">
        {changesQuery.isPending ? (
          <Empty>読み込み中…</Empty>
        ) : changesQuery.error ? (
          <Empty error>{errorMessage(changesQuery.error)}</Empty>
        ) : changes.length ? (
          <ChangeTree items={changes} base={{ type: "uncommitted" }} onOpen={onOpen} />
        ) : (
          <Empty>未コミットの変更はありません</Empty>
        )}
      </Section>
      <ResizableHandle />
      <Section id="compare" title="Compare" count={files.length} caption={compare.branch ? compareRangeLabel(compare) : undefined} defaultSize="45">
        {compareStatus ? (
          <Empty error={!!compareQuery.error}>{compareStatus}</Empty>
        ) : files.length ? (
          <ChangeTree items={files} base={compareBase} onOpen={onOpen} />
        ) : (
          <Empty>{compare.branch} との差分はありません</Empty>
        )}
      </Section>
      <ResizableHandle />
      <Section id="history" title="History" count={(result?.ahead ?? 0) || commits.length} caption={compare.branch ? `${compare.branch}..HEAD` : undefined} defaultSize="25">
        {compareStatus && <Empty error={!!compareQuery.error}>{compareStatus}</Empty>}
        {commits.map((c) => (
          <button
            key={c.hash}
            draggable
            onDragStart={(e) => setTabDrag(e, { tab: { kind: "commit", hash: c.hash }, fromGroupId: null })}
            onClick={() => onOpen({ kind: "commit", hash: c.hash })}
            className="flex w-full flex-col items-start rounded px-3 py-1.5 text-left hover:bg-accent"
          >
            <span className="line-clamp-1 text-sm">{c.message}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {c.shortHash} · {c.author} · {relTime(c.date)} · {c.fileCount} files
            </span>
          </button>
        ))}
        {!compareStatus && commits.length === 0 && <Empty>{compare.branch} にないコミットはありません</Empty>}
        {!!result?.moreCommits && <Empty>ほかに {result.moreCommits} 件のコミットがあります</Empty>}
      </Section>
    </SectionGroup>
  )
}

function Empty({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <p className={cn("px-3 py-1 text-xs", error ? "text-destructive" : "text-muted-foreground")}>{children}</p>
}

// ---------------------------------------------------------------------------
// 変更ファイルのツリー
// ---------------------------------------------------------------------------

function ChangeTree({ items, base, onOpen }: { items: Change[]; base: DiffBase; onOpen: (tab: DocTab) => void }) {
  return (
    <PathTree
      items={items}
      renderFile={(c, depth) => {
        const tab: DocTab = { kind: "diff", path: c.path, oldPath: c.oldPath, base }
        return (
          <button
            draggable
            onDragStart={(e) => setTabDrag(e, { tab, fromGroupId: null })}
            data-tree-path={c.path}
            onClick={() => onOpen(tab)}
            className="flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-sm hover:bg-accent"
            style={{ paddingLeft: treeIndent(depth, "file") }}
          >
            <FileIcon path={c.path} />
            <span className={cn("truncate", statusColor[c.status])} title={c.oldPath ? `${c.oldPath} → ${c.path}` : undefined}>
              {c.path.split("/").pop()}
            </span>
            <span className="ml-auto pl-1">
              <DiffStat additions={c.additions} deletions={c.deletions} />
            </span>
            <span className={cn("w-3 shrink-0 font-mono text-xs", statusColor[c.status])}>{c.status}</span>
          </button>
        )
      }}
    />
  )
}
