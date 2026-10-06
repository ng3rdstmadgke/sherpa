"use client"

import { cn } from "cn"
import type { UseQueryResult } from "@tanstack/react-query"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { ResizableHandle } from "@/components/ui/resizable"
import type { Change, Commit, CompareResult } from "@/lib/types"
import { ApiRequestError, errorMessage, useChanges, useCommit } from "@/lib/api"
import { relTime } from "@/lib/format"
import { basename, DiffStat, dirname, FileIcon, setTabDrag, statusColor } from "./common"
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
          <HoverCard key={c.hash}>
            <HoverCardTrigger
              delay={500}
              closeDelay={150}
              render={
                <button
                  draggable
                  onDragStart={(e) => setTabDrag(e, { tab: { kind: "commit", hash: c.hash }, fromGroupId: null })}
                  onClick={() => onOpen({ kind: "commit", hash: c.hash })}
                  className="flex w-full flex-col items-start rounded px-3 py-1.5 text-left hover:bg-accent"
                />
              }
            >
              <span className="line-clamp-1 text-sm">{c.message}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {c.shortHash} · {c.author} · {relTime(c.date)} · {c.fileCount} files
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-[30rem]">
              <CommitSummary commit={c} />
            </HoverCardContent>
          </HoverCard>
        ))}
        {!compareStatus && commits.length === 0 && <Empty>{compare.branch} にないコミットはありません</Empty>}
        {!!result?.moreCommits && <Empty>ほかに {result.moreCommits} 件のコミットがあります</Empty>}
      </Section>
    </SectionGroup>
  )
}

// HISTORY の行にホバーしたときのカードに出すファイルの数の上限 (多いと描画が重いため。残りは数だけ出す)
const STAT_LIMIT = 100

// コミットの詳細 (メッセージの全文と、git diff --stat と同じ内容)。変更ファイルは開いたときに読む (コミットのタブと同じキャッシュ)
function CommitSummary({ commit: c }: { commit: Commit }) {
  const { data, error, isPending } = useCommit(c.hash)
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
                  {/* 長いパスはディレクトリの側を省いて、ファイル名を残す */}
                  <span className="flex min-w-0 flex-1" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    <span className="truncate text-muted-foreground">
                      {f.oldPath && `${f.oldPath} → `}
                      {dirname(f.path) && `${dirname(f.path)}/`}
                    </span>
                    <span className="shrink-0">{basename(f.path)}</span>
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
            // 削除したファイルは作業ツリーにないので、ダウンロードできない
            data-tree-download={c.status === "D" ? undefined : ""}
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
