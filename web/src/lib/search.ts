// 検索語の解釈 (大文字小文字の区別 / 単語単位 / 正規表現)。
// 本実装では同じ条件を ripgrep のオプション (-s / -w / -F) に渡す

export type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export type Match = { start: number; end: number }
export type Matcher = { find: (text: string) => Match[] } | { error: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function buildMatcher(q: string, opts: SearchOptions): Matcher | null {
  if (!q) return null
  let source = opts.regex ? q : escape(q)
  // 単語単位: 前後が文字・数字・_ でないこと (日本語の文字も単語の一部として扱う)
  if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
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
