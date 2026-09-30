"use client"

import { createContext, useContext } from "react"
import { keepPreviousData, QueryClient, useQuery } from "@tanstack/react-query"
import type { DiffBase } from "@/components/workspace/editor-layout"
import type { DisplaySettings } from "./display"
import type { SearchOptions } from "./search"
import type {
  Branch,
  Commit,
  CompareResult,
  ContentSearchResult,
  DetectResult,
  DiffResult,
  ErrorCode,
  FileContent,
  FileHistory,
  FileNode,
  Health,
  NameSearchResult,
  PathEntry,
  Project,
  SpecResult,
  TreeResult,
  Change,
} from "./types"

// サーバー API の呼び出しと TanStack Query のフック (docs/architecture/api.md §5)。
// キーは ["wt", projectId, worktreeId, 種類, 引数]。SSE の通知でその worktree のキーをまとめて無効にする

export class ApiRequestError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export async function api<T>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const hasBody = init.body !== undefined
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: ErrorCode; message: string } } | null
    throw new ApiRequestError(body?.error?.code ?? "INTERNAL", body?.error?.message ?? `サーバーのエラー (${res.status})`, res.status)
  }
  return (await res.json()) as T
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // 4xx (見つからない・正しくない) はやり直さない
      retry: (n, e) => !(e instanceof ApiRequestError && e.status < 500) && n < 1,
    },
  },
})

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

export type WtRef = { projectId: string; worktreeId: string }

// ProjectWorkspace の中で、対象の worktree を配る
export const WtContext = createContext<WtRef | null>(null)

export function useWt(): WtRef {
  const wt = useContext(WtContext)
  if (!wt) throw new Error("WtContext がありません")
  return wt
}

type Params = Record<string, string | number | boolean | null | undefined>

function query(params?: Params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === null || v === undefined || v === "") continue
    q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ""
}

export function wtUrl(wt: WtRef, action: string, params?: Params) {
  return `/api/projects/${encodeURIComponent(wt.projectId)}/worktrees/${encodeURIComponent(wt.worktreeId)}/${action}${query(params)}`
}

export const wtKey = (wt: WtRef, ...rest: unknown[]) => ["wt", wt.projectId, wt.worktreeId, ...rest]

export const rawUrl = (wt: WtRef, path: string, rev?: string | null) => wtUrl(wt, "raw", { path, rev })

// ファイルをダウンロードする URL (作業ツリーの今のファイル。Content-Disposition: attachment で返る)
export const downloadUrl = (wt: WtRef, path: string) => wtUrl(wt, "raw", { path, download: true })

// HTML のプレビューの URL。token は usePreviewToken の合言葉。パスを URL のパスにする (ページの中の相対パスが、同じ形で解決されるように)
export const previewUrl = (wt: WtRef, token: string, path: string) =>
  wtUrl(wt, `preview/${encodeURIComponent(token)}/` + path.split("/").map(encodeURIComponent).join("/"))

// プレビューの合言葉 (サーバーを起動し直すと変わるので、プレビューを開くたびに取り直す)
export function usePreviewToken() {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "preview-token"), queryFn: () => api<{ token: string }>(wtUrl(wt, "preview-token")), staleTime: 0 })
}

// DiffBase をクエリの base にする
export function diffBaseParam(b: DiffBase | { type: "commit"; hash: string }): string {
  if (b.type === "uncommitted") return "uncommitted"
  if (b.type === "commit") return `commit:${b.hash}`
  return `${b.includeUncommitted ? "branch-wt" : "branch"}:${b.branch}`
}

export const listWorktreeDir = (wt: WtRef) => (dir: string) => api<PathEntry[]>(wtUrl(wt, "dir", { dir }))
export const listHostDir = (dir: string) => api<PathEntry[]>(`/api/fs/dirs${query({ dir: dir || "" })}`)

