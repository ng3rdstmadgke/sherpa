# sherpa 本実装の計画

> **初回の実装のときの資料 (更新しない)**。最新の仕様と仕組みは `docs/architecture/overview.md`、開発の手順は `docs/how-to/development/` にある。

モック (ダミーデータで動く画面) を、実際のリポジトリを読むアプリにするための計画。画面の仕様は `docs/agent-tasks/init/spec-draft.md`、画面の動きはモック (`mock/`) を正とする。

## 0. 方針

- `web/src/components` の画面部品はそのまま使い、`@/lib/mock-data` から読んでいる所だけを API の呼び出しに置き換える。最後に `mock-data.ts` と `public/mock/` を消す
- `mock-data.ts` の関数と型を API の設計図にする (§2.4 に対応表)。型は `web/src/lib/types.ts` に移し、サーバーとブラウザで共有する
- サーバーは Next.js の Route Handler (Node.js ランタイム) から `fs`・`git`・`rg` を呼ぶ。保存は SQLite (better-sqlite3 + Drizzle)。監視は chokidar、通知は SSE
- 閲覧専用。git で書き込む操作 (fetch / checkout / add / worktree prune / gc など) は実行しない。すべての git に `GIT_OPTIONAL_LOCKS=0` を付ける
- 画面から直すのは、データの形が変わるために避けられない所だけにする (§2.2)

## 1. 構成

### 1.1 ディレクトリ

```
web/
  proxy.ts                    Host / Origin の確認 (§6.1)。Next.js 16 で middleware.ts から proxy.ts に名前が変わった
  instrumentation.ts          起動時に git / rg の有無を確かめ、DB のマイグレーションを流す
  drizzle.config.ts
  drizzle/                    drizzle-kit generate で作るマイグレーションの SQL
  scripts/check-real-repos.ts 実際のリポジトリに対する読み取り専用の確認 (§10.3)
  src/
    app/api/**/route.ts       Route Handler。引数を確かめて src/server を呼ぶだけにする
    server/                   サーバー専用 (先頭で import "server-only")
      db/schema.ts, db/index.ts
      exec.ts                 git / rg の実行 (§3.1)
      paths.ts                パスの検証 (§6.2)
      projects.ts             登録・編集・worktree の検出 (§3.2)
      git/*.ts                status / diff / log / branches と、その出力のパース
      files.ts                一覧・内容・SPEC (§4)
      search.ts               rg (§4.5)
      watch.ts                chokidar と購読者の管理 (§5)
      errors.ts               ApiError とエラーコード (§8)
    lib/
      types.ts                サーバーとブラウザで共有する型 (mock-data.ts から移す)
      api.ts                  fetch の薄いラッパーと TanStack Query のフック
      excludes.ts, spec.ts    DEFAULT_EXCLUDES / isExcluded / parseSpecPaths / isSpec (mock-data.ts から移す。純粋な関数)
      glob.ts, search.ts, line-diff.ts, persist.ts, theme.ts  (既存)
  test/                       vitest (§10)
```

### 1.2 追加するパッケージ

| パッケージ | 用途 |
| --- | --- |
| `better-sqlite3`, `drizzle-orm`, `drizzle-kit` (dev) | SQLite。better-sqlite3 は Next.js の既定の外部パッケージの一覧に入っているので `serverExternalPackages` の指定はいらない |
| `chokidar` (v5) | ファイルの監視。v4 以降は glob を受け付けないので、`ignored` には関数を渡す |
| `@tanstack/react-query` | ブラウザ側の取得・キャッシュ。SSE の通知でキャッシュを無効にする (§2.5) |
| `jsonc-parser` | `devcontainer.json` (コメント付き JSON) を読む |
| `vitest`, `tsx` (dev) | テストと確認スクリプト |
| `@vscode/ripgrep` | rg の実行ファイル。開発サーバーには rg が入っていない (§A)。v1.18 は rg を npm の別パッケージ (`@vscode/ripgrep-linux-x64`) で同梱しているので、`npm install` だけで入る (ripgrep 15.0.0、PCRE2 付き。scratchpad で確認済み) |

Node は v24 (better-sqlite3 13 は Node 22 以上が必要)。

rg は `@vscode/ripgrep` の `rgPath` を使う (版を固定できるため、`PATH` の rg より優先する)。環境変数 `SHERPA_RG` があればそれを使う。

### 1.3 サーバーの共通の決まり

- 開発中の再読み込み (HMR) で監視や DB 接続が二重にならないよう、長く持つもの (DB、watcher、キャッシュ) は `globalThis.__sherpa` に置く
- git / rg は同時に 8 個までにする (大きなリポジトリの worktree を並べて開いたときに詰まらないように)
- Route Handler は既定でキャッシュされない (Next.js 16)。`cacheComponents` は使わない
- 起動は今までどおり `next dev -H 127.0.0.1` / `next start -H 127.0.0.1` (Next.js の既定は `0.0.0.0` なので、`-H` を消さない)

## 2. API の設計

### 2.1 共通

- JSON を返す。パスは worktree の直下からの相対パス (`/` 区切り、先頭に `/` なし)
- worktree を対象にする API は `/api/projects/:projectId/worktrees/:worktreeId/...` の下に置く。以下では `…/wt` と略す
  - `projectId`: 登録時にディレクトリ名から作る slug (`webapp`。重なれば `-2` を付ける)
  - `worktreeId`: main worktree は `main`、それ以外は `.git/worktrees/<id>` のディレクトリ名 (worktree のディレクトリ名と違うことがある)。URL ではエンコードする
- エラーは HTTP のステータスと `{ error: { code: ErrorCode; message: string } }` で返す (§8)。`message` は画面にそのまま出せる日本語にする
- 書き込み (POST / PUT / PATCH / DELETE) は `Content-Type: application/json` のときだけ受け付ける (§6.1)
- `?fresh=1` を付けると、サーバーのキャッシュ (§4.7) を使わずに取り直す (手動の再読み込みボタン)

### 2.2 型 (`lib/types.ts`)

mock-data.ts の型をもとにする。変えるのは次の所だけ。

| 型 | 変更 | 理由 |
| --- | --- | --- |
| `Worktree` | `relTime` をやめ `lastCommit.date` (ISO 8601) にする。`branch` は `string \| null` (null はブランチにない HEAD)、`head` (短いハッシュ)、`relPath` (プロジェクトの直下からのパス。ホームのカードの `.worktree/<name>` の表示に使う。モックは `.worktree/` を決め打ちしている)、`missing` (ディレクトリがない)、`specPaths` (SPEC 欄の保存値) を足す。`ahead` / `behind` は既定の比較対象に対する値 (§3.7) | 相対時間は表示のたびに計算しないと古くなる |
| `Project` | `path` は絶対パス (表示するときに `~` に縮める)。`pathMapping` は `pathMappings: { container: string; host: string }[]` にする (画面は 1 行だけ編集する)。`autoCompareBranch` (自動のときに実際に使うブランチ。なければ null) を足す | worktree が別の場所にもある場合に備える |
| `Change` | `oldPath?` (名前を変えたときの元のパス) と `binary?` を足す。`staged` は画面で使っていないのでやめる。`status` の `U` は Untracked の意味のまま (git の unmerged ではない)。コンフリクト中のファイルは `M` にする | 名前の変更の差分を取るには元のパスがいる |
| `Commit` | `hash` は 40 桁、`shortHash` を足す。`relTime` をやめ `date` (ISO)。`body` (件名より後のメッセージ) と `parents` を足す。一覧 (`HISTORY`) では `files` の代わりに `fileCount` だけを返し、詳細 (`GET …/commits/:hash`) で `files` を返す | 一覧で全コミットの変更ファイルを取ると重い |
| `Branch` | `relTime` をやめ `date` (ISO)。`ref` (`refs/heads/main` など) を足す | 同じ名前のタグやファイルと取り違えない |
| `FileNode` | `lazy?: true` を足す (無視されたディレクトリで、中身をまだ読んでいない。§4.1)。`symlink?`、`submodule?` を足す | 大きな無視されたディレクトリを列挙しない |
| `SearchHit` | そのまま (`matches` は JS の文字列の位置。rg のバイト位置を変換する §4.5) | |
| 新規 | `FileContent`、`DiffResult`、`CompareResult`、`Health`、`WatchEvent`、`ApiErrorBody` (以下の表) | |

