"use client"

import { useEffect, useState } from "react"

// 画面の状態 (開いているタブ・分割レイアウトなど) を保存し、再起動後に復元する。
// 最初の描画で値が揃っているよう、page.tsx が SQLite から読んだ値を initPersist で受け取る。
// 変更は 500 ms まとめてから PUT /api/ui-state で書く (docs/implementation-plan.md §2.6)

const store = new Map<string, unknown>()
const pendingSet = new Map<string, unknown>()
const pendingDelete = new Set<string>()
let initialized = false
let timer: ReturnType<typeof setTimeout> | undefined

export function initPersist(initial: Record<string, unknown>) {
  if (initialized) return
  initialized = true
  for (const [k, v] of Object.entries(initial)) store.set(k, v)
  window.addEventListener("pagehide", flush)
}

function flush() {
  clearTimeout(timer)
  timer = undefined
  if (!pendingSet.size && !pendingDelete.size) return
  const body = { set: Object.fromEntries(pendingSet), deletePrefixes: [...pendingDelete] }
  pendingSet.clear()
  pendingDelete.clear()
  // keepalive: ページを閉じる途中でも送る
  void fetch("/api/ui-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {})
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(flush, 500)
}

function load<T>(key: string): T | undefined {
  return store.get(key) as T | undefined
}

function save(key: string, value: unknown) {
  if (JSON.stringify(store.get(key)) === JSON.stringify(value)) return
  store.set(key, value)
  pendingSet.set(key, value)
  schedule()
}

export function usePersistentState<T>(key: string, init: () => T) {
  const [value, setValue] = useState<T>(() => load<T>(key) ?? init())
  useEffect(() => {
    save(key, value)
  }, [key, value])
  return [value, setValue] as const
}

export function removePersisted(keyPrefix: string) {
  for (const k of [...store.keys()]) if (k.startsWith(keyPrefix)) store.delete(k)
  for (const k of [...pendingSet.keys()]) if (k.startsWith(keyPrefix)) pendingSet.delete(k)
  pendingDelete.add(keyPrefix)
  schedule()
}
