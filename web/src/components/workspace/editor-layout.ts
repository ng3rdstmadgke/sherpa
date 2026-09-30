// VS Code のエディタグループに相当するレイアウトの木構造と、それを操作する純粋関数。
// グループ (タブの束) を左右 / 上下の分割 (split) で入れ子にする。

// 差分の比較元。"uncommitted" は HEAD との比較、それ以外はブランチ名 (<branch>...HEAD)
export type DiffBase = { type: "uncommitted" } | { type: "branch"; branch: string; includeUncommitted: boolean }

// パスのバーの切り替え (グループごとに持ち、グループの中のタブで共有する。なし = 既定)
// display: 差分か全体か (既定はファイルタブは全体、差分タブは差分) / format: 差分の形式 (既定は unified) /
// md: Markdown をプレビューとソースのどちらで見るか (既定はプレビュー。行を指定して開いたときはソース) / history: 左にファイルの履歴を出すか
export type GroupView = { display?: "diff" | "file"; format?: "unified" | "split"; md?: "preview" | "source"; history?: boolean }
const VIEW_KEYS = ["display", "format", "md", "history"] as const

// タブに付けて開くと、グループの表示も変える (検索結果の行から開くときの「全体」「ソース」など。値を undefined にすると既定に戻す)。
// rev はタブごと: 履歴で選んだもの (コミットのハッシュか "uncommitted")。選んでいる間は、本文をその差分にする
export type DocView = GroupView & { rev?: string }

export type DocTab =
  | ({ kind: "file"; path: string; line?: number } & DocView)
  // oldPath: 名前を変えたときの元のパス (差分を取るのに使う。タブの識別には使わない)
  | ({ kind: "diff"; path: string; oldPath?: string; base: DiffBase } & DocView)
  | { kind: "commit"; hash: string }

export function baseKey(b: DiffBase) {
  return b.type === "uncommitted" ? "uncommitted" : `${b.branch}${b.includeUncommitted ? "+wt" : ""}`
}

export function baseLabel(b: DiffBase) {
  return b.type === "uncommitted" ? "HEAD...作業ツリー" : `${b.branch}...${b.includeUncommitted ? "作業ツリー" : "HEAD"}`
}

export type Group = { type: "group"; id: string; tabs: DocTab[]; activeKey: string | null; view?: GroupView }
export type Split = { type: "split"; id: string; orientation: "horizontal" | "vertical"; children: LayoutNode[] }
export type LayoutNode = Group | Split
export type Layout = { root: LayoutNode; activeGroupId: string }
export type DropZone = "center" | "left" | "right" | "top" | "bottom"