```ts
type FileContent =
  | { kind: "text"; content: string; size: number; highlight: boolean } // highlight: false はシンタックスハイライトしない大きさ
  | { kind: "image"; size: number; url: string }                        // url は /api/…/raw
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number }
  | { kind: "symlink"; target: string; outside: boolean }              // worktree の外を指すリンクは中身を読まない

type DiffBaseParam = "uncommitted" | `branch:${string}` | `branch-wt:${string}` | `commit:${string}` // DiffBase をクエリにしたもの

type DiffResult =
  | { kind: "text"; lines: DiffLine[]; additions: number; deletions: number }
  | { kind: "image"; before?: string; after?: string } // raw の URL
  | { kind: "binary" }
  | { kind: "too-large"; lines: DiffLine[] }           // 前後 3 行だけ。「N 行を表示」で展開できない

type CompareResult = {
  branch: string
  ref: string
  mergeBase: string | null // 共通の祖先がなければ null (files / commits は空)
  ahead: number
  behind: number
  commits: Commit[]        // files なし、fileCount あり
  files: Change[]
}

type WatchEvent =
  | { type: "files"; projectId: string; worktreeId: string; paths: string[]; structure: boolean } // structure: 追加・削除を含む
  | { type: "git"; projectId: string; worktreeId: string }                                        // HEAD / index / refs の変化
  | { type: "worktrees"; projectId: string }                                                      // worktree の追加・削除
  | { type: "projects" }                                                                          // 登録・編集・登録の解除
```

### 2.3 エンドポイント

| メソッド・パス | リクエスト | レスポンス | 使う所 |
| --- | --- | --- | --- |
| `GET /api/health` | | `{ git: { ok, version }, rg: { ok, version }, home: string }` | 起動時。git / rg がないときの帯 (§8) |
| `GET /api/projects` | | `Project[]` (worktree と、その branch / ahead / behind / changes / lastCommit を含む) | ホーム、一番上のタブ、`+` メニュー、worktree の選択 |
| `POST /api/projects` | `{ path, name, pathMappings, excludes, defaultCompareBranch }` | `Project` | 登録 |
| `PATCH /api/projects/:id` | 同上から `path` を除いたもの | `Project` | 編集 |
| `DELETE /api/projects/:id` | | `{}` | 登録の解除 (§2.7) |
| `GET /api/projects/detect?path=` | | `{ path, isGitRepo, isLinkedWorktree, registered, name, pathMappings, branches: Branch[], autoCompareBranch }` | 登録ダイアログ。パスを入れたら、マッピングの自動検出とブランチの一覧を出す |
| `GET /api/settings` / `PUT /api/settings` | `{ excludes: string[] }` | `{ excludes: string[] }` | 全体の設定 |
| `GET /api/ui-state` | | `Record<string, unknown>` | 起動時 (実際は page.tsx が直接 DB から読む §2.6) |
| `PUT /api/ui-state` | `{ set?: Record<string, unknown>; deletePrefixes?: string[] }` | `{}` | persist.ts |
| `GET /api/fs/dirs?dir=` | `dir` は `~/` か `~/foo/` のような末尾 `/` 付き | `PathEntry[]` (ディレクトリだけ。`git` / `登録済み` の印) | ディレクトリ・ホストのサジェスト (`listHostDir`) |
| `GET …/wt/dir?dir=` | 末尾 `/` 付きの相対パス (`""` は直下) | `PathEntry[]` (`gitignore` の印) | 表示しないパス・SPEC 欄・検索の対象のサジェスト (`listWorktreeDir`) |
| `GET …/wt/tree?ignored=0\|1` | | `{ nodes: FileNode[]; truncated: boolean }` | エクスプローラ (§4.1) |
| `GET …/wt/tree/children?path=` | 無視されたディレクトリ | `FileNode[]` | 「gitignore」ON で `lazy` のディレクトリを開いたとき |
| `GET …/wt/spec?input=` | SPEC 欄の入力 | `{ nodes: FileNode[]; count: number; truncated: boolean }` | SPEC セクション、SPEC 欄の件数 |
| `PUT …/wt/spec-paths` | `{ input: string }` | `{}` | SPEC 欄の確定 |
| `GET …/wt/file?path=` | | `FileContent` | ファイルのタブ、Markdown |
| `GET …/wt/raw?path=&rev=` | `rev` は省略 (作業ツリー) かコミット | ファイルのバイト列 | 画像、Markdown の画像、画像の差分 |
| `GET …/wt/changes` | | `Change[]` | 未コミットの差分、アイコンのバッジ |
| `GET …/wt/branches` | | `Branch[]` | 比較対象の選択、プロジェクトの設定 |
| `GET …/wt/compare?branch=&includeUncommitted=0\|1` | | `CompareResult` | COMPARE、HISTORY、エクスプローラの記号と「変更のみ」、「差分を見る」、(i) の ↑↓ |
| `GET …/wt/diff?path=&oldPath=&base=` | `base` は `DiffBaseParam` | `DiffResult` | 差分のタブ、ファイル表示の「差分を見る」、コミットの詳細のアコーディオン |
| `GET …/wt/commits/:hash` | | `Commit` (`files` あり) | コミットの詳細 |
| `GET …/wt/search/content?q=&caseSensitive=&wholeWord=&regex=&include=&exclude=&ignored=` | | `{ hits: SearchHit[]; truncated: boolean }` か 400 `INVALID_REGEX` | 内容の検索 (§4.5) |
| `GET …/wt/search/files?q=&…(同上)` | | `{ files: { path: string; ignored: boolean }[]; truncated: boolean }` | ファイル名の検索 (「gitignore」ON のときだけ。§4.6) |
| `GET /api/events?watch=<projectId>/<worktreeId>,…` | | SSE (`WatchEvent`) | 自動更新 (§5) |

### 2.4 mock-data.ts との対応

| mock-data.ts | 置き換え先 |
| --- | --- |
| `projects` | `GET /api/projects` (`useProjects()`) |
| `fileTree`, `flattenFiles` | `GET …/tree` (`useTree(wt, ignored)`) |
| `DEFAULT_EXCLUDES`, `isExcluded` | `lib/excludes.ts` (初期値) + `GET /api/settings`。isExcluded は全体の設定を引数に取る形にする |
| `parseSpecPaths`, `isSpec` | `lib/spec.ts` (サーバーでも使う) |
| `listHostDir`, `listWorktreeDir` | `GET /api/fs/dirs`、`GET …/dir`。`PathSuggestInput` の `list` は同期関数なので、非同期 (`(dir) => Promise<PathEntry[]>`) に変え、ディレクトリごとに結果をキャッシュする |
| `getContent`, `fileContents` | `GET …/file` |
| `changes` | `GET …/changes` |
| `commits` | `GET …/commits/:hash` |
| `getDiffLines` | `GET …/diff` |
| `searchContent` | `GET …/search/content` |
| `branches` | `GET …/branches` |
| `AUTO_COMPARE_BRANCHES`, `autoCompareBranch`, `defaultCompareBranch` | 定数は `lib/types.ts`。実際に使うブランチはサーバーが `Project.autoCompareBranch` で返す |
| `compareWith`, `aheadBehind` | `GET …/compare` (1 回で両方返す) |

### 2.5 ブラウザ側の取得

