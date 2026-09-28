"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "cn"
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

// 拡大率の範囲 (元の大きさに対する倍率) と、ボタン・キーで 1 回に変える倍率
const MIN_SCALE = 0.05
const MAX_SCALE = 20
const STEP = 1.25
// この倍率以上では、画像を補間せずに画素のまま拡大する (小さなアイコンなどをぼかさないため)
const PIXELATED_SCALE = 3

type View = { x: number; y: number; scale: number }

// 枠に収まる大きさで中央に置く。maxFit より大きくはしない
function fitView(el: HTMLElement, width: number, height: number, maxFit: number): View {
  const fit = Math.min((el.clientWidth * 0.95) / width, (el.clientHeight * 0.95) / height, maxFit)
  const scale = Math.min(Math.max(fit, MIN_SCALE), MAX_SCALE)
  return { scale, x: (el.clientWidth - width * scale) / 2, y: (el.clientHeight - height * scale) / 2 }
}

// (px, py) の点を動かさずに拡大・縮小する
function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = Math.min(Math.max(v.scale * factor, MIN_SCALE), MAX_SCALE)
  const k = scale / v.scale
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

// 拡大・縮小できる表示。ホイールで拡大・縮小、ドラッグで移動、ダブルクリックで全体を表示。
// width / height は中身の元の大きさ (px)。header は上の帯の左に出すもの。
// maxFit: 全体を表示するときの倍率の上限 (1 なら小さなものを引き伸ばさない)。
// modal: モーダルの中に置く。キー (+ / - / 0 / 1) をページ全体で受け、右上に閉じるボタンの場所を空ける。
// モーダルでないときは、表示にフォーカスがあるときだけキーを受ける
export function ZoomView(props: {
  header: ReactNode
  width: number
  height: number
  children: ReactNode
  maxFit?: number
  modal?: boolean
  className?: string
}) {
  const { width, height, maxFit = Infinity, modal = false } = props
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  // 全体を表示したままか (動かしていなければ、枠の大きさが変わったときに合わせ直す)
  const fitted = useRef(true)
  const [view, setView] = useState<View | null>(null)

  const fit = () => {
    if (!ref.current) return
    fitted.current = true
    setView(fitView(ref.current, width, height, maxFit))
  }
  // 枠の中央を中心に拡大・縮小する
  const zoomCenter = (factor: (v: View) => number) => {
    const el = ref.current
    if (!el) return
    fitted.current = false
    setView((v) => v && zoomAt(v, factor(v), el.clientWidth / 2, el.clientHeight / 2))
  }

  // 開いたときと、枠の大きさが変わったときに全体を表示する (動かしたあとは合わせない)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    fitted.current = true
    const observer = new ResizeObserver(() => {
      if (fitted.current) setView(fitView(el, width, height, maxFit))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [width, height, maxFit])

  // ホイールはページのスクロールやブラウザの拡大を止めたいので、passive でない listener で受ける
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      fitted.current = false
      const rect = el.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      setView((v) => v && zoomAt(v, Math.exp(-dy * 0.002), e.clientX - rect.left, e.clientY - rect.top))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // + / - で拡大・縮小、0 で全体、1 で等倍
  const onKey = (e: KeyboardEvent | React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === "+" || e.key === "=") zoomCenter(() => STEP)
    else if (e.key === "-") zoomCenter(() => 1 / STEP)
    else if (e.key === "1") zoomCenter((v) => 1 / v.scale)
    else if (e.key === "0") fit()
    else return
    e.preventDefault()
  }
  const onKeyRef = useRef(onKey)
  useEffect(() => {
    onKeyRef.current = onKey
  })
  useEffect(() => {
    if (!modal) return
    const listener = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [modal])

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", props.className)} onKeyDown={modal ? undefined : onKey}>
      <div className={cn("flex items-center gap-1 border-b py-1.5 pl-4", modal ? "pr-12" : "pr-3")}>
        <div className="mr-auto min-w-0 truncate text-sm">{props.header}</div>
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
        // モーダルでないときは、クリックしたあとにキーで操作できるよう、フォーカスを受けられるようにする
        tabIndex={modal ? undefined : 0}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden outline-none select-none active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.button !== 0 || !view) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          fitted.current = false
          setView((v) => v && { ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={fit}
      >
        <div
          data-pixelated={view && view.scale >= PIXELATED_SCALE ? "" : undefined}
          className="absolute top-0 left-0 origin-top-left data-pixelated:[&_img]:[image-rendering:pixelated]"
          style={{
            width,
            height,
            visibility: view ? "visible" : "hidden",
            transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
          }}
        >
          {props.children}
        </div>
      </div>
    </div>
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
        <ZoomView header={<DialogTitle className="truncate text-sm">{title}</DialogTitle>} width={width} height={height} modal>
          {children}
        </ZoomView>
      </DialogContent>
    </Dialog>
  )
}
