"use client"

import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_EXCLUDES, parseExcludeLines } from "@/lib/excludes"
import { api, errorMessage, useSettings } from "@/lib/api"
import type { SettingsSection } from "@/components/app-nav"

// 全体の設定のページ (一番上のタブの「設定」)。すべてのプロジェクトに適用する。
// 設定が増えても探しやすいよう、左に項目の一覧、右に内容を並べる。
// 「保存」で SQLite に保存する

const SECTIONS: { id: SettingsSection; group: string; title: string }[] = [{ id: "excludes", group: "表示・検索", title: "除外パターン" }]

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
  // 入力中の値。null は保存済みの値のまま
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const saved = (settings.data?.excludes ?? DEFAULT_EXCLUDES).join("\n")
  const value = draft ?? saved
  const save = async () => {
    setStatus(null)
    try {
      await api("/api/settings", { method: "PUT", body: { excludes: parseExcludeLines(value) } })
      await qc.invalidateQueries({ queryKey: ["settings"] })
      await qc.invalidateQueries({ queryKey: ["wt"] })
      setDraft(null)
      setStatus({ ok: true, text: "保存しました" })
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) })
    }
  }

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
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
          <span className={`mr-auto text-xs ${status && !status.ok ? "text-destructive" : "text-muted-foreground"}`}>
            {status?.text ?? (draft !== null && draft !== saved ? "保存していない変更があります" : "")}
          </span>
          <Button onClick={save} disabled={draft === null || draft === saved}>
            保存
          </Button>
        </div>
      </div>
    </main>
  )
}
