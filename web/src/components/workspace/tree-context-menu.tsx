"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, Copy } from "lucide-react"

// ツリーの右クリックメニュー。ツリー全体に 1 つだけ置き (行ごとには持たない)、
// 右クリックされた位置から一番近い [data-tree-path] の行を対象にする。
// 行以外の場所を右クリックしたときは、ブラウザ標準のメニューを出す。

type MenuState = { x: number; y: number; path: string; row: HTMLElement }

const MENU_WIDTH = 224

export function TreeContextMenu({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 開いている間は、対象の行を枠で示す。外側のクリック・Esc・スクロールで閉じる
  useEffect(() => {
    if (!menu) return
    menu.row.classList.add("ring-1", "ring-ring")
    const close = () => setMenu(null)
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    window.addEventListener("blur", close)
    return () => {
      menu.row.classList.remove("ring-1", "ring-ring")
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("blur", close)
    }
  }, [menu])

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
    setMenu(null)
    setCopied(text)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div
      onContextMenu={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-tree-path]")
        if (!row) return
        e.preventDefault()
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8),
          y: Math.min(e.clientY, window.innerHeight - 60),
          path: row.dataset.treePath!,
          row,
        })
      }}
    >
      {children}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <p className="truncate px-2 py-1 font-mono text-[11px] text-muted-foreground" title={menu.path}>
              {menu.path}
            </p>
            <button
              role="menuitem"
              autoFocus
              onClick={() => copy(menu.path)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <Copy className="size-3.5" /> 相対パスをコピー
            </button>
          </div>,
          document.body,
        )}
      {copied &&
        createPortal(
          <div className="fixed right-4 bottom-4 z-50 flex max-w-md items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm shadow-lg">
            <Check className="size-4 shrink-0 text-emerald-600" />
            <span className="shrink-0">コピーしました:</span>
            <span className="truncate font-mono text-xs">{copied}</span>
          </div>,
          document.body,
        )}
    </div>
  )
}
