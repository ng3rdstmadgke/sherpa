// 表示の設定 (フォントサイズ)。全体の設定で変えられ、CSS の変数で画面に効かせる

export type DisplaySettings = { codeFontSize: number; markdownFontSize: number }

export const DISPLAY_DEFAULTS: DisplaySettings = { codeFontSize: 13, markdownFontSize: 14 }

export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 24

// 範囲外や数でない値は既定値にする
export function normalizeFontSize(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}

export function normalizeDisplay(v: Partial<Record<keyof DisplaySettings, unknown>> | null | undefined): DisplaySettings {
  return {
    codeFontSize: normalizeFontSize(v?.codeFontSize, DISPLAY_DEFAULTS.codeFontSize),
    markdownFontSize: normalizeFontSize(v?.markdownFontSize, DISPLAY_DEFAULTS.markdownFontSize),
  }
}

// <html> に付ける CSS の変数 (globals.css が参照する)
export function displayCssVars(d: DisplaySettings): Record<string, string> {
  return { "--sherpa-code-font-size": `${d.codeFontSize}px`, "--sherpa-markdown-font-size": `${d.markdownFontSize}px` }
}
