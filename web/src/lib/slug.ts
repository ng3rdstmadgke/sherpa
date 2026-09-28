// Markdown の見出しのリンク先の名前 (`#1-背景` の `1-背景`)。GitHub (github-slugger) と同じ作り方にする:
// 小文字にし、文字・記号の付いた文字・数字・`_`・`-`・空白以外を消して、空白を `-` にする。
// 同じ名前が 2 つ目以降に出たら `-1`, `-2` … を付ける (1 つの文書の中で、出てきた順に呼ぶ)
export function createSlugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-")
    let slug = base
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    return slug
  }
}
