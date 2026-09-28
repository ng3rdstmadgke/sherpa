"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

// 拡大率の範囲 (元の大きさに対する倍率) と、ボタン・キーで 1 回に変える倍率
const MIN_SCALE = 0.05
const MAX_SCALE = 20
const STEP = 1.25

type View = { x: number; y: number; scale: number }

// 枠に収まる大きさで中央に置く
function fitView(el: HTMLElement, width: number, height: number): View {
  const scale = Math.min(Math.max(Math.min((el.clientWidth * 0.95) / width, (el.clientHeight * 0.95) / height), MIN_SCALE), MAX_SCALE)
  return { scale, x: (el.clientWidth - width * scale) / 2, y: (el.clientHeight - height * scale) / 2 }
}

// (px, py) の点を動かさずに拡大・縮小する
function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = Math.min(Math.max(v.scale * factor, MIN_SCALE), MAX_SCALE)
  const k = scale / v.scale
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

// モーダルの中身。ホイールで拡大・縮小、ドラッグで移動、ダブルクリックで全体を表示
function ZoomView({ title, width, height, children }: { title: string; width: number; height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const [view, setView] = useState<View | null>(null)

  const fit = () => {
    if (ref.current) setView(fitView(ref.current, width, height))
  }
  // 枠の中央を中心に拡大・縮小する
  const zoomCenter = (factor: (v: View) => number) => {
    const el = ref.current
    if (el) setView((v) => v && zoomAt(v, factor(v), el.clientWidth / 2, el.clientHeight / 2))
  }

  // 開いたら全体を表示する (枠の大きさが決まってから測る)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (ref.current) setView(fitView(ref.current, width, height))
    })
    return () => cancelAnimationFrame(id)
  }, [width, height])

  // ホイールはページのスクロールやブラウザの拡大を止めたいので、passive でない listener で受ける
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      setView((v) => v && zoomAt(v, Math.exp(-dy * 0.002), e.clientX - rect.left, e.clientY - rect.top))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // + / - で拡大・縮小、0 で全体、1 で等倍
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = ref.current
      if (!el) return
      const zoom = (factor: (v: View) => number) =>
        setView((v) => v && zoomAt(v, factor(v), el.clientWidth / 2, el.clientHeight / 2))
      if (e.key === "+" || e.key === "=") zoom(() => STEP)
      else if (e.key === "-") zoom(() => 1 / STEP)
      else if (e.key === "1") zoom((v) => 1 / v.scale)
      else if (e.key === "0") setView(fitView(el, width, height))
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [width, height])

  return (
    <>
      <div className="flex items-center gap-1 border-b py-1.5 pr-12 pl-4">
        <DialogTitle className="mr-auto min-w-0 truncate text-sm">{title}</DialogTitle>
        <Button variant="ghost" size="icon-sm" title="縮小 (-)" onClick={() => zoomCenter(() => 1 / STEP)}>
          <ZoomOutIcon />
        </Button>
        <Button variant="ghost" size="sm" className="w-14 tabular-nums" title="等倍 (1)" onClick={() => zoomCenter((v) => 1 / v.scale)}>
          {view ? `${Math.round(view.scale * 100)}%` : ""}
        </Button>
        <Button variant="ghost" size="icon-sm" title="拡大 (+)" onClick={() => zoomCenter(() => STEP)}>
          <ZoomInIcon />
        </Button>
        <Button variant="ghost" size="sm" title="全体を表示 (0)" onClick={fit}>
          <MaximizeIcon />
          全体
        </Button>
      </div>
      <div
        ref={ref}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.button !== 0 || !view) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setView((v) => v && { ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={fit}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width,
            height,
            visibility: view ? "visible" : "hidden",
            transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </>
  )
}

// 図や画像を画面の大きさのモーダルで開き、拡大・縮小する。width / height は中身の元の大きさ (px)
export function ZoomDialog({
  open,
  onOpenChange,
  title,
  width,
  height,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  width: number
  height: number
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <ZoomView title={title} width={width} height={height}>
          {children}
        </ZoomView>
      </DialogContent>
    </Dialog>
  )
}