- TanStack Query を使う。キーは `[projectId, worktreeId, 種類, 引数]` にし、SSE の通知でその worktree のキーをまとめて無効にする (§5.3)
- 画面部品は `useQuery` の結果を受け取る。読み込み中はモックにない状態なので、各セクションに「読み込み中…」の 1 行を出す (レイアウトは変えない)
- 検索は入力から 200 ms 待ってから投げ、古い要求は `AbortController` で止める
- `ProjectWorkspace` の `diffStatus` (比較対象との差分) は `useCompare()` の `files` から作る。エクスプローラ・COMPARE・「差分を見る」・(i) が同じキャッシュを使うので、git を実行するのは 1 回で済む

### 2.6 画面の状態の保存 (persist.ts)

- `usePersistentState` は最初の描画で値を同期的に読む。これを変えないよう、`app/page.tsx` (サーバー コンポーネント) が DB から `ui_state` を全部読み、`ClientApp` に渡す。persist.ts はそれをメモリに持ち、変更は 500 ms まとめてから `PUT /api/ui-state` で書く。ページを閉じるときは `navigator.sendBeacon` で残りを送る
- キーはモックのまま (`instances`、`activeId`、`settingsOpen`、`theme`、`ws:<instanceId>`、`files-panel-layout`、`git-panel-layout`)。`removePersisted("ws:<id>")` は `deletePrefixes` で消す
- `useStoredString` を使っている SPEC 欄 (`spec-paths:*`) は、UI の状態ではなく worktree のデータなので、`Worktree.specPaths` と `PUT …/spec-paths` に移す
- テーマ: `app/layout.tsx` が DB からテーマを読み、`<html>` に `dark` を付けて返す。`<head>` のスクリプト (`themeInitScript`) と localStorage はいらなくなる。layout と page は要求のたびに DB を読むので、`await connection()` で動的に描画する
- ブラウザのタブを 2 つ開いたときは、後に書いた方が残る (今はそれでよい)

### 2.7 プロジェクトの登録の解除

- モックにない操作なので足す。ホームのカードの「…」メニューの「編集」の下に「登録を解除」を置き、確認のダイアログ (「<name> の登録を解除します。ファイルは消しません」) を出す
- 消すのは sherpa の DB の行だけ (`projects` と、`ON DELETE CASCADE` で `path_mappings`・`worktree_settings`)。リポジトリのファイルには触れない
- ブラウザ: そのプロジェクトのタブを閉じ (`instances` から除き、`removePersisted("ws:<id>")`)、選択中ならホームに移る
- サーバー: そのプロジェクトの監視とキャッシュを止める。SSE で `{ type: "projects" }` を送り、ほかのブラウザのタブにも伝える
- 同じディレクトリをもう一度登録すると、新しいプロジェクトになる (前の設定は戻らない)

## 3. git

### 3.1 実行の共通部品 (`server/exec.ts`)

