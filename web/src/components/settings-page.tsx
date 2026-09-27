"use client"

import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DISPLAY_DEFAULTS, FONT_SIZE_MAX, FONT_SIZE_MIN, normalizeFontSize, type DisplaySettings } from "@/lib/display"
import { DEFAULT_EXCLUDES, parseExcludeLines } from "@/lib/excludes"
import { api, errorMessage, useSettings } from "@/lib/api"
import type { SettingsSection } from "@/components/app-nav"

// 全体の設定のページ (一番上のタブの「設定」)。すべてのプロジェクトに適用する。
// 設定が増えても探しやすいよう、左に項目の一覧、右に内容を並べる。
// 変更は自動で SQLite に保存する (保存ボタンはない)

const SECTIONS: { id: SettingsSection; group: string; title: string }[] = [
  { id: "fontSize", group: "表示", title: "フォントサイズ" },
  { id: "excludes", group: "表示・検索", title: "除外パターン" },
]

// フォントサイズの入力欄。入力中は文字列のまま持ち、保存のときに数にする
type FontDraft = Record<keyof DisplaySettings, string>

// 入力が止まってから保存するまでの時間
const SAVE_DELAY = 600

export function SettingsPage({ focus }: { focus?: { section: SettingsSection; nonce: number } }) {
  const refs = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({})

  // 他の画面から項目を指定して開かれたら、その項目までスクロールして強調する
  useEffect(() => {
    if (!focus) return
    const el = refs.current[focus.section]
    if (!el) return
    el.scrollIntoView({ block: "start", behavior: "smooth" })
    el.classList.add("ring-2", "ring-ring")
    const t = setTimeout(() => el.classList.remove("ring-2", "ring-ring"), 1500)
    return () => clearTimeout(t)
  }, [focus])

  const groups = [...new Set(SECTIONS.map((s) => s.group))]
  const settings = useSettings()
  const qc = useQueryClient()
  // 変更は自動で保存する (入力が止まってから SAVE_DELAY ms)。null は保存済みの値のまま
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "error"; text: string } | null>(null)
  const savedExcludes = settings.data?.excludes ?? DEFAULT_EXCLUDES
  const value = draft ?? savedExcludes.join("\n")
  const nextExcludes = parseExcludeLines(value)
  const excludesDirty = draft !== null && JSON.stringify(nextExcludes) !== JSON.stringify(savedExcludes)
  // フォントサイズ
  const savedFont: DisplaySettings = {
    codeFontSize: settings.data?.codeFontSize ?? DISPLAY_DEFAULTS.codeFontSize,
    markdownFontSize: settings.data?.markdownFontSize ?? DISPLAY_DEFAULTS.markdownFontSize,
  }
  const [fontDraft, setFontDraft] = useState<FontDraft | null>(null)
  const font: FontDraft = fontDraft ?? { codeFontSize: String(savedFont.codeFontSize), markdownFontSize: String(savedFont.markdownFontSize) }
  // 範囲の外や数でない値のあいだは保存しない
  const fontError = (k: keyof DisplaySettings) => {
    const n = Number(font[k])
    return font[k].trim() && Number.isInteger(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX ? null : `${FONT_SIZE_MIN}〜${FONT_SIZE_MAX} の整数で指定してください`
  }
  const fontValid = !fontError("codeFontSize") && !fontError("markdownFontSize")
  const fontValue: DisplaySettings = {
    codeFontSize: normalizeFontSize(font.codeFontSize, savedFont.codeFontSize),
    markdownFontSize: normalizeFontSize(font.markdownFontSize, savedFont.markdownFontSize),
  }
  const fontDirty = fontValid && (fontValue.codeFontSize !== savedFont.codeFontSize || fontValue.markdownFontSize !== savedFont.markdownFontSize)
  const setFont = (k: keyof DisplaySettings, v: string) => setFontDraft({ ...font, [k]: v })

  // 保存する中身。変わった項目だけを送る
  const body = { ...(excludesDirty ? { excludes: nextExcludes } : {}), ...(fontDirty ? fontValue : {}) }
  const bodyKey = JSON.stringify(body)
  useEffect(() => {
    if (bodyKey === "{}") return
    const t = setTimeout(async () => {
      setStatus({ kind: "saving", text: "保存中…" })
      try {
        await api("/api/settings", { method: "PUT", body: JSON.parse(bodyKey) })
        await qc.invalidateQueries({ queryKey: ["settings"] })
        // 除外パターンは一覧・検索に効くので、開いている worktree を読み直す
        if ("excludes" in JSON.parse(bodyKey)) await qc.invalidateQueries({ queryKey: ["wt"] })
        setStatus({ kind: "saved", text: "保存しました" })
      } catch (e) {
        setStatus({ kind: "error", text: errorMessage(e) })
      }
    }, SAVE_DELAY)
    return () => clearTimeout(t)
  }, [bodyKey, qc])

  return (
    <main className="flex min-h-0 flex-1">
      <nav className="w-56 shrink-0 border-r p-4">
        <h1 className="mb-4 text-lg font-semibold">設定</h1>
        {groups.map((g) => (
          <div key={g} className="mb-3">
            <p className="mb-1 px-2 text-xs font-semibold tracking-wide text-muted-foreground">{g}</p>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <button
                key={s.id}
                onClick={() => refs.current[s.id]?.scrollIntoView({ block: "start", behavior: "smooth" })}
                className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent"
              >
                {s.title}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl space-y-8 p-8">
            <p className="text-sm text-muted-foreground">すべてのプロジェクトに適用します。プロジェクトごとの設定は、ホームのカードの「…」の「編集」で行います。</p>

            <section
              ref={(el) => {
                refs.current.fontSize = el
              }}
              className="scroll-mt-8 space-y-3 rounded-lg border p-5 transition-shadow"
            >
              <p className="text-xs font-semibold tracking-wide text-muted-foreground">表示</p>
              <Label className="text-base">フォントサイズ</Label>
              <p className="text-sm text-muted-foreground">
                ソースコード (ファイルの表示と差分) と、Markdown のプレビューの文字の大きさです。{FONT_SIZE_MIN}〜{FONT_SIZE_MAX} px。
              </p>
              <FontSizeRow
                label="ソースコード"
                value={font.codeFontSize}
                onChange={(v) => setFont("codeFontSize", v)}
                onReset={() => setFont("codeFontSize", String(DISPLAY_DEFAULTS.codeFontSize))}
                defaultValue={DISPLAY_DEFAULTS.codeFontSize}
                disabled={settings.isPending}
                error={fontError("codeFontSize")}
              >
                <pre className="rounded border bg-muted/40 px-3 py-2 font-mono" style={{ fontSize: fontValue.codeFontSize, lineHeight: 1.54 }}>
                  {"export function hello(name: string) {\n  return `Hello, ${name}`\n}"}
                </pre>
              </FontSizeRow>
              <FontSizeRow
                label="Markdown のプレビュー"
                value={font.markdownFontSize}
                onChange={(v) => setFont("markdownFontSize", v)}
                onReset={() => setFont("markdownFontSize", String(DISPLAY_DEFAULTS.markdownFontSize))}
                defaultValue={DISPLAY_DEFAULTS.markdownFontSize}
                disabled={settings.isPending}
                error={fontError("markdownFontSize")}
              >
                <div className="markdown-body rounded border px-3 py-2" style={{ fontSize: fontValue.markdownFontSize }}>
                  <h3 className="mt-0!">見出し</h3>
                  <p className="mb-0!">
                    本文の文字の大きさです。<code>code</code> や見出しも、この大きさに合わせて変わります。
                  </p>
                </div>
              </FontSizeRow>
            </section>

            <section
              ref={(el) => {
                refs.current.excludes = el
              }}
              className="scroll-mt-8 space-y-2 rounded-lg border p-5 transition-shadow"
            >
              <p className="text-xs font-semibold tracking-wide text-muted-foreground">表示・検索</p>
              <Label className="text-base">表示しないパス (除外パターン)</Label>
              <p className="text-sm text-muted-foreground">
                エクスプローラ・SPEC・検索のどれにも出しません。「gitignore」ボタンを ON にしても表示しません。
                プロジェクトの設定の除外パターンは、ここに追加する形で適用します。
              </p>
              <Textarea
                value={value}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => setDraft((d) => (d === null ? d : parseExcludeLines(d).join("\n")))}
                disabled={settings.isPending}
                placeholder="1 行に 1 つ (例: **/node_modules/**)"
                className="min-h-40 font-mono text-xs"
              />
              <button type="button" onClick={() => setDraft(DEFAULT_EXCLUDES.join("\n"))} className="text-xs text-sky-700 underline underline-offset-2 dark:text-sky-400">
                初期値に戻す
              </button>
              <p className="text-xs text-muted-foreground">
                パターンは worktree の直下から数える glob です。<code>**</code> は 0 個以上のディレクトリ、<code>*</code> はディレクトリをまたがない任意の文字列。
              </p>
            </section>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t px-6 py-2 text-xs">
          <span className="text-muted-foreground">変更は自動で保存されます</span>
          {status && (
            <span className={status.kind === "error" ? "text-destructive" : status.kind === "saved" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
              · {status.text}
            </span>
          )}
        </div>
      </div>
    </main>
  )
}

// フォントサイズの 1 行 (入力欄・既定に戻す・見本)
function FontSizeRow(props: {
  label: string
  value: string
  onChange: (v: string) => void
  onReset: () => void
  defaultValue: number
  disabled: boolean
  error: string | null
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-x-4 gap-y-1">
      <div className="space-y-1 pt-1">
        <p className="text-sm">{props.label}</p>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            disabled={props.disabled}
            aria-invalid={!!props.error}
            className="h-8 w-20"
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
        <button type="button" onClick={props.onReset} className="text-xs text-sky-700 underline underline-offset-2 dark:text-sky-400">
          既定 ({props.defaultValue} px) に戻す
        </button>
        {props.error && <p className="text-xs text-destructive">{props.error}</p>}
      </div>
      <div className="min-w-0">{props.children}</div>
    </div>
  )
}
