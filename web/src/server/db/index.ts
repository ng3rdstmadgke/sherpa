import { mkdirSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { home } from "../paths"
import * as schema from "./schema"

// DB の接続。開発中の再読み込み (HMR) で二重に開かないよう globalThis に置く

export type Db = BetterSQLite3Database<typeof schema>

const g = globalThis as unknown as { __sherpaDb?: { file: string; db: Db; sqlite: Database.Database } }

export function dbFile() {
  return process.env.SHERPA_DB || path.join(home(), ".local/share/sherpa/sherpa.db")
}

export function getDb(): Db {
  const file = dbFile()
  if (g.__sherpaDb?.file === file) return g.__sherpaDb.db
  g.__sherpaDb?.sqlite.close()
  mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") })
  g.__sherpaDb = { file, db, sqlite }
  return db
}

export { schema }
