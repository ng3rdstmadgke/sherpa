# API

[overview.md](overview.md) から分けた、サーバーの API。型は `web/src/lib/types.ts` (サーバーとブラウザで共有)、Route Handler は `web/src/app/api/**/route.ts`。

## 1. 共通

- JSON を返す。パスは worktree の直下からの相対パス (`/` 区切り、先頭に `/` なし)
- worktree を対象にする API は `/api/projects/:projectId/worktrees/:worktreeId/<action>` の下に置く (以下 `…/wt` と略す)。1 つの catch-all の Route Handler (`[...rest]/route.ts`) が振り分ける
- エラーは HTTP のステータスと `{ error: { code: ErrorCode; message: string } }` で返す。`message` は画面にそのまま出せる日本語
- 書き込み (GET / HEAD / OPTIONS 以外) は `Content-Type: application/json` のときだけ受け付ける ([security.md](security.md) §2)
- Route Handler はキャッシュしない (Next.js 16 の既定)。`page.tsx` と `layout.tsx` は `connection()` で要求のたびに描画する

## 2. エンドポイント

| メソッド・パス | リクエスト | レスポンス |
| --- | --- | --- |
| `GET /api/health` | | `{ git: { ok, version? }, rg: { ok, version? }, home }` |
| `GET /api/projects` | | `Project[]` (worktree と、その branch / ahead / behind / changes / lastCommit を含む) |
| `POST /api/projects` | `ProjectInput` (`path` あり) | `Project` |
| `GET /api/projects/detect?path=` | | `DetectResult` |
| `PATCH /api/projects/:id` | `ProjectInput` (`path` なし) | `Project` |
| `DELETE /api/projects/:id` | `{}` | `{}` |
| `GET /api/settings` / `PUT /api/settings` | `{ excludes?: string[]; codeFontSize?: number; markdownFontSize?: number }` (送った項目だけを変える) | `{ excludes; codeFontSize; markdownFontSize }` |
| `GET /api/ui-state` | | `Record<string, unknown>` |
| `PUT /api/ui-state` (POST も同じ) | `{ set?: Record<string, unknown>; deletePrefixes?: string[] }` | `{}` |
| `GET /api/fs/dirs?dir=` | `""` (→ `~` だけ) か `~/foo/` のような末尾 `/` 付き | `PathEntry[]` (ディレクトリだけ。2,000 件まで) |
| `GET /api/events?watch=<projectId>/<worktreeId>,…` | | SSE ([live-reload.md](live-reload.md) §3) |
| `GET …/wt/tree?ignored=0\|1` | | `TreeResult` (`{ nodes: FileNode[]; truncated }`) |
| `GET …/wt/tree/children?path=` | lazy のディレクトリ | `FileNode[]` |
| `GET …/wt/dir?dir=` | `""` か末尾 `/` 付きの相対パス | `PathEntry[]` (`gitignore` の印) |
| `GET …/wt/spec?input=` | SPEC 欄の入力 | `SpecResult` (`{ nodes; count; truncated }`) |
| `PUT …/wt/spec-paths` | `{ input: string }` | `{}` |
| `GET …/wt/file?path=` | | `FileContent` |
| `GET …/wt/raw?path=&rev=` | `rev` は省略 (作業ツリー) かコミットのハッシュ | ファイルのバイト列 |
| `GET …/wt/changes` | | `Change[]` |
| `GET …/wt/branches` | | `Branch[]` |
| `GET …/wt/compare?branch=&includeUncommitted=0\|1` | | `CompareResult` |
| `GET …/wt/diff?path=&oldPath=&base=` | `base` は `uncommitted` / `branch:<b>` / `branch-wt:<b>` / `commit:<hash>` | `DiffResult` |
| `GET …/wt/commits/:hash` | | `Commit` (`files` あり) |
| `GET …/wt/search/content?q=&caseSensitive=&wholeWord=&regex=&include=&exclude=&ignored=` | 真偽値は `0` / `1` | `ContentSearchResult` (`{ hits; truncated }`) |
| `GET …/wt/search/files?…(同上)` | | `NameSearchResult` (`{ files: { path, ignored }[]; truncated }`) |

## 3. 主な型

