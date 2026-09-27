import { connection } from "next/server"
import { home } from "@/server/paths"
import { getUiState } from "@/server/ui-state"
import { ClientApp } from "./client-app"

// 画面の状態を SQLite から読み、最初の描画に間に合うように渡す
export default async function Page() {
  await connection()
  let state: Record<string, unknown> = {}
  try {
    state = getUiState()
  } catch (e) {
    console.error(e)
  }
  return <ClientApp initialState={state} home={home()} />
}
