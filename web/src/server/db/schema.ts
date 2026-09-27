import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// SQLite のテーブル (docs/architecture/storage.md §3)

// 登録したプロジェクト
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), // slug
  path: text("path").notNull().unique(), // 絶対パス。末尾の / なし
  name: text("name").notNull(),
  color: text("color").notNull(),
  excludes: text("excludes", { mode: "json" }).$type<string[]>().notNull().default([]),
  defaultCompareBranch: text("default_compare_branch"),
  sortOrder: integer("sort_order").notNull(), // 登録した順
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

// devcontainer のパスマッピング
export const pathMappings = sqliteTable("path_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  container: text("container").notNull(),
  host: text("host").notNull(),
})

// worktree ごとの保存値
export const worktreeSettings = sqliteTable(
  "worktree_settings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id").notNull(), // "main" か .git/worktrees/<id>
    specPaths: text("spec_paths").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.worktreeId] })],
)

// 全体の設定
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
})

// 画面の状態 (persist.ts のキー)
export const uiState = sqliteTable("ui_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
})
