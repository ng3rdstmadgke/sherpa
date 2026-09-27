# 保存 (SQLite)

[overview.md](overview.md) から分けた、保存の仕組み。実装は `web/src/server/db/` (接続とテーブル)、`web/drizzle/` (マイグレーション)。

## 1. 保存するもの

- 登録したプロジェクト、パスマッピング、プロジェクトごとの除外パターンと既定の比較対象
- 全体の設定 (除外パターン)
- worktree ごとの SPEC 欄の入力
- 画面の状態 (JSON)。キーと保存のしかたは [ui.md](ui.md) §8。テーマもここに入る

worktree 自体は保存しない (要求のたびに `.git/worktrees` から作る)。

## 2. DB

- ライブラリ: better-sqlite3 + Drizzle ORM
- 置き場所: `~/.local/share/sherpa/sherpa.db`。環境変数 `SHERPA_DB` で変えられる (テストは一時ファイルを使う)。ディレクトリがなければ作る
- `journal_mode=WAL`、`foreign_keys=ON`
- 接続は、開発中の再読み込み (HMR) で二重に開かないよう `globalThis` に置く

## 3. テーブル (`web/src/server/db/schema.ts`)

```
projects            登録したプロジェクト
  id                     text PK        ディレクトリ名から作る slug
  path                   text UNIQUE    絶対パス。末尾の / なし
  name                   text
  color                  text           "bg-sky-500" など。登録の順に割り当てる
  excludes               text JSON      string[]。全体の設定に追加するパターン
  default_compare_branch text NULL      null は自動
  sort_order             integer        登録した順 (並べ替えはしない)
  created_at, updated_at integer

path_mappings       devcontainer のパスマッピング
  id          integer PK
  project_id  text FK → projects.id (ON DELETE CASCADE)
  container   text
  host        text

worktree_settings   worktree ごとの保存値
  project_id   text FK → projects.id (ON DELETE CASCADE)
  worktree_id  text                    "main" か .git/worktrees/<id>
  spec_paths   text                    SPEC 欄の入力
  PRIMARY KEY (project_id, worktree_id)

settings            全体の設定
  key    text PK                       "excludes"
  value  text JSON                     行がなければ初期値 (DEFAULT_EXCLUDES)

ui_state            画面の状態 (persist.ts のキー)
  key         text PK                  "instances" / "ws:<id>" / "theme" / "files-panel-layout" …
  value       text JSON
  updated_at  integer
```

- 登録を解除すると、`projects` の行を消し、`path_mappings` と `worktree_settings` は CASCADE で消える
- 消えた worktree の `worktree_settings` は残す (同じ名前で作り直したときに戻る)

## 4. マイグレーション

- `web/drizzle/` の SQL を、サーバーが最初に DB を使うときに drizzle の `migrate()` で当てる (明示的な実行はいらない)。当てたものは DB の中に記録されるので、2 回目以降は何もしない
- SQL の場所は実行したディレクトリ (`process.cwd()`) からの `drizzle/`。`bin/sherpa run` も `web/` に移ってから起動するので、そのまま見つかる。`web/` の外から `next` を直接呼ぶと見つからない
- テーブルの定義を変えたら、`npx drizzle-kit generate` で SQL を作り、`web/drizzle/` もコミットする