// ---------------------------------------------------------------------------
// フック
// ---------------------------------------------------------------------------

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: () => api<Health>("/api/health"), staleTime: Infinity })
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/api/projects"), placeholderData: keepPreviousData })
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api<{ excludes: string[] } & DisplaySettings>("/api/settings") })
}

export function useDetect(path: string | null) {
  return useQuery({
    queryKey: ["detect", path],
    queryFn: () => api<DetectResult>(`/api/projects/detect${query({ path })}`),
    enabled: !!path,
    placeholderData: keepPreviousData,
  })
}

export function useTree(ignored: boolean) {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "tree", ignored), queryFn: () => api<TreeResult>(wtUrl(wt, "tree", { ignored })), placeholderData: keepPreviousData })
}

export function useChildren(path: string, enabled: boolean) {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "children", path), queryFn: () => api<FileNode[]>(wtUrl(wt, "tree/children", { path })), enabled })
}

export function useSpec(input: string) {
  const wt = useWt()
  return useQuery({
    queryKey: wtKey(wt, "spec", input),
    queryFn: () => api<SpecResult>(wtUrl(wt, "spec", { input })),
    enabled: !!input.trim(),
    placeholderData: keepPreviousData,
  })
}

export function useChanges() {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "changes"), queryFn: () => api<Change[]>(wtUrl(wt, "changes")) })
}

export function useBranches() {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "branches"), queryFn: () => api<Branch[]>(wtUrl(wt, "branches")) })
}

export function useCompare(c: { branch: string; includeUncommitted: boolean }) {
  const wt = useWt()
  return useQuery({
    queryKey: wtKey(wt, "compare", c.branch, c.includeUncommitted),
    queryFn: () => api<CompareResult>(wtUrl(wt, "compare", { branch: c.branch, includeUncommitted: c.includeUncommitted })),
    enabled: !!c.branch,
  })
}

export function useFile(path: string) {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "file", path), queryFn: () => api<FileContent>(wtUrl(wt, "file", { path })) })
}

export function useDiff(path: string, oldPath: string | undefined, base: DiffBase | { type: "commit"; hash: string }, enabled = true) {
  const wt = useWt()
  const b = diffBaseParam(base)
  return useQuery({
    queryKey: wtKey(wt, "diff", b, path, oldPath),
    queryFn: () => api<DiffResult>(wtUrl(wt, "diff", { path, oldPath, base: b })),
    enabled,
  })
}

export function useCommit(hash: string) {
  const wt = useWt()
  return useQuery({ queryKey: wtKey(wt, "commit", hash), queryFn: () => api<Commit>(wtUrl(wt, "commits/" + hash)), staleTime: Infinity })
}

// 1 ファイルの履歴 (max 件まで。超えたら truncated)
export function useFileHistory(path: string, max: number, enabled: boolean) {
  const wt = useWt()
  return useQuery({
    queryKey: wtKey(wt, "history", path, max),
    queryFn: () => api<FileHistory>(wtUrl(wt, "history", { path, max })),
    enabled,
    placeholderData: keepPreviousData,
  })
}

export type SearchRequest = SearchOptions & { q: string; include: string; exclude: string; ignored: boolean }

export function useContentSearch(req: SearchRequest | null) {
  const wt = useWt()
  return useQuery({
    queryKey: wtKey(wt, "search", "content", req),
    queryFn: ({ signal }) => api<ContentSearchResult>(wtUrl(wt, "search/content", req!), { signal }),
    enabled: !!req?.q,
    placeholderData: keepPreviousData,
  })
}

export function useNameSearch(req: SearchRequest | null) {
  const wt = useWt()
  return useQuery({
    queryKey: wtKey(wt, "search", "files", req),
    queryFn: ({ signal }) => api<NameSearchResult>(wtUrl(wt, "search/files", req!), { signal }),
    enabled: !!req?.q,
    placeholderData: keepPreviousData,
  })
}
