import { matchesAny } from "./glob"

// worktree バーの SPEC 欄の入力 (カンマ区切り) をパターンの一覧にする。
// 末尾の "/*" と、ワイルドカードのないディレクトリの指定は、その下の階層すべてを対象にする
export function parseSpecPaths(input: string): string[] {
  return input
    .split(",")
    .map((p) => p.trim().replace(/^\.\//, ""))
    .filter(Boolean)
    .map((p) => {
      if (p.endsWith("/*")) return p.slice(0, -1) + "**"
      if (!p.includes("*") && !p.endsWith(".md")) return p.replace(/\/$/, "") + "/**"
      return p
    })
}

// SPEC に出すファイル: SPEC 欄のパターンに当たる .md。.gitignore で無視されていても出す
export function isSpec(path: string, specPatterns: string[], excludes: string[]) {
  return path.endsWith(".md") && matchesAny(path, specPatterns) && !matchesAny(path, excludes)
}

// パターンのうち、ワイルドカードより前のディレクトリ (ここから下をたどる)。"" は worktree の直下
export function specBaseDir(pattern: string): string {
  const parts = pattern.split("/")
  const i = parts.findIndex((p) => p.includes("*"))
  if (i < 0) return parts.slice(0, -1).join("/")
  return parts.slice(0, i).join("/")
}
