"use client"

import { createContext, useContext } from "react"

// アプリ全体の画面遷移 (設定タブを開くなど)。
// プロジェクトの設定ダイアログのように、ワークスペースの奥からも呼べるようにコンテキストで渡す

export type SettingsSection = "excludes" | "fontSize"

type AppNav = {
  // 設定タブを開く (開いていればそこへ移る)。section を渡すと、その項目までスクロールする
  openSettings: (section?: SettingsSection) => void
}

export const AppNavContext = createContext<AppNav>({ openSettings: () => {} })

export function useAppNav() {
  return useContext(AppNavContext)
}
