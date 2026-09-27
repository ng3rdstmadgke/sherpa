"use client"

import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react"
import { TreeContextMenu } from "./tree-context-menu"

// パスを持つ項目の一覧を、ディレクトリの入れ子のツリーで表示する (Git パネルの変更ファイル一覧で使う)

type Dir<T> = { name: string; path: string; dirs: Dir<T>[]; files: T[] }

function buildTree<T extends { path: string }>(items: T[]): Dir<T> {
  const root: Dir<T> = { name: "", path: "", dirs: [], files: [] }
  for (const item of items) {
    let dir = root
    for (const name of item.path.split("/").slice(0, -1)) {
      let next = dir.dirs.find((d) => d.name === name)
      if (!next) {
        next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: [], files: [] }
        dir.dirs.push(next)
      }
      dir = next
    }
    dir.files.push(item)
  }
  const sort = (d: Dir<T>) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name))
    d.files.sort((a, b) => a.path.localeCompare(b.path))
    d.dirs.forEach(sort)
  }
  sort(root)
  return root
}

// 階層の深さに応じた左の余白 (px)。ファイル行はディレクトリの矢印の分だけ右に寄せる
export function treeIndent(depth: number, kind: "dir" | "file") {
  return depth * 12 + (kind === "dir" ? 8 : 26)
}

export function PathTree<T extends { path: string }>({
  items,
  renderFile,
}: {
  items: T[]
  renderFile: (item: T, depth: number) => React.ReactNode
}) {
  const root = useMemo(() => buildTree(items), [items])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (p: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(p)) n.delete(p)
      else n.add(p)
      return n
    })

  const renderDir = (dir: Dir<T>, depth: number): React.ReactNode => (
    <>
      {dir.dirs.map((d) => {
        const open = !collapsed.has(d.path)
        return (
          <div key={d.path}>
            <button
              data-tree-path={d.path}
              onClick={() => toggle(d.path)}
              className="flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left text-sm hover:bg-accent"
              style={{ paddingLeft: treeIndent(depth, "dir") }}
            >
              {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
              {open ? <FolderOpen className="size-4 shrink-0 text-sky-500" /> : <Folder className="size-4 shrink-0 text-sky-500" />}
              <span className="truncate">{d.name}</span>
            </button>
            {open && renderDir(d, depth + 1)}
          </div>
        )
      })}
      {dir.files.map((f) => (
        <div key={f.path}>{renderFile(f, depth)}</div>
      ))}
    </>
  )

  return (
    <TreeContextMenu>
      <div className="px-1">{renderDir(root, 0)}</div>
    </TreeContextMenu>
  )
}
