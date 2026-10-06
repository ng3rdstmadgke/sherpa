// サーバーとブラウザで共有する型。モックのダミーデータの型をもとにしている (docs/architecture/api.md §3)

import type { Match } from "./search"

export type { Match }

// 1 行ずつの差分。変更のない行も含めて持つので、ファイル全体の中で差分を表示したり、省略した部分を展開したりできる
export type DiffLine = { type: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number }

export type Worktree = {
  id: string // main worktree は "main"、それ以外は .git/worktrees/<id>
  name: string // 表示名 (worktree のディレクトリ名)
  branch: string | null // null はブランチにない HEAD
  head: string // 短いハッシュ (コミットがなければ "")
  hostPath: string // ホスト側の実パス
  containerPath?: string // devcontainer 内パス (git が記録しているパス)
  relPath: string // プロジェクトの直下からのパス (main worktree は "")
  isMain: boolean
  missing: boolean // ディレクトリが見つからない
  ahead: number // 既定の比較対象に対して
  behind: number
  changes: number // 未コミットの変更ファイル数 (Untracked を含む)
  lastCommit: { hash: string; message: string; date: string } | null
  specPaths: string // SPEC 欄の保存値
}

export type PathMapping = { container: string; host: string }

export type Project = {
  id: string
  name: string
  path: string // 絶対パス
  color: string
  pathMappings: PathMapping[]
  // 全体の設定の除外パターンに追加するパターン
  excludes: string[]
  // 既定の比較対象のブランチ。null なら自動 (main → master → develop)
  defaultCompareBranch: string | null
  // 自動のときに実際に使うブランチ (見つからなければ null)
  autoCompareBranch: string | null
  missing: boolean // ディレクトリが見つからない
  error?: string // git の実行に失敗したときの文言
  worktrees: Worktree[]
}

export type ProjectInput = {
  path?: string
  name: string
  pathMappings: PathMapping[]
  excludes: string[]
  defaultCompareBranch: string | null
}

export type DetectResult = {
  path: string
  exists: boolean
  isGitRepo: boolean
  isLinkedWorktree: boolean
  registered: boolean
  name: string
  pathMappings: PathMapping[]
  branches: Branch[]
  autoCompareBranch: string | null
}

export type FileNode = {
  name: string
  path: string
  type: "file" | "dir"
  children?: FileNode[]
  // .gitignore で無視されている (ディレクトリに付けると中身もすべて無視される)
  ignored?: boolean
  // 無視されたディレクトリで、中身をまだ読んでいない
  lazy?: boolean
  symlink?: boolean
}

export type PathEntry = { name: string; kind: "dir" | "file"; badges?: string[] }

export type ChangeStatus = "M" | "A" | "D" | "U" | "R"

export type Change = {
  path: string
  oldPath?: string // 名前を変えたときの元のパス
  status: ChangeStatus
  additions: number
  deletions: number
  binary?: boolean
}

export type Commit = {
  hash: string // 40 桁
  shortHash: string
  message: string // 件名
  body: string // 件名より後
  author: string
  date: string // ISO 8601
  parents: string[]
  fileCount: number
  files?: Change[] // 詳細 (GET …/commits/:hash) だけ
}

// 1 ファイルの履歴の 1 件。change はそのコミットでのそのファイルの変更 (名前を変えたときは oldPath がある)
export type FileCommit = Commit & { change: Change }
export type FileHistory = { commits: FileCommit[]; truncated: boolean }
// 1 ファイルの履歴を一度に読む件数の上限
export const MAX_FILE_HISTORY = 5000

// 1 ファイルの blame (作業ツリーの今の内容に対して)。lines は 1 行ずつの本文、hunks は同じコミットの行のまとまり (start は 1 から)。
// 未コミットの行は hash が UNCOMMITTED_HASH (40 桁の 0) になる
// path: そのコミットでのファイルのパス (後で名前を変えたファイルは、今のパスと違う)
export type BlameCommit = { hash: string; shortHash: string; author: string; date: string; summary: string; path: string }
export type BlameHunk = { hash: string; start: number; count: number }
export type BlameResult = { lines: string[]; hunks: BlameHunk[]; commits: Record<string, BlameCommit> }
export const UNCOMMITTED_HASH = "0".repeat(40)
// blame するファイルの大きさの上限 (git blame は履歴をたどるので、ファイルの表示より小さくする)
export const MAX_BLAME_BYTES = 1024 * 1024

export type Branch = { name: string; ref: string; remote: boolean; date: string }

export type SearchHit = { path: string; line: number; text: string; matches: Match[] }

export type ContentSearchResult = { hits: SearchHit[]; truncated: boolean }
export type NameSearchResult = { files: { path: string; ignored: boolean }[]; truncated: boolean }

export type FileContent =
  | { kind: "text"; content: string; size: number; highlight: boolean; invalidUtf8?: boolean }
  | { kind: "image"; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number }
  | { kind: "symlink"; target: string; outside: boolean }

// 差分の片側。rev が null なら作業ツリー
export type DiffSide = { rev: string | null; path: string }

export type DiffResult =
  | { kind: "text"; lines: DiffLine[]; additions: number; deletions: number; partial?: boolean }
  | { kind: "image"; before: DiffSide | null; after: DiffSide | null }
  | { kind: "binary" }

export type CompareResult = {
  branch: string
  ref: string
  mergeBase: string | null // 共通の祖先がなければ null
  ahead: number
  behind: number
  commits: Commit[]
  moreCommits: number // 一覧に入らなかったコミットの数
  files: Change[]
}

export type TreeResult = { nodes: FileNode[]; truncated: boolean }
export type SpecResult = { nodes: FileNode[]; count: number; truncated: boolean }

export type Health = { git: { ok: boolean; version?: string }; rg: { ok: boolean; version?: string }; home: string }

export type WatchEvent =
  | { type: "files"; projectId: string; worktreeId: string; paths: string[]; structure: boolean }
  | { type: "git"; projectId: string; worktreeId: string }
  | { type: "worktrees"; projectId: string }
  | { type: "projects" }
  | { type: "watch-error"; projectId: string; worktreeId: string; message: string }

export type ErrorCode =
  | "GIT_NOT_FOUND"
  | "RG_NOT_FOUND"
  | "NOT_FOUND"
  | "NOT_GIT_REPO"
  | "LINKED_WORKTREE"
  | "ALREADY_REGISTERED"
  | "PROJECT_NOT_FOUND"
  | "WORKTREE_MISSING"
  | "NO_COMPARE_BRANCH"
  | "BRANCH_NOT_FOUND"
  | "INVALID_PATH"
  | "OUTSIDE"
  | "FORBIDDEN"
  | "INVALID_REGEX"
  | "INVALID_REQUEST"
  | "GIT_FAILED"
  | "INTERNAL"

export type ApiErrorBody = { error: { code: ErrorCode; message: string } }

// 既定の比較対象: プロジェクトの設定があればそれ、なければ main → master → develop の順に探す
export const AUTO_COMPARE_BRANCHES = ["main", "master", "develop"]
