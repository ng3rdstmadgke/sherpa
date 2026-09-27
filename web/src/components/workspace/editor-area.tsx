"use client"

import { Fragment, useRef, useState } from "react"
import { cn } from "cn"
import { Columns2, GitCommitHorizontal, GitCompare, Rows2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { basename, FileIcon, setTabDrag, TAB_MIME, type TabDragPayload } from "./common"
import { DocumentView, type DocumentActions } from "./document-view"
import { FindBar } from "./find-bar"
import {
  activateTab,
  baseLabel,
  closeTab,
  focusGroup,
  groups,
  moveTab,
  tabKey,
  type DocTab,
  type DropZone,
  type Group,
  type Layout,
  type LayoutNode,
} from "./editor-layout"

type Update = (fn: (l: Layout) => Layout) => void

// グループ内検索 (Ctrl+F) の状態。開いている検索バーは、表示中のメニューで 1 つだけ
export type FindState = { groupId: string; query: string; nonce: number }

type Ctx = {
  layout: Layout
  update: Update
  actionsFor: (groupId: string) => DocumentActions
  empty: React.ReactNode
  find: FindState | null
  onFindChange: (f: FindState | null) => void
}

export function EditorArea(props: Ctx) {
  return (
    <div className="h-full">
      <NodeView node={props.layout.root} ctx={props} />
    </div>
  )
}

function NodeView({ node, ctx }: { node: LayoutNode; ctx: Ctx }) {
  if (node.type === "group") return <GroupView group={node} ctx={ctx} />
  const size = `${100 / node.children.length}`
  return (
    // 構造が変わったら作り直して均等割りにする
    <ResizablePanelGroup key={node.children.map((c) => c.id).join(",")} orientation={node.orientation}>
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <ResizableHandle />}
          <ResizablePanel id={c.id} defaultSize={size} minSize={160}>
            <NodeView node={c} ctx={ctx} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  )
}

const EDGE = 0.25

function zoneFromEvent(e: React.DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y } as const
  const [side, dist] = (Object.entries(d) as [Exclude<DropZone, "center">, number][]).sort((a, b) => a[1] - b[1])[0]
  return dist < EDGE ? side : "center"
}

const zoneClass: Record<DropZone, string> = {
  center: "inset-0",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
}

function readPayload(e: React.DragEvent): TabDragPayload | null {
  const raw = e.dataTransfer.getData(TAB_MIME)
  return raw ? (JSON.parse(raw) as TabDragPayload) : null
}

function GroupView({ group, ctx }: { group: Group; ctx: Ctx }) {
  const { layout, update } = ctx
  const [zone, setZone] = useState<DropZone | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const find = ctx.find?.groupId === group.id ? ctx.find : null
  const isActiveGroup = layout.activeGroupId === group.id
  const isOnlyGroup = groups(layout.root).length === 1
  const active = group.tabs.find((t) => tabKey(t) === group.activeKey)

  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME)
  const drop = (e: React.DragEvent, z: DropZone) => {
    const p = readPayload(e)
    setZone(null)
    if (p) update((l) => moveTab(l, p.tab, p.fromGroupId, group.id, z))
  }

  return (
    <div className="flex h-full flex-col" onMouseDownCapture={() => !isActiveGroup && update((l) => focusGroup(l, group.id))}>
      {/* タブバー: ここへのドロップはグループへの移動 */}
      <div
        className="flex h-9 shrink-0 items-stretch border-b bg-muted/30"
        onDragOver={(e) => {
          if (!accepts(e)) return
          e.preventDefault()
          setZone("center")
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setZone(null)
        }}
        onDrop={(e) => drop(e, "center")}
      >
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {group.tabs.map((t) => (
            <TabHeader
              key={tabKey(t)}
              tab={t}
              selected={tabKey(t) === group.activeKey}
              focused={isActiveGroup}
              onSelect={() => update((l) => activateTab(l, group.id, tabKey(t)))}
              onClose={() => update((l) => closeTab(l, group.id, tabKey(t)))}
              onDragStart={(e) => setTabDrag(e, { tab: t, fromGroupId: group.id })}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          {active && (
            <>
              <IconButton label="右に分割" onClick={() => update((l) => moveTab(l, active, null, group.id, "right"))}>
                <Columns2 className="size-3.5" />
              </IconButton>
              <IconButton label="下に分割" onClick={() => update((l) => moveTab(l, active, null, group.id, "bottom"))}>
                <Rows2 className="size-3.5" />
              </IconButton>
            </>
          )}
          {!isOnlyGroup && (
            <IconButton
              label="グループを閉じる"
              onClick={() => update((l) => group.tabs.reduce((acc, t) => closeTab(acc, group.id, tabKey(t)), l))}
            >
              <X className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      {/* 本文: 端へのドロップで分割、中央へのドロップで移動 */}
      <div
        ref={bodyRef}
        data-editor-group-body
        className="relative min-h-0 flex-1"
        onDragOver={(e) => {
          if (!accepts(e)) return
          e.preventDefault()
          setZone(zoneFromEvent(e))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setZone(null)
        }}
        onDrop={(e) => drop(e, zoneFromEvent(e))}
      >
        {active ? <DocumentView key={tabKey(active)} tab={active} actions={ctx.actionsFor(group.id)} /> : ctx.empty}
        {find && active && (
          <FindBar
            scope={bodyRef}
            query={find.query}
            onQueryChange={(query) => ctx.onFindChange({ ...find, query })}
            focusNonce={find.nonce}
            onClose={() => ctx.onFindChange(null)}
          />
        )}
        {zone && (
          <div className={cn("pointer-events-none absolute z-20 rounded-sm border-2 border-primary/60 bg-primary/10 transition-all", zoneClass[zone])} />
        )}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={onClick} aria-label={label} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TabHeader(props: {
  tab: DocTab
  selected: boolean
  focused: boolean
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
}) {
  const { tab, selected, focused } = props
  const label = tab.kind === "commit" ? tab.hash.slice(0, 7) : basename(tab.path)
  return (
    <div
      draggable
      onDragStart={props.onDragStart}
      onClick={props.onSelect}
      onAuxClick={(e) => e.button === 1 && props.onClose()}
      title={tab.kind === "commit" ? tab.hash : tab.kind === "diff" ? `${tab.path}\n${baseLabel(tab.base)}` : tab.path}
      className={cn(
        "group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-sm select-none",
        selected ? "bg-background" : "text-muted-foreground hover:bg-background/60",
        selected && focused && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-primary",
      )}
    >
      {tab.kind === "diff" ? (
        <GitCompare className="size-3.5 text-amber-600" />
      ) : tab.kind === "commit" ? (
        <GitCommitHorizontal className="size-3.5" />
      ) : (
        <FileIcon path={tab.path} className="size-3.5" />
      )}
      <span className={cn(tab.kind === "diff" && "italic")}>{label}</span>
      {tab.kind === "diff" && (
        <span className="text-xs text-muted-foreground">({tab.base.type === "uncommitted" ? "未コミット" : tab.base.branch})</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          props.onClose()
        }}
        className={cn("ml-1 rounded p-0.5 hover:bg-muted", selected ? "opacity-60" : "opacity-0 group-hover:opacity-100")}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