export function tabKey(t: DocTab) {
  if (t.kind === "commit") return `commit:${t.hash}`
  if (t.kind === "diff") return `diff:${baseKey(t.base)}:${t.path}`
  return `file:${t.path}`
}

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`

export function createLayout(tabs: DocTab[] = []): Layout {
  const id = newId("g")
  return { root: { type: "group", id, tabs, activeKey: tabs[0] ? tabKey(tabs[0]) : null }, activeGroupId: id }
}

export function groups(node: LayoutNode): Group[] {
  return node.type === "group" ? [node] : node.children.flatMap(groups)
}

export function findGroup(node: LayoutNode, id: string): Group | undefined {
  return groups(node).find((g) => g.id === id)
}

function mapGroup(node: LayoutNode, id: string, fn: (g: Group) => Group): LayoutNode {
  if (node.type === "group") return node.id === id ? fn(node) : node
  return { ...node, children: node.children.map((c) => mapGroup(c, id, fn)) }
}

// タブに付いたグループの表示 (GroupView) を取り出し、タブからは外す
function splitView(tab: DocTab): { tab: DocTab; patch: GroupView | null } {
  if (tab.kind === "commit" || !VIEW_KEYS.some((k) => k in tab)) return { tab, patch: null }
  const { display, format, md, history, ...rest } = tab
  const all = { display, format, md, history }
  const patch: GroupView = {}
  for (const k of VIEW_KEYS) if (k in tab) Object.assign(patch, { [k]: all[k] })
  return { tab: rest, patch }
}

function applyView(view: GroupView | undefined, patch: GroupView | null): GroupView | undefined {
  if (!patch) return view
  const next: GroupView = { ...view }
  for (const k of VIEW_KEYS) {
    if (!(k in patch)) continue
    if (patch[k] === undefined) delete next[k]
    else Object.assign(next, { [k]: patch[k] })
  }
  return next
}

// 開き直したタブに、履歴で選んだもの (rev) を引き継ぐ。rev を決めて開いたときと、表示 (差分 / 全体) を指定したときはやめる
function keepRev(old: DocTab, tab: DocTab, patch: GroupView | null): DocTab {
  if (old.kind === "commit" || tab.kind === "commit" || !old.rev || "rev" in tab || patch?.display) return tab
  return { ...tab, rev: old.rev }
}

function addTab(g: Group, input: DocTab): Group {
  const { tab, patch } = splitView(input)
  const key = tabKey(tab)
  const exists = g.tabs.some((t) => tabKey(t) === key)
  // 既に開いている場合は差し替える (行番号などを更新するため)
  const tabs = exists ? g.tabs.map((t) => (tabKey(t) === key ? keepRev(t, tab, patch) : t)) : [...g.tabs, tab]
  return { ...g, tabs, activeKey: key, view: applyView(g.view, patch) }
}

function removeTab(g: Group, key: string): Group {
  const idx = g.tabs.findIndex((t) => tabKey(t) === key)
  if (idx < 0) return g
  const tabs = g.tabs.filter((_, i) => i !== idx)
  const activeKey = g.activeKey === key ? (tabs[Math.min(idx, tabs.length - 1)] ? tabKey(tabs[Math.min(idx, tabs.length - 1)]) : null) : g.activeKey
  return { ...g, tabs, activeKey }
}

// 空のグループを取り除き、子が 1 つの split を畳み、同じ向きの入れ子 split を平らにする
function normalize(node: LayoutNode): LayoutNode | null {
  if (node.type === "group") return node.tabs.length ? node : null
  const children: LayoutNode[] = []
  for (const c of node.children) {
    const n = normalize(c)
    if (!n) continue
    if (n.type === "split" && n.orientation === node.orientation) children.push(...n.children)
    else children.push(n)
  }
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children }
}

function finalize(root: LayoutNode, activeGroupId: string): Layout {
  const n = normalize(root)
  if (!n) return createLayout()
  const all = groups(n)
  return { root: n, activeGroupId: all.some((g) => g.id === activeGroupId) ? activeGroupId : all[0].id }
}

function insertBeside(node: LayoutNode, targetId: string, newGroup: Group, zone: Exclude<DropZone, "center">): LayoutNode {
  const orientation = zone === "left" || zone === "right" ? "horizontal" : "vertical"
  const before = zone === "left" || zone === "top"
  const wrap = (target: LayoutNode): Split => ({
    type: "split",
    id: newId("s"),
    orientation,
    children: before ? [newGroup, target] : [target, newGroup],
  })
  if (node.type === "group") return node.id === targetId ? wrap(node) : node

  const idx = node.children.findIndex((c) => c.type === "group" && c.id === targetId)
  if (idx >= 0) {
    if (node.orientation === orientation) {
      const children = [...node.children]
      children.splice(before ? idx : idx + 1, 0, newGroup)
      return { ...node, children }
    }
    return { ...node, children: node.children.map((c, i) => (i === idx ? wrap(c) : c)) }
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, newGroup, zone)) }
}

// ---------------------------------------------------------------------------
// 公開する操作
// ---------------------------------------------------------------------------

export function openTab(layout: Layout, tab: DocTab, groupId = layout.activeGroupId): Layout {
  const target = findGroup(layout.root, groupId) ? groupId : groups(layout.root)[0].id
  return { root: mapGroup(layout.root, target, (g) => addTab(g, tab)), activeGroupId: target }
}

export function activateTab(layout: Layout, groupId: string, key: string): Layout {
  return { root: mapGroup(layout.root, groupId, (g) => ({ ...g, activeKey: key })), activeGroupId: groupId }
}

export function focusGroup(layout: Layout, groupId: string): Layout {
  return layout.activeGroupId === groupId ? layout : { ...layout, activeGroupId: groupId }
}

export function closeTab(layout: Layout, groupId: string, key: string): Layout {
  const root = mapGroup(layout.root, groupId, (g) => removeTab(g, key))
  // 最後のグループは空でも残す
  if (groups(root).length === 1) return { root, activeGroupId: groups(root)[0].id }
  return finalize(root, layout.activeGroupId)
}

// すべてのタブを閉じ、空のグループ 1 つに戻す (分割もなくす)
export function closeAllTabs(): Layout {
  return createLayout()
}

// タブをグループへ移動する。zone が端なら、そのグループを分割して新しいグループを作る
export function moveTab(layout: Layout, tab: DocTab, fromGroupId: string | null, toGroupId: string, zone: DropZone): Layout {
  const key = tabKey(tab)
  const from = fromGroupId ? findGroup(layout.root, fromGroupId) : undefined
  if (from && fromGroupId === toGroupId && (zone === "center" || from.tabs.length === 1)) {
    return activateTab(layout, toGroupId, key)
  }

  let root = layout.root
  let activeGroupId = toGroupId
  // 移したタブは、移した先のグループの表示に従う。分割して作ったグループは、元のグループの表示を引き継ぐ
  const moved = splitView(tab).tab
  if (zone === "center") {
    root = mapGroup(root, toGroupId, (g) => addTab(g, moved))
  } else {
    const g: Group = { type: "group", id: newId("g"), tabs: [moved], activeKey: key, view: (from ?? findGroup(root, toGroupId))?.view }
    root = insertBeside(root, toGroupId, g, zone)
    activeGroupId = g.id
  }
  if (from) root = mapGroup(root, from.id, (g) => removeTab(g, key))
  return finalize(root, activeGroupId)
}
