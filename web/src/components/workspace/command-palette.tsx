"use client"

import { useEffect, useRef, useState } from "react"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"

// コマンドの一覧 (コマンドパレットとショートカットの両方がここから引く。docs/architecture/ui.md §9)。
// shortcut は Ctrl (Mac は Cmd) と組み合わせるキー。aliases はパレットで探すときの別名 (`:qa` など)
export type AppCommand = {
  id: string
  label: string
  shortcut?: { key: string; shift?: boolean }
  aliases?: string[]
  // false を返すときは、ショートカットをブラウザに任せる (preventDefault しない)
  enabled?: () => boolean
  run: () => void
}

export const shortcutLabel = (s: NonNullable<AppCommand["shortcut"]>) => `Ctrl+${s.shift ? "Shift+" : ""}${s.key.toUpperCase()}`

// 入力欄の中で打った文字は、コマンドにしない
function isTyping(el: Element | null) {
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  return (el as HTMLElement).isContentEditable || !!el.closest("[role=dialog]")
}

// ショートカットでコマンドを実行する。Ctrl+Shift+P でパレットを開き、入力欄の外で `:` を押すと `:` を入れた状態で開く (vim のように :qa と打てる)
export function useCommandKeys(commands: AppCommand[], active: boolean, openPalette: (search: string) => void) {
  const latest = useRef({ commands, openPalette })
  useEffect(() => {
    latest.current = { commands, openPalette }
  })
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const { commands, openPalette } = latest.current
      const mod = e.ctrlKey || e.metaKey
      if (!mod) {
        if (e.key === ":" && !e.altKey && !isTyping(document.activeElement)) {
          e.preventDefault()
          openPalette(":")
        }
        return
      }
      const k = e.key.toLowerCase()
      if (k === "p" && e.shiftKey) {
        e.preventDefault()
        openPalette("")
        return
      }
      const c = commands.find((c) => c.shortcut && c.shortcut.key === k && !!c.shortcut.shift === e.shiftKey)
      if (!c || (c.enabled && !c.enabled())) return
      e.preventDefault()
      c.run()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active])
}

// コマンドパレット。検索して Enter で実行する。別名 (aliases) でも見つかる
export function CommandPalette({ commands, open, search, onSearchChange, onOpenChange }: {
  commands: AppCommand[]
  open: boolean
  search: string
  onSearchChange: (s: string) => void
  onOpenChange: (open: boolean) => void
}) {
  // 閉じたあとに実行する (パレットが閉じるときにフォーカスを戻すので、検索欄へのフォーカスなどが上書きされないように)
  const [pending, setPending] = useState<AppCommand | null>(null)
  useEffect(() => {
    if (open || !pending) return
    const id = setTimeout(() => {
      pending.run()
      setPending(null)
    }, 0)
    return () => clearTimeout(id)
  }, [open, pending])

  return (
    // VS Code のように画面の上端のすぐ下に出し、上からすべり下りてくるように開く (閉じるときは上へ戻る)。
    // ダイアログの共通の拡大・縮小の動きは打ち消す (tw-animate-css のクラスは cn で片付かないので ! で上書きする)。
    // 背景はぼかさない (後ろのタブやコードを見ながら選べるように)
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="コマンドパレット"
      description="実行するコマンドを探す"
      className="top-2 duration-150 data-open:slide-in-from-top data-open:zoom-in-100! data-closed:slide-out-to-top data-closed:zoom-out-100!"
      overlayClassName="supports-backdrop-filter:backdrop-blur-none"
    >
      <Command>
        <CommandInput value={search} onValueChange={onSearchChange} placeholder="コマンドを探す (:qa ですべてのタブを閉じる)" />
        <CommandList>
          <CommandEmpty>見つかりません</CommandEmpty>
          <CommandGroup>
            {commands.map((c) => (
              <CommandItem
                key={c.id}
                value={c.label}
                keywords={c.aliases}
                onSelect={() => {
                  setPending(c)
                  onOpenChange(false)
                }}
              >
                {c.label}
                {(c.shortcut || c.aliases) && (
                  <CommandShortcut className="tracking-normal">{c.shortcut ? shortcutLabel(c.shortcut) : c.aliases?.[0]}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
