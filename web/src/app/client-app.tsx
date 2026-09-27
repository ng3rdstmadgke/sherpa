"use client"

import dynamic from "next/dynamic"
import { QueryClientProvider } from "@tanstack/react-query"
import { queryClient } from "@/lib/api"
import { setHome } from "@/lib/format"
import { initPersist } from "@/lib/persist"

// 画面はブラウザだけで描画する (保存済みの状態は page.tsx が SQLite から読んで渡す)
const AppShell = dynamic(() => import("@/components/app-shell").then((m) => m.AppShell), { ssr: false })

export function ClientApp({ initialState, home }: { initialState: Record<string, unknown>; home: string }) {
  if (typeof window !== "undefined") {
    initPersist(initialState)
    setHome(home)
  }
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  )
}
