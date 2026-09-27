import { defineConfig } from "drizzle-kit"

// マイグレーションの SQL を drizzle/ に作る (npx drizzle-kit generate)
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
})