```ts
type Project = {
  id: string; name: string; path: string /* 絶対パス */; color: string
  pathMappings: { container: string; host: string }[]
  excludes: string[] // 全体の設定に追加するパターン
  defaultCompareBranch: string | null // null は自動
  autoCompareBranch: string | null // 自動のときに実際に使うブランチ
  missing: boolean; error?: string
  worktrees: Worktree[]
}

type Worktree = {
  id: string // "main" か .git/worktrees/<id>
  name: string; branch: string | null /* null はブランチにない HEAD */; head: string
  hostPath: string; containerPath?: string; relPath: string
  isMain: boolean; missing: boolean
  ahead: number; behind: number // 既定の比較対象に対して
  changes: number // 未コミットの変更ファイル数 (Untracked を含む)
  lastCommit: { hash: string; message: string; date: string /* ISO 8601 */ } | null
  specPaths: string // SPEC 欄の保存値
}

type FileNode = { name: string; path: string; type: "file" | "dir"; children?: FileNode[]; ignored?: boolean; lazy?: boolean; symlink?: boolean }
type Change = { path: string; oldPath?: string; status: "M" | "A" | "D" | "U" | "R"; additions: number; deletions: number; binary?: boolean }
type Commit = { hash: string; shortHash: string; message: string; body: string; author: string; date: string; parents: string[]; fileCount: number; files?: Change[] }
type Branch = { name: string; ref: string; remote: boolean; date: string }
type SearchHit = { path: string; line: number; text: string; matches: { start: number; end: number }[] } // matches は UTF-16 の位置

type FileContent =
  | { kind: "text"; content: string; size: number; highlight: boolean; invalidUtf8?: boolean }
  | { kind: "image"; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number }
  | { kind: "symlink"; target: string; outside: boolean }

type DiffLine = { type: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number }
type DiffResult =
  | { kind: "text"; lines: DiffLine[]; additions: number; deletions: number; partial?: boolean }
  | { kind: "image"; before: { rev: string | null; path: string } | null; after: { rev: string | null; path: string } | null }
  | { kind: "binary" }

type CompareResult = {
  branch: string; ref: string
  mergeBase: string | null // 共通の祖先がなければ null (files / commits は空)
  ahead: number; behind: number
  commits: Commit[] // files なし
  moreCommits: number // 一覧に入らなかったコミットの数
  files: Change[]
}
```

時刻は ISO 8601 で返し、「2時間前」のような表示はブラウザで作る (`web/src/lib/format.ts`)。パスは絶対パスで返し、表示するときに `~` に縮める。

## 4. エラー

| 状況 | コード | 画面 |
| --- | --- | --- |
| git が入っていない | `GIT_NOT_FOUND` | 全画面の上に帯「git が見つかりません」 |
| rg が見つからない | `RG_NOT_FOUND` | 検索欄の下に文言 |
| 登録: ディレクトリがない / git リポジトリでない / worktree / 登録済み | `NOT_FOUND` / `NOT_GIT_REPO` / `LINKED_WORKTREE` / `ALREADY_REGISTERED` | ダイアログに文言を出し、「登録」を押せなくする |
| プロジェクトが見つからない | `PROJECT_NOT_FOUND` | |
| 登録した後にディレクトリが消えた | (`Project.missing`) | カードに「ディレクトリが見つかりません」 |
| worktree が消えた | `WORKTREE_MISSING` (`Worktree.missing`) | カード・選択肢では薄く出して選べなくする。開いていたタブは「worktree が見つかりません」と main に切り替えるボタン |
| HEAD がブランチにない | (エラーにしない) | `(detached) 2ff64ad`。COMPARE・HISTORY は `HEAD` のまま動く |
| コミットがない | (エラーにしない) | 未コミットの差分は空のツリーと比べる。HISTORY は空 |
| 比較対象のブランチがない | `NO_COMPARE_BRANCH` | 比較の選択に「未選択」。COMPARE・HISTORY・エクスプローラの記号は空 |
| 比較対象のブランチが消えた | `BRANCH_NOT_FOUND` | 選択欄を赤くし、COMPARE に「<branch> が見つかりません」 |
| 共通の祖先がない | (`CompareResult.mergeBase = null`。差分は 409 `GIT_FAILED`) | COMPARE に「<branch> と共通の祖先がありません」 |
| ファイルが消えた・読めない | `NOT_FOUND` / `FORBIDDEN` | タブの中身に文言。自動更新で戻れば表示し直す |
| パスが不正・外を指す | `INVALID_PATH` / `OUTSIDE` | 400 / 403 |
| git が失敗した・時間内に終わらない | `GIT_FAILED` | そのセクションに git のエラーの 1 行目 |
| 正規表現が正しくない | `INVALID_REGEX` | 検索欄の下 |
| リクエストが正しくない | `INVALID_REQUEST` | |
| それ以外 | `INTERNAL` | |

## 5. ブラウザ側の取得 (`web/src/lib/api.ts`)

- TanStack Query を使う。キーは `["wt", projectId, worktreeId, 種類, 引数]`。自動更新の通知でその worktree のキーをまとめて無効にする ([live-reload.md](live-reload.md) §4)
- 既定で 10 秒は取り直さない。4xx はやり直さない。検索・ツリー・COMPARE などは、取り直す間も前の結果を出したままにする (`keepPreviousData`)
- worktree を対象にするフックは、`ProjectWorkspace` が配る `WtContext` から対象の worktree を読む
- 読み込み中は、各セクションに「読み込み中…」を 1 行出す (レイアウトは変えない)
