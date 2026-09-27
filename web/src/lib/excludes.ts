import { matchesAny } from "./glob"

// 常に表示・検索しないパス (gitignore ボタンを ON にしても表示しない)。
// 全体の設定の初期値。プロジェクトの設定の excludes を追加する
export const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/__pycache__/**", "**/*.pyc", "**/.venv/**", "**/.terraform/**", "**/.git/**"]

export function isExcluded(path: string, excludes: string[]) {
  return matchesAny(path, excludes)
}

// 除外パターンの入力 (1 行に 1 つ) を配列にする
export function parseExcludeLines(input: string): string[] {
  return input
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}
