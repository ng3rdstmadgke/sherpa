"use client"

import { useSyncExternalStore } from "react"

// ライト / ダークの切り替え。選んだテーマは persist.ts で SQLite に保存し (キー "theme")、
// 読み込み直後にライトで一瞬表示されないよう、layout.tsx がサーバーで <html> に dark を付ける

export type Theme = "light" | "dark"

// html の dark クラスの有無を読む (mermaid の図をテーマに合わせて描き直すのに使う)
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

export function useIsDark() {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  )
}