- `execFile` (シェルを通さない) で実行する。10 秒で止め、出力は 64 MB まで
- すべての git に付けるもの
  - 環境変数: `GIT_OPTIONAL_LOCKS=0`、`GIT_DIR`・`GIT_WORK_TREE` (§3.2。main worktree も含め、常に 2 つとも明示する。`GIT_DIR` だけだと、git は実行したディレクトリを worktree の直下とみなす)、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C` (エラーの文言で分岐するため)、`GIT_PAGER=cat`
  - 引数: `-c core.quotepath=false -c color.ui=false -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false`、出力にパスが入るものは `-z` (日本語やスペースのあるファイル名が実際にある)、diff には `--no-ext-diff --no-textconv`
  - `gc.auto=0` の理由: ホストの git から見ると、コンテナで作った worktree はすべて `prunable` なので、gc (auto gc を含む) が走ると `.git/worktrees/*` が消える。読み取りのコマンドは auto gc を起こさないが、念のため止めておく
- 利用者の入力を引数に入れるときの決まり
  - ブランチ: `GET …/branches` の一覧にある名前だけを受け付け、`refs/heads/…` か `refs/remotes/…` の完全な名前にして渡す (`--output=…` のようなオプションや、同じ名前のファイルと取り違えない)
  - コミット: 4〜64 桁の 16 進数だけを受け付け、`git rev-parse --verify --end-of-options <hash>^{commit}` で確かめる
  - パス: `--` の後に `:(literal)<path>` で渡す (ファイル名の `*` を glob として扱わない)。事前に §6.2 の検証を通す

### 3.2 worktree の検出とパスの読み替え

- main worktree: 登録したディレクトリ。`<dir>/.git` がディレクトリであること
  - `.git` がファイル (登録したのが worktree やサブモジュール) なら、登録を断る (`LINKED_WORKTREE`。「main worktree のディレクトリを登録してください」)
- ほかの worktree: `git worktree list` は使わず (コンテナ内のパスを `prunable` と誤判定する)、`<dir>/.git/worktrees/*/` を読む
  - `gitdir` (worktree の `.git` ファイルのパス。コンテナ内のパス) をマッピングで読み替え、その親をホストの worktree のパスにする
  - マッピングに当たらないパスはそのまま使う (ホストで作った worktree)
  - 読み替えたパスに `.git` の**ファイル**があり、その `gitdir:` の末尾が `worktrees/<id>` であるときだけ有効とする。ディレクトリがあるだけでは有効としない (開発サーバーには `/workspaces/...` の空のディレクトリが実際にある)。有効でなければ `missing: true` (§8)
  - `<id>` と worktree のディレクトリ名は一致するとは限らない (実例: webapp の `.git/worktrees/25_hardening` は `.worktree/25_hardening_phase01`)。`worktreeId` は `<id>`、表示名 (`name`) はディレクトリ名にする
  - `HEAD` を読んでブランチを出す (git を実行しなくても分かる)
- git に渡す値: `GIT_DIR=<dir>/.git/worktrees/<id>`、`GIT_WORK_TREE=<ホストの worktree のパス>` (`commondir` は相対パスなので読み替えはいらない)
- マッピングの自動検出 (登録ダイアログと `GET /api/projects/detect`)
  1. `.devcontainer/devcontainer.json`、`.devcontainer.json`、`.devcontainer/*/devcontainer.json` の `workspaceFolder` (`${localWorkspaceFolderBasename}` は置き換える)
  2. 1 がなければ、worktree の `.git` ファイルの `gitdir: <X>/.git/worktrees/<id>` の `<X>` (実際に記録されているパスなので確実)
  3. どちらもなければ `/workspaces/<ディレクトリ名>`
  - 4 つの実際のリポジトリはどれも `workspaceFolder` を書いていない (既定の `/workspaces/<ディレクトリ名>` になる)。2 と 3 が一致することを確かめられる
  - ホストの側は登録するディレクトリ
- worktree の一覧は `.git/worktrees` を監視して更新する (§5)

### 3.3 ブランチ・HEAD・最新のコミット

| 用途 | コマンド |
| --- | --- |
| worktree のブランチ | `HEAD` ファイルを読む (`ref: refs/heads/<name>` 以外ならブランチにない) |
| 最新のコミット | `git log -1 -z --format=%H%x00%h%x00%s%x00%aI HEAD` |
| ブランチの一覧 | `git for-each-ref --sort=-committerdate --format=%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(symref) refs/heads refs/remotes`。`symref` のあるもの (`origin/HEAD`) は除く |
| 自動の比較対象 | ローカルの `main` → `master` → `develop`。どれもなければ、リモートの同じ名前 (`refs/remotes/*/main` など)。それもなければ null (§8) |

- リモートの名前は決め打ちしない。実際のリポジトリの多くは `origin` ではなく `upstream` で、`refs/remotes/origin/HEAD` もない。リモートが複数あるときは、`<remote>/HEAD` のあるリモート → 名前の順で選ぶ

- 比較対象の既定値: プロジェクトの設定のブランチ → 自動。設定のブランチが消えていたら自動にし、プロジェクトの設定に警告を出す

### 3.4 未コミットの差分 (HEAD...作業ツリー)

- ファイルと状態: `git diff HEAD --raw --numstat -z -M --no-ext-diff` (Staged と Unstaged をまとめる。`--raw` と `--numstat` は同時に出せる)
  - `--raw` から状態 (`M` / `A` / `D` / `R`)、`--numstat` から行数を取る。バイナリは `-\t-` なので `binary: true`、行数は 0
- Untracked: §3.9
- アイコンのバッジと、worktree の `changes` の件数は、この結果 (Untracked を含む) の件数
- コミットがまだないリポジトリ: `HEAD` の代わりに空のツリー (`git hash-object -t tree --stdin < /dev/null`) と比べる

### 3.5 COMPARE (マージベースとの比較)

- マージベース: `git merge-base <ref> HEAD`。なければ `mergeBase: null` にし、「<branch> と共通の祖先がありません」と出す
- 「未コミットの変更を含む」ON: `git diff <mergeBase> --raw --numstat -z -M` (作業ツリーと比べる) + Untracked (§3.9)
- OFF: `git diff <mergeBase> HEAD --raw --numstat -z -M` (`<branch>...HEAD` と同じ)
- 行数は比較対象との実際の差分から数える (モックの `compareWith` と同じ)。上のコマンドの numstat がそれにあたる
- 見出しの表示 (`main...作業ツリー` / `main...HEAD`) はモックのまま

### 3.6 HISTORY とコミットの詳細

- 一覧: `git log -z --format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s --shortstat --max-count=500 <ref>..HEAD`
  - `--shortstat` から `fileCount` を取る。500 件を超えたら「ほかに N 件」を出す (`git rev-list --count <ref>..HEAD`)
  - マージコミットも並べる。変更ファイルは最初の親との差分 (`--diff-merges=first-parent`)
- 詳細: `git show -z --format=%H%x00%h%x00%P%x00%an%x00%aI%x00%B --raw --numstat -M --diff-merges=first-parent <hash>`
- 詳細のアコーディオンの差分: `GET …/diff?base=commit:<hash>` → `git diff <hash>^ <hash>` (§3.8)。最初のコミットは空のツリーと比べる

### 3.7 ahead / behind

- `git rev-list --left-right --count <ref>...HEAD` → 左が behind、右が ahead
- worktree バーの (i): タブの比較対象に対する値 (`CompareResult` に入れる)
- ホームのカード・worktree の選択・`+` メニュー: プロジェクトの既定の比較対象に対する値 (`Worktree.ahead / behind`)。上流ブランチ (`@{u}`) は使わない (sherpa は fetch しないうえ、上流が設定されていない worktree が多い)

### 3.8 1 ファイルの差分 (`DiffLine[]`)

- `git diff <base側> [<後側>] -U<大きな値> --no-ext-diff -M -- :(literal)<oldPath> :(literal)<path>` の unified diff をパースして `DiffLine[]` にする
  - `-U` には両方のファイルの行数より大きな値を渡し、変更のない行もすべて含める (§4.2.1 の「`git diff -U<大きな値>`」の方法を採る)。git と同じ差分になり、ツリーの `+9 -1` と一致する
  - `\ No newline at end of file` は捨てる。`Binary files … differ` は `binary` (画像なら `image`)
- base ごとの比較

  | base | 前側 | 後側 |
  | --- | --- | --- |
  | `uncommitted` | `HEAD` | 作業ツリー |
  | `branch-wt:<b>` (未コミットを含む) | `merge-base(<b>, HEAD)` | 作業ツリー |
  | `branch:<b>` | `merge-base(<b>, HEAD)` | `HEAD` |
  | `commit:<h>` | `<h>^` (最初の親) | `<h>` |

- Untracked のファイルは git diff に出ないので、ファイルを読んですべて追加の行にする
- 大きなファイル (前後どちらかが 1 MB か 2 万行を超える): `-U3` で取り、`too-large` として返す (「N 行を表示」で展開できない)
- `line-diff.ts` (jsdiff) はサーバーでは使わない。ブラウザでも使わなくなれば消す

### 3.9 Untracked の扱い

- 一覧: `git ls-files --others --exclude-standard -z` (`--directory` は付けない。ファイル単位で出す)
- 除外パターン (§4.2) と、worktree の中の別の worktree は除く。これを除かないと、`.worktree/<name>/` の中身がすべて Untracked に出る
- 状態は `U`、行数はファイルの行数 (バイナリは 0)、`deletions` は 0
- 未コミットの差分・COMPARE (未コミットを含む) の両方に出す。COMPARE (含まない) には出さない
- SPEC のファイル (AI の作業ファイル) は `.gitignore` の対象なので Untracked にも出ない (仕様 §3.7 のとおり)

## 4. ファイルの一覧・検索と大きなリポジトリ

### 4.1 エクスプローラの一覧 (`GET …/tree`)

- 「gitignore」OFF: 管理下のファイルと Untracked
  - `git ls-files --cached --others --exclude-standard -z -- . <除外の pathspec>`
- 「gitignore」ON: 上に、無視されたものを足す
  - `git ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z -- . <除外の pathspec>`
  - `--directory` で、無視されたディレクトリは `node_modules/` のように 1 行にまとまる。これを `lazy: true, ignored: true` のディレクトリとして返し、中身は開いたときに `GET …/tree/children` で読む (`fs.readdir`。除外パターンと別の worktree を除き、シンボリックリンクはたどらない。中身はすべて `ignored`)
    - 実測: toolbox の無視されたファイルは 12 万件 (0.49 秒) だが、`--directory` では 39 行 (0.01 秒)
  - `--directory` の出力には、ディレクトリとその中の行が両方出ることがある (`**/.terraform/*` のように中身だけを無視するパターンのとき、`.terraform/` と `.terraform/modules/` が出る)。`lazy` のディレクトリの下にある行は捨てる
  - 別の worktree を含む無視されたディレクトリ (`.worktree/`) は `lazy` にせず、その場で中身を読む。中身がすべて別の worktree なら、空のディレクトリとして消える
  - モックの `filterTree` は子のないディレクトリを消すので、`lazy` のディレクトリは残すように直す
- 削除したが未コミットのファイル (`git ls-files` には出るが作業ツリーにない) は、ツリーに出したまま開いたときに「削除されています」と出す
- サブモジュール (モード `160000`) は中身のないディレクトリとして出し、`submodule: true` にする
- サーバーでパスの一覧を `FileNode[]` の木にして返す。モックの `filterTree` と `Tree` はそのまま使える
- 上限: 10 万件。超えたら `truncated: true` にし、エクスプローラの上に「ファイルが多いため一部だけ表示しています。除外パターンを追加してください」と出す

### 4.2 除外パターンを列挙の時点で効かせる

- 除外パターン (全体 + プロジェクト) を、git の pathspec `:(exclude,glob)<パターン>` にして渡す。glob の pathspec の `**/` `/**` `*` の意味は `lib/glob.ts` と同じ
- ただし pathspec はファイルに当てはめるもので、`--directory` が出すディレクトリの行 (`a/node_modules/`) には効かない (確認済み)。最後に `lib/glob.ts` の `matchesAny` でもう一度絞る。**正は glob.ts** で、pathspec と rg の `-g` は git / rg に余計な列挙をさせないための前処理にとどめる
- worktree の中の別の worktree (`.worktree/<name>` など、同じプロジェクトの worktree のうち、今の worktree の中にあるもの) も除外パターンに足す
- chokidar の `ignored` にも同じ判定を使う (§5.1)

### 4.3 SPEC (`GET …/spec`)

- SPEC 欄のパターン (`parseSpecPaths`) ごとに、ワイルドカードより前のディレクトリ (`agent-tasks/feature/33_new_region/*` なら `agent-tasks/feature/33_new_region/`) から `fs` でたどる
  - `.gitignore` に関係なく読む (SPEC の資料は無視されていることが多い)。除外パターンと別の worktree は除く。シンボリックリンクはたどらない
  - `.md` で `isSpec` に当たるものを返す。5,000 件で打ち切る
- worktree バーの件数も同じ結果から出す (モックの `specCount`)

### 4.4 パスのサジェスト

- `GET /api/fs/dirs`: ホーム (`os.homedir()`) の下だけ。`~` を展開し、`realpath` がホームの下にあることを確かめる。ディレクトリの名前だけを返し、ファイルの名前や中身は返さない
  - 印: `.git/HEAD` か `.git` のファイル (`gitdir:`) があれば `git` (`.git` の空のディレクトリには付けない §A)、登録済みのディレクトリなら `登録済み`
  - 200 件で打ち切る
- `GET …/dir`: worktree の中だけ。`fs.readdir` で読み、除外パターンと別の worktree を除き、`git check-ignore --stdin -z` で無視されたものに `gitignore` の印を付ける

### 4.5 内容の検索 (`GET …/search/content`)

- `rg --json --line-number --no-config` を worktree の直下で実行する
  - 条件: 大文字小文字の区別 ON は `-s`、OFF は `-i`。単語単位は `-w` (rg の `\w` は Unicode なので、日本語の文字も単語の一部になる。モックと同じ。確認済み)。正規表現 OFF は `-F`
  - 「gitignore」OFF は既定 (`.gitignore` を守る)、ON は `--no-ignore --hidden`
  - 除外パターンと別の worktree は `-g !<パターン>`、検索の「対象」「対象外」(`parseSearchGlobs`) は `-g <パターン>` / `-g !<パターン>` で渡し、結果を `matchesAny` でもう一度絞る
  - 上限: `--max-count 100` (1 ファイル)、`--max-filesize 2M`、`--max-columns 1000 --max-columns-preview`、全体で 2,000 件 (超えたら止めて `truncated`)
- `submatches` の `start` / `end` は UTF-8 のバイト位置なので、行の文字列の UTF-16 の位置に変換して `Match` にする
- 正規表現の方言: ブラウザで先に `buildMatcher` を通す (JS の正規表現)。rg には `--engine auto` を付け、Rust の正規表現で扱えないもの (後読み・後方参照) は PCRE2 に任せる (確認済み)。それでも rg が受け付けないものは、rg のエラーを `INVALID_REGEX` にして「正規表現が正しくありません」と出す
- 検索のあいだにファイルが書き換わっても、結果はそのとき読んだ内容のまま (自動更新で検索し直す §5.3)

### 4.6 ファイル名の検索

- 「gitignore」OFF: エクスプローラの一覧 (§4.1) はすでにブラウザにあるので、モックと同じくブラウザで `buildMatcher` を使って絞る (入力のたびにサーバーに問い合わせない)
- 「gitignore」ON: 無視されたディレクトリの中身はブラウザにないので、`GET …/search/files` でサーバーに問い合わせる。`rg --files --no-ignore --hidden` + 除外パターンの一覧に `buildMatcher` (ファイル名に当てる) を使い、結果のパスをツリーに差し込む
- 仕様 §4.2 の「あいまい一致」はやめ、モックと同じ条件 (`Aa` / `ab` / `.*`) にする

### 4.7 キャッシュ

- サーバーで worktree ごとに、一覧・status・ブランチの結果を持つ。監視中の worktree は、変更の通知 (§5) が来るまで使い回す。監視していない worktree (ホームのカードだけ) は 5 秒で捨てる
- `GET /api/projects` は worktree ごとの git をまとめて実行する (同時 8 個まで)。重ければ、worktree の状態を別の API に分けて、カードを少しずつ埋める

## 5. 自動更新

### 5.1 監視 (chokidar)

- 監視するのは、ブラウザで開いているタブの worktree だけ。SSE の接続 (`GET /api/events?watch=…`) が購読をやめて 30 秒たったら止める
- 作業ツリー: worktree の直下を監視する。`followSymlinks: false`。`ignored` に渡す関数で、次を監視から外す
  - 除外パターン、別の worktree、`.git`
  - `.gitignore` で無視されたディレクトリ (§4.1 の `--directory` の結果)。ただし次の場所は監視する: SPEC の場所 (AI の作業ファイルは無視されていることが多い)、開いているタブのファイルがある場所、「gitignore」ON で開いた `lazy` のディレクトリ
  - 無視されたディレクトリを外す理由: toolbox の `tmp/` (3.6 万ファイル) や `.pnpm-store`、webapp の `.worktree/` (2.5 万ファイル) を監視すると、inotify の数と起動の時間が無駄になる
  - `.gitignore` が変わったら、無視されたディレクトリを取り直して監視を組み直す
- git: `<GIT_DIR>/HEAD`・`<GIT_DIR>/index`・共通の `.git/refs/`・`.git/packed-refs`・`.git/worktrees/`
- 変更は 300 ms まとめてから、worktree ごとに `WatchEvent` にする。`.gitignore` の変更は `structure: true` にする
- inotify の上限 (`fs.inotify.max_user_watches`) に当たったら、その worktree の監視をやめ、再読み込みボタンの点を灰色にする (「自動更新できません。手動で再読み込みしてください」)

### 5.2 SSE

- ブラウザは 1 つの `EventSource` だけを張る (HTTP/1.1 では同じサーバーへの接続が 6 本までなので、worktree ごとに張らない)。開いているタブの worktree が変わったら張り直す
- 25 秒ごとにコメント行 (`: ping`) を送る。切断は `request.signal` と `ReadableStream` の `cancel` で知り、購読をやめる
- 再読み込みボタンの緑の点は、SSE がつながっていて、その worktree を監視しているときだけ出す

### 5.3 ブラウザで何を読み直すか

| 通知 | 無効にするキャッシュ |
| --- | --- |
| `files` | 変わったパスのファイルの内容・差分、changes、compare、SPEC、表示中の検索。`structure` なら tree も |
| `git` | changes、compare、branches、表示中の差分とコミット、projects |
| `worktrees` | projects |
| `projects` | projects、settings。消えたプロジェクトのタブを閉じる |

- 通知 (右下): 開いているタブの内容を読み直したときだけ、「`spec.md` が更新されたため再読み込みしました」と出す。ツリーや件数だけが変わったときは出さない
- 手動の再読み込み: その worktree のキャッシュをすべて無効にし、`?fresh=1` で取り直す

## 6. セキュリティ

### 6.1 Host と Origin の確認 (`proxy.ts`)

- すべての要求 (ページ・`/_next`・API) で `Host` を確かめる。ホスト名が `127.0.0.1`・`localhost`・`[::1]` 以外なら 421 を返す (DNS rebinding の対策)
  - ポートは見ない。SSH のポートフォワードで手元の別のポート (`LocalForward 4800 127.0.0.1:4747`) から開くと、`Host` は `localhost:4800` になるため
- 書き込みの要求 (GET / HEAD 以外): `Origin` があれば、そのホスト名も上と同じであること。`Sec-Fetch-Site: cross-site` なら断る。さらに `Content-Type: application/json` に限る (ほかのサイトのページからの単純なリクエストで書き換えられないように)
- 読み取りの API でも `Sec-Fetch-Site: cross-site` は断る (ほかのサイトの `<img>` などから読ませない)
- CORS のヘッダーは返さない

### 6.2 パスの検証 (`server/paths.ts`)

- 受け取った相対パスは、空・絶対パス・`\0`・`..` の区切りを含むものを断る (`INVALID_PATH`)
- `path.resolve(root, rel)` が root の下にあることを確かめたうえで、`fs.realpath` の結果も `realpath(root)` の下にあることを確かめる (シンボリックリンクで外に出ない)
- シンボリックリンクそのものは、リンク先を `readlink` で読んで表示する (`FileContent.kind = "symlink"`)。リンク先が worktree の外なら中身は読まない
- 読める場所は、登録したプロジェクトのディレクトリと、その worktree のパス (§3.2 で読み替えたもの) だけ。API は projectId / worktreeId から root を決め、利用者から root を受け取らない
- 例外: `GET /api/fs/dirs` と `GET /api/projects/detect` はホームの下を読むが、ディレクトリの名前・`.git` の有無・`devcontainer.json` の `workspaceFolder` だけを返す

### 6.3 そのほか

- `raw` の応答には `X-Content-Type-Options: nosniff` と `Content-Security-Policy: sandbox` を付ける。拡張子から決めた画像の型以外は `application/octet-stream` にする (worktree の中の HTML や SVG が sherpa の画面として動かないように)
- git の設定 (`.git/config` のフックやフィルタ) は利用者のものなので信頼する。ただし `--no-ext-diff --no-textconv` と `core.fsmonitor=false` で、差分や status のたびに外部のコマンドを動かさない
- 待ち受けは `127.0.0.1` だけ (`package.json` の `-H` のまま)

## 7. SQLite

- 置き場所: `~/.local/share/sherpa/sherpa.db` (環境変数 `SHERPA_DB` で変えられる。テストは一時ファイルを使う)。`journal_mode=WAL`、`foreign_keys=ON`
- マイグレーション: `drizzle-kit generate` で SQL を作ってコミットし、起動時 (`instrumentation.ts`) に `migrate()` を流す

```ts
// server/db/schema.ts (Drizzle)
projects        // 登録したプロジェクト
  id                     text PK        // slug
  path                   text UNIQUE    // 絶対パス。末尾の / なし
  name                   text
  color                  text           // "bg-sky-500" など。登録の順に割り当てる
  excludes               text JSON      // string[]。全体の設定に追加するパターン
  default_compare_branch text NULL      // null は自動
  sort_order             integer        // 登録した順 (並べ替えは作らない)
  created_at, updated_at integer

path_mappings   // devcontainer のパスマッピング
  id          integer PK
  project_id  text FK → projects.id (ON DELETE CASCADE)
  container   text
  host        text

worktree_settings  // worktree ごとの保存値
  project_id   text FK → projects.id (ON DELETE CASCADE)
  worktree_id  text                    // "main" か .git/worktrees/<id>
  spec_paths   text                    // SPEC 欄の入力
  PRIMARY KEY (project_id, worktree_id)

settings        // 全体の設定
  key    text PK                       // "excludes"
  value  text JSON                     // 行がなければ DEFAULT_EXCLUDES

ui_state        // 画面の状態 (persist.ts のキー)
  key         text PK                  // "instances" / "ws:<id>" / "theme" / "files-panel-layout" …
  value       text JSON
  updated_at  integer
```

- worktree 自体は保存しない (毎回 `.git/worktrees` から作る)。消えた worktree の `worktree_settings` は残しておく (同じ名前で作り直したときに戻る)

## 8. エラーのとき

| 状況 | 検出 | コード | 画面 |
| --- | --- | --- | --- |
| git が入っていない | 起動時と `/api/health` で `git --version` | `GIT_NOT_FOUND` | 全画面の上に帯「git が見つかりません」。git を使う所は空にする |
| rg が入っていない | §1.2 の順に探して `rg --version` | `RG_NOT_FOUND` | 内容の検索欄の下に「ripgrep (rg) が見つかりません」。ファイル名の検索 (gitignore OFF) は使える。開発サーバーには実際に入っていない |
| 登録: ディレクトリがない / git リポジトリでない | `detect` で `.git` を確かめる | `NOT_FOUND` / `NOT_GIT_REPO` | ダイアログの「ディレクトリ」の下に出し、「登録」を押せなくする |
| 登録: worktree のディレクトリを指定した | `.git` がファイル | `LINKED_WORKTREE` | 同上。「main worktree のディレクトリを登録してください」 |
| 登録: 登録済み | `path` が重なる | `ALREADY_REGISTERED` | 同上 |
| 登録した後にディレクトリが消えた | `/api/projects` で確かめる | `NOT_FOUND` | カードに「ディレクトリが見つかりません」。タブの中身に同じ文言 |
| worktree が消えた | 読み替えたパスがない | `WORKTREE_MISSING` | カード・選択肢では薄く「見つかりません」と出して選べなくする。開いていたタブは中身に「worktree が見つかりません」と、main worktree に切り替えるボタンを出す |
| HEAD がブランチにない | `HEAD` がハッシュ | (エラーにしない) | ブランチ名の代わりに `(detached) 2ff64ad`。COMPARE・HISTORY は `HEAD` のまま動く |
| コミットがない | `HEAD` が解決できない | (エラーにしない) | 未コミットの差分は空のツリーと比べる。HISTORY は空 |
| 比較対象のブランチがない (main も master も develop もない) | §3.3 | `NO_COMPARE_BRANCH` | 比較の選択に「比較対象を選んでください」。COMPARE・HISTORY・エクスプローラの記号は空 |
| 保存していた比較対象のブランチが消えた | 一覧にない | `BRANCH_NOT_FOUND` | 選択欄を赤くし、COMPARE に「<branch> が見つかりません」 |
| 共通の祖先がない | `merge-base` が 1 で終わる | (エラーにしない) | COMPARE に「<branch> と共通の祖先がありません」 |
| ファイルが消えた・読めない | `ENOENT` / `EACCES` | `NOT_FOUND` / `FORBIDDEN` | タブの中身に文言。自動更新で戻ったら表示し直す |
| パスが不正・外を指す | §6.2 | `INVALID_PATH` / `OUTSIDE` | 400 / 403 |
| git が時間内に終わらない・失敗した | 終了コード / タイムアウト | `GIT_FAILED` | そのセクションに git のエラー (1 行目) を出す |
| 正規表現が正しくない | ブラウザと rg | `INVALID_REGEX` | 検索欄の下 (モックと同じ) |

## 9. 画像・バイナリ・大きなファイル

| 種類 | 判定 | ファイルのタブ | 差分 |
| --- | --- | --- | --- |
| 画像 | 拡張子 (`png` `jpg` `jpeg` `gif` `webp` `svg` `ico` `bmp` `avif`) | `<img src=raw>` を中央に出す。大きさとサイズを添える | 前後の画像を左右に並べる (`raw?rev=`) |
| バイナリ | 先頭 8 KB に `\0` がある (git と同じ判定) | 「バイナリのため表示しません (123 KB)」 | 「バイナリのファイルが変更されています」 |
| 大きなテキスト | 1 MB 超 | 1〜5 MB はハイライトせずに行番号だけで表示 (`highlight: false`)。5 MB 超は `too-large`「大きすぎるため表示しません」 | §3.8 の `too-large` |
| ハイライトが重いもの | 20 万文字超 か 5,000 行超 | ハイライトしない | 同じ |
| 文字コード | UTF-8 として読む (`TextDecoder`、不正なバイトは置き換え) | 置き換えが起きたら「UTF-8 ではありません」と出す | |
| シンボリックリンク | `lstat` | リンク先のパスを出す (§6.2) | git のとおり (リンク先の文字列の差分) |

- Markdown の画像: `MarkdownViewer` の `resolveImage` を、Markdown のあるディレクトリを基準に `resolveRelative` し、`/api/…/raw?path=` にする。`http(s):` はそのまま。worktree の外を指すものは出さない
- シンタックスハイライトは今のまま (ブラウザで shiki)。サーバーで HTML にするのは、遅ければ後で考える

## 10. テスト

### 10.1 単体テスト (vitest)

`web/test/unit/`。純粋な関数と、git / rg の出力のパーサーを対象にする。

- `glob.ts` (`globToRegExp`・`matchesAny`・`parseSearchGlobs`)、`spec.ts` (`parseSpecPaths`・`isSpec`)、`search.ts` (`buildMatcher`)
- 除外パターン → git の pathspec / rg の `-g` の変換
- パーサー: `diff --raw --numstat -z` (名前の変更・バイナリ・日本語やスペースのあるパス)、`ls-files -z`、`for-each-ref`、`log -z --shortstat`、`rev-list --count`、unified diff → `DiffLine[]` (`\ No newline`、空のファイル、全行追加・全行削除)
- rg の `--json` → `SearchHit` (バイト位置 → UTF-16 の位置。日本語・絵文字)
- パスの読み替え (`gitdir` → ホストのパス)、`devcontainer.json` (コメント・`${localWorkspaceFolderBasename}`)
- パスの検証 (`..`・絶対パス・`\0`)、Host / Origin の判定
- パスの一覧 → `FileNode[]` の木、相対時間の表示

### 10.2 結合テスト (一時ディレクトリの git リポジトリ)

`web/test/integration/`。`test/fixtures/make-repo.ts` が `os.tmpdir()` の下に次のリポジトリを作る (テストのたびに作り直す)。

- `main` と `develop`、`feature/x` (main から 3 コミット先行・1 コミット遅れ)、マージコミット
- 未コミットの変更: Staged / Unstaged / 名前の変更 / 削除 / Untracked / バイナリ / 画像 / 日本語とスペースのファイル名
- `.gitignore` の対象: `node_modules/` (大量のファイル)、`tmp/`、`agent-tasks/` (SPEC の資料)
- worktree: `git worktree add .worktree/wt1 feature/x` のあと、`.worktree/wt1/.git` と `.git/worktrees/wt1/gitdir` を偽のコンテナ内のパスに書き換え、`.devcontainer/devcontainer.json` (コメント付き) を置く (コンテナで作った状態を再現する)。ホストの git が `not a git repository` で失敗することも確かめる
  - 偽のコンテナ内のパスは `/workspaces` ではなく一時ディレクトリの下にする (`/workspaces` は root のもの)。そのパスに空のディレクトリを作っておき、実際の開発サーバーと同じく「ディレクトリはあるが worktree ではない」状態にする
  - `.git/worktrees/<id>` の `<id>` とディレクトリ名が違う worktree (管理用のディレクトリの名前を変えて `.git` ファイルを直す)
  - `.worktree/` は main worktree の `.gitignore` の対象にする (実際のリポジトリと同じ)
- ブランチにない HEAD の worktree、ディレクトリを消した worktree
- リモート: `origin` ではない名前 (`upstream`) で、`<remote>/HEAD` のないもの (bare の一時リポジトリから clone して作る。fetch は fixture の中だけで行う)
- 中身だけを無視するパターン (`**/.terraform/*`)、無視されたディレクトリの中の別の git リポジトリ (`tmp/other/.git`)
- worktree の外を指すシンボリックリンク、中を指すシンボリックリンク
- `master` だけのリポジトリ、どのブランチもない (`trunk` だけ) リポジトリ、共通の祖先のないブランチ、コミットのないリポジトリ

確かめること:

- `server/` の関数: worktree の検出と読み替え、一覧 (gitignore ON / OFF、`--directory`、除外パターン、別の worktree が出ない)、changes / compare / history の結果が `git diff --numstat` と一致すること、差分の行、検索の条件、エラーのコード
- Route Handler: `GET` などを直接呼び (`new Request("http://127.0.0.1:4747/…")`)、状態コードと JSON を確かめる。`SHERPA_DB` に一時ファイルを渡す
- proxy: `Host: evil.example` が 421、`Origin` の違う POST が 403
- 監視: ファイルを書き換えると 1 秒以内に `WatchEvent` が届く。`node_modules` の中の変更は届かない
- テストの後に、fixture の `.git` が書き換わっていないこと (`index` の mtime) を確かめる

### 10.3 実際のリポジトリの確認 (`scripts/check-real-repos.ts`)

- `npx tsx scripts/check-real-repos.mts <repo> …` で、引数に渡した実際のリポジトリを DB に登録せずにメモリ上のプロジェクトとして読み、次を出す
  - worktree の一覧と読み替えたパス、ブランチ、ahead / behind、changes、自動の比較対象
  - 一覧の件数 (gitignore ON / OFF)・SPEC の件数・検索 1 回と、それぞれの時間
  - changes / compare の件数と行数が `git diff --numstat` を直接実行した結果と一致するか
- 実行の前後で、各リポジトリの `.git` の `index`・`HEAD`・`refs` と `.git/worktrees/*` の mtime と一覧を比べ、何も書き換えていないことを確かめる (書き換わっていたら失敗にする)
- git は必ず `GIT_OPTIONAL_LOCKS=0` 付きの共通の部品 (§3.1) から実行する

### 10.4 画面

- フェーズごとに、puppeteer-core と `/usr/bin/google-chrome` で、モック (`cd mock && PORT=4748 npm run dev`) と本実装 (4747) の同じ操作のスクリーンショットを撮って見比べる
- `npm run lint`・`npx tsc --noEmit`・`npm run build`・`npx vitest run` を通す

## 11. フェーズ

各フェーズの終わりに lint・型チェック・vitest を通し、コミットする。

| # | 内容 | 完了の条件 |
| --- | --- | --- |
| 1 | 基盤: パッケージ、`server/exec.ts`・`paths.ts`・`errors.ts`、`proxy.ts`、DB とマイグレーション、`/api/health`、vitest、fixture の作成 | 単体テスト (glob・パス・Host) と fixture の作成が通る。`curl -H 'Host: evil.example' 127.0.0.1:4747` が 421。`/api/health` が git と rg (`@vscode/ripgrep`) の版を返す |
| 2 | プロジェクトと保存: 登録・編集・登録の解除・detect、worktree の検出と読み替え、`/api/fs/dirs`、全体の設定、ui_state (persist.ts と theme)、`lib/types.ts` への移動。ホーム・一番上のタブ・worktree の選択・(i)・ダイアログ・設定タブを API にする | 4 つの実際のリポジトリを画面から登録でき、worktree・ブランチ・コンテナ内のパスが正しく出る。再起動 (dev サーバーの再起動とページの再読み込み) の後に、タブ・レイアウト・テーマ・設定が戻る。テーマで一瞬ライトにならない |
| 3 | ファイル: tree (gitignore ON / OFF、lazy)、除外パターン、別の worktree を出さない、file / raw、画像・バイナリ・大きなファイル、Markdown の画像とリンク、SPEC と SPEC 欄の保存、worktree の中のサジェスト | toolbox の `tmp/backup`・webapp の `archives` が出ない。`.worktree/` が出ない。webapp の worktree の SPEC に agent-tasks の資料が出る。確認スクリプトで一覧の時間が 1 秒以内 |
| 4 | git: changes、branches、compare (マージベース)、history、コミットの詳細、1 ファイルの差分、エクスプローラの記号と「変更のみ」、「差分を見る」、バッジ、ahead / behind | 確認スクリプトで、件数と行数が `git diff --numstat` と一致する。fixture のエラーの場合 (detached・main なし・祖先なし・worktree 消失) が §8 のとおり出る |
| 5 | 検索: 内容 (rg)、ファイル名 (gitignore ON のサーバー検索)、条件・対象・対象外、エラー | 結合テストで Aa / ab / .* と対象 / 対象外の組み合わせが通る。実際のリポジトリで 1 回の検索が 1 秒以内 |
| 6 | 自動更新: chokidar、SSE、キャッシュの無効化、通知、緑の点、手動の再読み込み、worktree の追加・削除 | AI の代わりに fixture のファイルを書き換えると、開いているタブ・差分・ツリー・件数が 1 秒ほどで変わり、通知が出る。dev サーバーを止めると点が灰色になり、起動し直すとつながる |
| 7 | 仕上げ: `mock-data.ts`・`public/mock/`・`line-diff.ts` (使っていなければ) を消す。仕様書 §6 を消し、README に DB の場所と rg が必要なことを書く | `grep -r mock-data web/src` が空。すべての画面をモックと見比べて、動きの差がない (または仕様書に書いた差だけ) |

## 12. 決めたこと

この計画で決めたこと (仕様書に反映した):

- ホームのカード・worktree の選択の ↑↓ は、プロジェクトの既定の比較対象に対する値 (§3.7)
- 自動の比較対象は、ローカルになければリモート (`upstream/main` など。名前は決め打ちしない) も探す (§3.3)
- ファイル名の検索はあいまい一致にせず、モックと同じ条件にする (§4.6)
- 差分は `git diff -U<大きな値>` をパースして作る (§3.8)
- 通知は開いているタブを読み直したときだけ出す (§5.3)
- rg は `@vscode/ripgrep` を依存に足す (§1.2)
- プロジェクトの登録の解除を足す (§2.7)
- プロジェクトは登録した順に並べる (並べ替えは作らない)

## A. 実際のリポジトリの調査結果 (2026-09-27、読み取りだけで調べた)

| | cluster | webapp | toolbox | infra |
| --- | --- | --- | --- | --- |
| main worktree のブランチ | `feature/262_add_monitoring` | `feature/33_new_region_review` | `feature/281_improve_ci` | `main` |
| worktree (`.worktree/` の下だけ) | なし | 4 (うち 1 つは `<id>` と名前が違う) | なし (`.worktree/` は空) | 1 |
| `workspaceFolder` | なし | なし | なし | なし |
| リモート | `upstream` | `upstream` (`upstream/main` と `upstream/master`) | `origin` | `upstream` |
| ローカルの main / master / develop | main | main | main | main |
| 管理下 / Untracked / 無視 (ファイル) / 無視 (`--directory`) | 583 / 0 / 13,362 / 36 | 697 / 0 / 40,707 / 44 | 553 / 0 / 122,070 / 39 | 174 / 0 / 206 / 8 |
| 大きな無視されたディレクトリ | `.terraform` (各 600〜760 MB)、`tmp/` (中に別の git リポジトリ) | `.worktree/` (1.5 GB)、`node_modules`、`.terraform` | `node_modules` (1 GB)、`tmp/` (886 MB。別のリポジトリの clone を含む)、`.pnpm-store` | `.worktree/`、`.terraform` |
| SPEC の資料の場所 (すべて `.gitignore` の対象) | `.ai/agent-tasks/…`、`agent-tasks/…` | `.worktree/*/agent-tasks/<branch から feature/ を除いた名前>/…` | `.ai/agent-tasks/…`、`docs/superpowers/…`、`tmp/agent-tasks/` | `.ai/agent-tasks/…`、`docs/superpowers/…` |

- git 2.43.0、Node v24.21.0。**rg は入っていない** (VS Code Server の中に同梱のものがあるだけ)
- `git status` と `git diff HEAD --numstat` は、main worktree でも `GIT_DIR` / `GIT_WORK_TREE` を付けた worktree でも 10〜20 ms。コンテナで書いた index の stat 情報はホストでもそのまま使える (再計算が起きない)
- `git worktree list` は、コンテナで作った worktree をすべて `prunable` と表示する (§3.1 の `gc.auto=0` の理由)
- 管理下のシンボリックリンク・サブモジュール・LFS はない。作業ツリーのシンボリックリンクは `.terraform/providers` の中 (外の `/tmp` を指していて切れている) と `node_modules/.bin` だけ
- 1 MB を超える管理下のファイル: cluster の png (2.2 MB) と yaml (1.3〜1.4 MB) だけ。バイナリ: webapp の xlsm / xlsx (130 件)、png など
- 日本語のファイル名: webapp に 131 件 (スペースを含むものもある)。`-z` を付けないと git はエスケープして出す
- inotify: `max_user_watches` 253,714。無視されたディレクトリを除けば、ディレクトリの数は各リポジトリで数百
- cluster の `.devcontainer/conf/common/.git/` は空のディレクトリ。ディレクトリのサジェストの「git」の印は、`.git` があるだけでなく `.git/HEAD` があるときに付ける

## 13. 実装の結果 (2026-09-27)

フェーズ 1〜7 を実装した。確かめたこと:

- `npm run lint`・`npx tsc --noEmit`・`npm run build` が通る。build の警告は `globals.css` の `::highlight(...)` (Ctrl+F の強調。Turbopack の CSS パーサーが知らない擬似要素) だけで、モックのときからある
- `npm test` (vitest): 単体テスト 35 件、結合テスト 50 件 (一時ディレクトリの fixture。偽のコンテナ内パスの worktree・管理用の名前が違う worktree・detached・消えた worktree・`upstream` リモート・master だけ / trunk だけ / コミットなしのリポジトリを含む)
- `npx tsx scripts/check-real-repos.mts`: 4 つの実際のリポジトリで 66 項目がすべて OK (worktree の一覧と読み替え、ファイルツリー、ファイルの内容、検索、未コミットの差分、COMPARE、HISTORY、ブランチの一覧、読み取り専用)。git を直接実行した結果 (`git diff --numstat`、`rev-list` など) と比べる
- ブラウザ (playwright-cli + Chrome): プロジェクトの登録 (パスのサジェストと自動検出)、worktree の切り替え、比較対象の切り替え (`upstream/main`)、SPEC、内容の検索、差分 (Unified / Split、ファイル表示の「差分を見る」、エクスプローラの記号と「変更のみ」)、コミットの詳細、画面分割、Ctrl+F、設定、ダーク、再読み込み後の復元、自動更新 (一時リポジトリのファイルを書き換えて通知と表示の更新) を、実際のデータで確かめた。モック (4748) と画面を見比べ、レイアウトと操作が同じであることを確かめた

## 14. 未決事項 (実装で判断したこと・仕様どおりにできていないこと)

- **サーバーのキャッシュ (§4.7) は作っていない**。git の実行が 10〜20 ms、一覧も 1 秒以内 (実測) で、ブラウザの TanStack Query のキャッシュと SSE の無効化で足りたため。遅いリポジトリが出てきたら足す
- **監視 (§5.1) で、無視されたディレクトリの中の「開いているタブのファイル」は監視していない**。SPEC の場所は監視する。gitignore の対象のファイルを SPEC の外で開いているときは、手動の再読み込みが要る
- **`git diff` に `-c diff.autoRefreshIndex=false` を足した (§3.1)**。`GIT_OPTIONAL_LOCKS=0` でも、stat だけが変わったファイルがあると `git diff` は index を書き直すため。結合テストで再現を確かめている。実際のリポジトリの index の mtime は、作業の前後で変わっていないことを確かめた
- **Staged の削除 (`git rm`) はエクスプローラに出ない** (`ls-files --cached` に出ないため)。§4.1 の「削除したが未コミットのファイルを出す」は、Unstaged の削除だけになる。Git メニューには出る
- **サブモジュール (§4.1) は特別に扱っていない**。実際のリポジトリにないため。git の出力のとおり、中身のないディレクトリになる
- `instrumentation.ts` は使わず、DB は最初に使ったときにマイグレーションを流す。`server-only` も使っていない (サーバーの部品は Route Handler と page / layout からしか読まない)
- `@vscode/ripgrep` は import せず、`node_modules/@vscode/ripgrep-<platform>-<arch>/bin/rg` のパスを組み立てて使う。import すると Turbopack が rg の実行ファイルまでバンドルしようとして失敗するため
- ページを閉じるときの保存は `navigator.sendBeacon` ではなく `fetch(..., { keepalive: true })` にした (Content-Type を application/json にするため)
- プロジェクトとして登録できるのは、ホームの下のディレクトリだけ (サジェストと同じ範囲)
- エクスプローラの絞り込み (「変更のみ」など) と開閉の状態は保存しない (モックと同じ)
- **`mock/` が起動しない**: `mock/` で `npm run dev` すると、globals.css の生成で壊れたクラス名 (`gap-[-…]`) が出て 500 になる。`mock/` の中の何か (`.next` のキャッシュなど) を Tailwind が読んでいると思われる。`mock/` は編集しない決まりなので、見比べには別の場所に取り出したモックを使った
