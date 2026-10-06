import { cn } from "cn"
import { File, FileCode, FileText } from "lucide-react"
import type { DocTab } from "./editor-layout"

export const statusColor: Record<string, string> = {
  M: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  U: "text-emerald-600 dark:text-emerald-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
}

// 押したトグル (パスのバーの切り替え・エクスプローラの絞り込み) を塗る色
export const PRESSED_FILL = "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 aria-pressed:hover:text-primary-foreground"

export function basename(p: string) {
  return p.split("/").pop() ?? p
}

export function dirname(p: string) {
  return p.split("/").slice(0, -1).join("/")
}

// Markdown の相対リンクを、リンク元のファイルのディレクトリを基準に解決する (worktree の直下からのパスを返す)。
// "/" で始まるリンクは worktree の直下から数える。"#見出し" と "?..." は取り除く
export function resolveRelative(fromDir: string, href: string) {
  const clean = href.split("#")[0].split("?")[0]
  const parts = clean.startsWith("/") ? [] : fromDir.split("/").filter(Boolean)
  for (const seg of clean.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") parts.pop()
    else parts.push(decodeURIComponent(seg))
  }
  return parts.join("/")
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  if (path.endsWith(".md")) return <FileText className={cn("size-4 shrink-0 text-sky-600", className)} />
  if (/\.(ts|tsx|js|tf|json|go|rs|py)$/.test(path)) return <FileCode className={cn("size-4 shrink-0 text-amber-600", className)} />
  return <File className={cn("size-4 shrink-0 text-muted-foreground", className)} />
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] whitespace-nowrap">
      <span className="text-emerald-600">+{additions}</span> <span className="text-red-600">-{deletions}</span>
    </span>
  )
}

// ドラッグ & ドロップでタブを受け渡すときの MIME タイプ
export const TAB_MIME = "application/x-sherpa-tab"
export type TabDragPayload = { tab: DocTab; fromGroupId: string | null }

export function setTabDrag(e: React.DragEvent, payload: TabDragPayload) {
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = "move"
}
