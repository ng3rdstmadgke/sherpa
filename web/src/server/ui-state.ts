import { like } from "drizzle-orm"
import { getDb, schema } from "./db"

// 画面の状態 (persist.ts のキー) の読み書き

export function getUiState(): Record<string, unknown> {
  const rows = getDb().select().from(schema.uiState).all()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function applyUiState(body: { set?: Record<string, unknown>; deletePrefixes?: string[] }) {
  const db = getDb()
  const now = Date.now()
  db.transaction((tx) => {
    for (const prefix of body.deletePrefixes ?? []) {
      if (!prefix) continue
      tx.delete(schema.uiState)
        .where(like(schema.uiState.key, prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%"))
        .run()
    }
    for (const [key, value] of Object.entries(body.set ?? {})) {
      if (value === undefined) continue
      tx.insert(schema.uiState)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: schema.uiState.key, set: { value, updatedAt: now } })
        .run()
    }
  })
}

export function getTheme(): "light" | "dark" {
  try {
    return getUiState().theme === "dark" ? "dark" : "light"
  } catch {
    return "light"
  }
}
