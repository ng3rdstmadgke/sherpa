// 検索語の解釈 (大文字小文字の区別 / 正規表現)。
// 本実装では同じ条件を ripgrep のオプション (-s / -F) に渡す

export type SearchOptions = { caseSensitive: boolean; regex: boolean }
export type Match = { start: number; end: number }
export type Matcher = { find: (text: string) => Match[] } | { error: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function buildMatcher(q: string, opts: SearchOptions): Matcher | null {
  if (!q) return null
  const source = opts.regex ? q : escape(q)
  let re: RegExp
  try {
    re = new RegExp(source, `gu${opts.caseSensitive ? "" : "i"}`)
  } catch {
    return { error: "正規表現が正しくありません" }
  }
  return {
    find: (text) => {
      const out: Match[] = []
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        // 空文字に一致する正規表現で止まらないようにする
        if (m[0] === "") {
          re.lastIndex++
          continue
        }
        out.push({ start: m.index, end: m.index + m[0].length })
      }
      return out
    },
  }
}
