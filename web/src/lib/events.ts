"use client"

import { useEffect, useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { WatchEvent } from "./types"

// 自動更新の通知 (SSE) を受け取る (docs/architecture/live-reload.md §3, §4)。
// ブラウザは EventSource を 1 つだけ張る (HTTP/1.1 では同じサーバーへの接続が 6 本までのため)

const listeners = new Set<(e: WatchEvent) => void>()

export function onWatchEvent(fn: (e: WatchEvent) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// 接続の状態と、監視できなかった worktree
let state = { connected: false, errors: new Map<string, string>() }
const statusListeners = new Set<() => void>()
function setState(next: Partial<typeof state>) {
  state = { ...state, ...next }
  statusListeners.forEach((l) => l())
}
const subscribeStatus = (fn: () => void) => {
  statusListeners.add(fn)
  return () => {
    statusListeners.delete(fn)
  }
}

// "ok" は監視中。"error" は監視できない。"off" はサーバーとの接続が切れている
export function useWatchStatus(key: string): { status: "ok" | "error" | "off"; message?: string } {
  const s = useSyncExternalStore(
    subscribeStatus,
    () => state,
    () => state,
  )
  if (!s.connected) return { status: "off", message: "サーバーとの接続が切れています。自動更新は止まっています" }
  const err = s.errors.get(key)
  return err ? { status: "error", message: err } : { status: "ok" }
}

function apply(qc: QueryClient, e: WatchEvent) {
  if (e.type === "files" || e.type === "git") {
    void qc.invalidateQueries({ queryKey: ["wt", e.projectId, e.worktreeId] })
    void qc.invalidateQueries({ queryKey: ["projects"] })
  } else if (e.type === "worktrees" || e.type === "projects") {
    void qc.invalidateQueries({ queryKey: ["projects"] })
    void qc.invalidateQueries({ queryKey: ["settings"] })
    if (e.type === "projects") void qc.invalidateQueries({ queryKey: ["wt"] })
  } else if (e.type === "watch-error") {
    const errors = new Map(state.errors)
    errors.set(`${e.projectId}/${e.worktreeId}`, e.message)
    setState({ errors })
  }
}

export function useWatchEvents(keys: string[]) {
  const qc = useQueryClient()
  const joined = [...new Set(keys)].sort().join(",")
  useEffect(() => {
    let wasDisconnected = false
    const es = new EventSource(`/api/events?watch=${encodeURIComponent(joined)}`)
    es.onopen = () => {
      setState({ connected: true, errors: new Map() })
      // 切れている間の変更を取りこぼさないよう、つながり直したら読み直す
      if (wasDisconnected) void qc.invalidateQueries()
      wasDisconnected = false
    }
    es.onerror = () => {
      wasDisconnected = true
      setState({ connected: false })
    }
    es.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as WatchEvent
      apply(qc, e)
      listeners.forEach((l) => l(e))
    }
    return () => es.close()
  }, [joined, qc])
}
