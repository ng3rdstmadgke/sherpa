// パスの glob (** と *) を正規表現にする。パスは worktree の直下から数える。
// "**" は 0 個以上のディレクトリ、"*" はディレクトリをまたがない任意の文字列
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" は 0 個以上のディレクトリ、末尾の "**" は残りすべて
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"
        i += 2
      } else {
        re += ".*"
        i += 1
      }
    } else if (c === "*") re += "[^/]*"
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(path: string, globs: string[]) {
  return globs.some((g) => globToRegExp(g).test(path) || globToRegExp(g).test(path + "/"))
}

// 検索の「対象」「対象外」の入力 (カンマ区切り) をパターンにする。VS Code と同じく、
// "/" を含まないもの (*.md や tmp) はどの階層にも当てはまり、ディレクトリを書いたらその下すべてに当てはまる
export function parseSearchGlobs(input: string): string[] {
  return input
    .split(",")
    .map((p) => p.trim().replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean)
    .flatMap((p) => {
      const base = p.includes("/") ? p : `**/${p}`
      return [base, `${base}/**`]
    })
}
