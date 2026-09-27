"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { usePanelRef, type Layout } from "react-resizable-panels"
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePersistentState } from "@/lib/persist"

// サイドパネルを縦に並ぶセクションに分ける (VS Code のサイドバーと同じ)。
// 境界線のドラッグで縦幅を変え、見出しのクリックで見出しだけの高さに折りたたむ。
// 縦幅の配分と折りたたみの状態は storageKey ごとに保存し、次に開いたときに復元する。

// 見出しの高さ。折りたたんだセクションはこの高さになる
const HEADER_PX = 36

export function SectionGroup({ storageKey, children }: { storageKey: string; children: React.ReactNode }) {
  const [layout, setLayout] = usePersistentState<Layout | null>(storageKey, () => null)
  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1" defaultLayout={layout ?? undefined} onLayoutChanged={setLayout}>
      {children}
    </ResizablePanelGroup>
  )
}

export function Section(props: {
  id: string
  title: string
  count?: number
  caption?: string
  // 見出しの右側に置くボタンなど
  actions?: React.ReactNode
  defaultSize: string
  children: React.ReactNode
}) {
  const ref = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const toggle = () => (ref.current?.isCollapsed() ? ref.current.expand() : ref.current?.collapse())

  return (
    <ResizablePanel
      id={props.id}
      panelRef={ref}
      defaultSize={props.defaultSize}
      minSize={HEADER_PX + 64}
      collapsible
      collapsedSize={HEADER_PX}
      onResize={(size) => setCollapsed(size.inPixels <= HEADER_PX + 1)}
    >
      <section className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 pr-2" style={{ height: HEADER_PX }}>
          <button
            onClick={toggle}
            className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
            {props.title}
            {props.count !== undefined && <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] font-normal">{props.count}</span>}
            {props.caption && <span className="ml-auto truncate font-mono text-[10px] font-normal normal-case">{props.caption}</span>}
          </button>
          {props.actions && <div className="flex shrink-0 items-center gap-1">{props.actions}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">{props.children}</div>
      </section>
    </ResizablePanel>
  )
}
