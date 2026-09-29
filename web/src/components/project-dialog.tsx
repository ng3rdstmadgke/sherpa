"use client"

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ExternalLink } from "lucide-react"
import { AUTO_COMPARE_BRANCHES, type Project, type ProjectInput } from "@/lib/types"
import { api, errorMessage, listHostDir, listWorktreeDir, useDetect } from "@/lib/api"
import { parseExcludeLines } from "@/lib/excludes"
import { tildify } from "@/lib/format"
import { PathSuggestInput } from "@/components/path-suggest-input"
import { useAppNav } from "@/components/app-nav"

// プロジェクトの登録 / 編集ダイアログ。project を渡すと編集になる。SQLite に保存する
export function ProjectDialog({
  project,
  triggerLabel,
  open,
  onOpenChange,
}: {
  project?: Project
  // ダイアログを開くボタンの中身。渡さない場合は open / onOpenChange で開閉する
  triggerLabel?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  // 開閉は外から渡されたものを使い、なければ自分で持つ (開くボタンで開く場合)
  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  const setOpen = onOpenChange ?? setInnerOpen

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {triggerLabel && <DialogTrigger render={<Button />}>{triggerLabel}</DialogTrigger>}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {/* 開くたびに作り直し、入力を保存済みの値から始める */}
        {isOpen && <ProjectForm project={project} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ProjectForm({ project, close }: { project?: Project; close: () => void }) {
  const editing = !!project
  const nav = useAppNav()
  const qc = useQueryClient()
  const [path, setPath] = useState(project ? tildify(project.path) : "~/")
  // 末尾が / の途中の入力 (候補を選んでいる途中) は調べない
  const detectPath = editing ? project.path : /\/$/.test(path) && path !== "~/" ? path.replace(/\/+$/, "") : path
  const detect = useDetect(detectPath && detectPath !== "~" ? detectPath : null)
  const d = detect.data
  const dirName = path.replace(/\/+$/, "").split("/").pop() ?? ""
  // 表示名・コンテナのパス・ホストのパスは、手で書き換えるまで自動の値を使う
  const [name, setName] = useState<string | null>(project?.name ?? null)
  const [container, setContainer] = useState<string | null>(project?.pathMappings[0]?.container ?? null)
  const [hostPath, setHostPath] = useState<string | null>(project?.pathMappings[0] ? tildify(project.pathMappings[0].host) : null)
  // devcontainer を使うか。手で切り替えるまでは、編集ではマッピングがあるか、登録では自動の検出で見つかったか
  const [useMapping, setUseMapping] = useState<boolean | null>(project ? project.pathMappings.length > 0 : null)
  const [excludes, setExcludes] = useState((project?.excludes ?? []).join("\n"))
  // "" は自動 (main → master → develop の順に探す)
  const [compareBranch, setCompareBranch] = useState(project?.defaultCompareBranch ?? "")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const detected = (d?.pathMappings.length ?? 0) > 0
  const mappingOn = useMapping ?? detected
  const containerValue = container ?? d?.pathMappings[0]?.container ?? `/workspaces/${dirName}`
  const hostValue = hostPath ?? (editing ? tildify(project.path) : path.replace(/\/+$/, ""))
  const branches = d?.branches ?? []
  const listExcludeDir = useMemo(() => (project ? listWorktreeDir({ projectId: project.id, worktreeId: "main" }) : async () => []), [project])

  // 登録できない理由 (ディレクトリがない・git リポジトリでない・worktree・登録済み)
  const problem = editing
    ? null
    : !d || detect.isFetching
      ? null
      : !d.exists
        ? "ディレクトリが見つかりません"
        : d.isLinkedWorktree
          ? "worktree のディレクトリです。main worktree のディレクトリを登録してください"
          : !d.isGitRepo
            ? "git リポジトリではありません"
            : d.registered
              ? "登録済みです"
              : null
  const canSave = editing || (!!d && !problem && !detect.isFetching && d.path.replace(/\/+$/, "") !== "")

  const save = async () => {
    setSaving(true)
    setError(null)
    const body: ProjectInput = {
      path: editing ? undefined : path,
      name: name ?? d?.name ?? dirName,
      pathMappings: mappingOn ? [{ container: containerValue, host: hostValue }] : [],
      excludes: parseExcludeLines(excludes),
      defaultCompareBranch: compareBranch || null,
    }
    try {
      if (editing) await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body })
      else await api("/api/projects", { method: "POST", body })
      await qc.invalidateQueries({ queryKey: ["projects"] })
      await qc.invalidateQueries({ queryKey: ["wt"] })
      close()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? `プロジェクトの設定: ${project.name}` : "プロジェクトを登録"}</DialogTitle>
        <DialogDescription>
          {editing ? "変更は、このプロジェクトのすべてのタブに反映されます。" : "git リポジトリのディレクトリを指定します。worktree は自動で検出されます。"}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label>ディレクトリ</Label>
          {editing ? (
            <p className="font-mono text-sm">{tildify(project.path)}</p>
          ) : (
            <>
              <PathSuggestInput value={path} onChange={setPath} list={listHostDir} listKey="host" dirsOnly className="font-mono" placeholder="~/project" />
              {problem ? (
                <p className="text-xs text-destructive">{problem}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  入力すると、サーバーのディレクトリを候補に出します (git リポジトリには「git」、登録済みには「登録済み」の印)。Tab で補完します。
                </p>
              )}
              {detect.error && <p className="text-xs text-destructive">{errorMessage(detect.error)}</p>}
            </>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>表示名</Label>
          <Input value={name ?? d?.name ?? dirName} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={mappingOn} onCheckedChange={(v) => setUseMapping(!!v)} />
            devcontainer を使う (パスマッピング)
            {!editing && d && useMapping === null && (
              <Badge variant="secondary" className="text-[10px]">
                {detected ? "自動検出" : "devcontainer の設定なし"}
              </Badge>
            )}
          </label>
          {mappingOn ? (
            <>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-sm">
                <span className="text-xs text-muted-foreground">コンテナ</span>
                <Input value={containerValue} onChange={(e) => setContainer(e.target.value)} className="h-7 font-mono text-xs" />
                <span className="text-xs text-muted-foreground">ホスト</span>
                <PathSuggestInput value={hostValue} onChange={setHostPath} list={listHostDir} listKey="host" dirsOnly className="h-7 font-mono text-xs md:text-xs" />
              </div>
              <p className="text-xs text-muted-foreground">
                .devcontainer/devcontainer.json の workspaceFolder (未指定なら worktree の .git に記録されたパスか /workspaces/&lt;dir&gt;) から推定。worktree の .git が指すコンテナ内パスを読み替えます。
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              コンテナの中で worktree を作っていなければ不要です。devcontainer の中で作った worktree を開くときは、ON にしてコンテナのパスを指定します。
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="default-compare">既定の比較対象のブランチ</Label>
          <p className="text-xs text-muted-foreground">このプロジェクトのタブを新しく開いたときの比較対象です。タブの中では worktree バーの「比較」で変えられます。</p>
          <div className="flex items-center gap-2">
            <select
              id="default-compare"
              value={compareBranch}
              onChange={(e) => setCompareBranch(e.target.value)}
              className="h-8 w-72 min-w-0 rounded-lg border border-input bg-transparent px-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="">自動 ({AUTO_COMPARE_BRANCHES.join(" → ")})</option>
              {compareBranch && !branches.some((b) => b.name === compareBranch) && <option value={compareBranch}>{compareBranch} (見つかりません)</option>}
              <optgroup label="ローカル">
                {branches
                  .filter((b) => !b.remote)
                  .map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="リモート">
                {branches
                  .filter((b) => b.remote)
                  .map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
              </optgroup>
            </select>
            {!compareBranch && d && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {d.autoCompareBranch ? (
                  <>
                    → <span className="font-mono">{d.autoCompareBranch}</span> を使います
                  </>
                ) : (
                  "→ 該当するブランチがありません"
                )}
              </span>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>表示しないパス (除外パターン)</Label>
          <p className="text-xs text-muted-foreground">
            エクスプローラ・SPEC・検索のどれにも出しません。「gitignore」ボタンを ON にしても表示しません。git で管理されているがノイズになるものを追加します。
          </p>
          <p className="text-xs text-muted-foreground">
            全体の設定の除外パターンも適用されます。
            <button
              type="button"
              onClick={() => {
                close()
                nav.openSettings("excludes")
              }}
              className="ml-1 inline-flex items-center gap-0.5 text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400"
            >
              全体の設定を開く <ExternalLink className="size-3" />
            </button>
          </p>
          <PathSuggestInput
            multiline
            value={excludes}
            onChange={setExcludes}
            list={listExcludeDir}
            listKey={project ? `wt:${project.id}/main` : "none"}
            separator={"\n"}
            dirGlob="**"
            placeholder={"このプロジェクトで追加するパターン (1 行に 1 つ)\n例: archives/**"}
            className="font-mono text-xs md:text-xs"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>キャンセル</DialogClose>
        <Button onClick={save} disabled={!canSave || saving}>
          {editing ? "保存" : "登録"}
        </Button>
      </DialogFooter>
    </>
  )
}
