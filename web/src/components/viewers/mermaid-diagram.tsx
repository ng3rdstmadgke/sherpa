"use client"

import { useEffect, useId, useMemo, useState } from "react"
import { useIsDark } from "@/lib/theme"
import { ZoomDialog } from "./zoom-dialog"

// 図の元の大きさ。mermaid の SVG は width="100%" で出るので、一番外の svg の viewBox から読む
function svgSize(svg: string) {
  const tag = /^<svg[^>]*>/.exec(svg)?.[0] ?? ""
  const box = /viewBox="([^"]+)"/.exec(tag)?.[1].trim().split(/[\s,]+/).map(Number)
  if (!box || box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) return null
  return { width: box[2], height: box[3] }
}

export function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/:/g, "")
  const [svg, setSvg] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const dark = useIsDark()
  const size = useMemo(() => svgSize(svg), [svg])

  // テーマを切り替えたら、そのテーマで描き直す
  useEffect(() => {
    let cancelled = false
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" })
      try {
        const { svg } = await mermaid.render(`m${id}`, code)
        if (!cancelled) setSvg(svg)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })
    return () => {
      cancelled = true
    }
  }, [code, id, dark])

  if (error) return <pre className="text-destructive text-xs">{error}</pre>
  if (!size) return <div className="my-4 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
  // クリックでモーダルを開き、大きく表示する。押せる範囲は図の幅だけ (元の幅より広げない)
  return (
    <div className="my-4 flex justify-center">
      <button
        type="button"
        title="クリックで拡大"
        className="flex w-full cursor-zoom-in justify-center"
        style={{ maxWidth: size.width }}
        onClick={() => setOpen(true)}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <ZoomDialog open={open} onOpenChange={setOpen} title="Mermaid" {...size}>
        <div className="size-full [&>svg]:block" dangerouslySetInnerHTML={{ __html: svg }} />
      </ZoomDialog>
    </div>
  )
}
