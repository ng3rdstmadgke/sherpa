# sherpa アーキテクチャ

sherpa の仕様と仕組みの正本。このファイルを起点に、機能ごとの詳細を `docs/architecture/*.md` に分けて書く。
機能を変えたら、対応するファイルを同じコミットで直す。

初回の実装のときの資料 (仕様のドラフト・実装計画・経緯) は `docs/agent-tasks/init/` にある。そちらは更新しない。

## 1. 目的と範囲

複数のプロジェクト (git リポジトリ / worktree) のソースコード・Markdown・git の差分を、1 つのブラウザ画面で横断して閲覧するローカル Web アプリ。

| 課題 | sherpa での解決 |
| --- | --- |
| プロジェクトごとに VS Code を開くのが手間 | 登録したプロジェクトをブラウザのタブで切り替える |
| devcontainer へのアタッチが遅い | ホスト側のファイルを直接読むため、コンテナは不要 |
| worktree の階層が深い | worktree ごとにタブを開く。1 階層しかないディレクトリはまとめて 1 行で表示する |
| worktree で並列に作業している | 同じプロジェクトを、worktree 別に複数のタブで開ける |
| AI が書いた spec を探すのが手間 | ファイルメニューの SPEC セクション (置き場所を worktree ごとに指定)、検索、自動更新 |

- **閲覧専用**。編集、git の書き込み (add / commit / fetch / checkout など)、tmux との連携は範囲外
- 開発サーバー (Linux) で起動し、`127.0.0.1:4747` でだけ待ち受ける。手元の PC からは SSH のポートフォワードで開く。認証は設けない

## 2. 主な決定事項

| 項目 | 決定 |
| --- | --- |
| 待ち受け | `127.0.0.1:4747` のみ (`sherpa run -p <PORT>` か環境変数 `PORT` で変えられる)。3000 番は他のツールでよく使うため避ける |
| 検索の範囲 | そのタブの worktree だけ。結果は別の一覧にせず、エクスプローラを絞り込んで表示する |
| 差分の比較対象 | 「未コミットの差分」と「COMPARE (任意のブランチとの比較)」に分ける。比較対象はタブ (worktree) ごとに選び、タブ全体で共通にする |
| COMPARE の既定のブランチ | プロジェクトの設定 → ローカルの `main` → `master` → `develop` → リモートの同じ名前 |
| ファイルの自動再読み込み | する (chokidar で監視し、SSE で通知する) |
| worktree の切り替え | タブの中で切り替える。並べて見たいときは新しいタブで開く。同じ worktree をもう一度開いたときは、開いているタブに移る |
| 再起動したときの状態 | 開いていたタブ・レイアウト・比較対象・SPEC 欄の入力・テーマなどを復元する |
| `git fetch` | しない。リモートのブランチは、利用者が最後に fetch した時点のもの |
| 保存 | SQLite (better-sqlite3 + Drizzle) |
| 全文検索 | ripgrep。インデックスは作らない |

## 3. 構成

```
ブラウザ (React + TanStack Query)
  │  fetch (JSON)                 EventSource (SSE)
  ▼                               ▲
Next.js 16 (Node.js)
  proxy.ts ─ Host / Origin の確認
  Route Handler (src/app/api/**)
  │
  src/server/*
  ├─ exec.ts ─────────── git / rg を実行 (GIT_OPTIONAL_LOCKS=0 など)
  ├─ projects.ts / worktrees.ts ─ 登録と worktree の検出・パスの読み替え
  ├─ files.ts / search.ts ── fs・git ls-files・rg
  ├─ git.ts ──────────── 差分・履歴・ブランチ
  ├─ watch.ts ─────────── chokidar で監視し、SSE の購読者に送る
  └─ db/ ─────────────── SQLite (~/.local/share/sherpa/sherpa.db)
```

- サーバーは Next.js の Route Handler から `fs`・`git` CLI・`rg` を呼ぶ。登録したリポジトリは読むだけで、書き込まない
- 画面はブラウザだけで描画する。最初の描画に要る保存済みの状態 (タブ・テーマ) は、`page.tsx` / `layout.tsx` がサーバーで DB から読んで渡す
- 長く持つもの (DB の接続・監視) は、開発中の再読み込み (HMR) で二重にならないよう `globalThis` に置く

### ディレクトリ

```
bin/sherpa                           起動コマンド (sherpa run [-p PORT] [-d])
web/
  drizzle/                           マイグレーションの SQL
  scripts/check-real-repos.mts       実際のリポジトリに対する読み取り専用の確認
  src/
    app/page.tsx, layout.tsx         保存済みの状態を読んで画面に渡す
    app/api/**/route.ts              Route Handler。引数を確かめて src/server を呼ぶ
    server/                          サーバーの部品 (ブラウザからは読まない)
    proxy.ts                         Host / Origin の確認
    lib/                             サーバーとブラウザで共有する型と純粋な関数、ブラウザのデータ取得 (api.ts)
    components/                      画面部品
  test/                              vitest (unit / integration / fixtures)
```

## 4. 用語

| 用語 | 意味 |
| --- | --- |
| プロジェクト | 登録した git リポジトリ (main worktree のディレクトリ)。id はディレクトリ名から作る slug |
| worktree | プロジェクトの作業ツリー。main worktree の id は `main`、それ以外は `.git/worktrees/<id>` の `<id>` |
| タブ (プロジェクトタブ) | 一番上に並ぶタブ。1 つのタブが「プロジェクト + worktree」に対応する |
| 比較対象 | タブごとに選ぶブランチ。COMPARE・HISTORY・エクスプローラの記号・ファイルのタブの「差分」が参照する |
| SPEC | AI が作る設計資料 (spec / plan など) の `.md`。置き場所を worktree ごとに SPEC 欄で指定する |
| 除外パターン | エクスプローラ・SPEC・検索のどれにも出さないパス。全体の設定 + プロジェクトの設定 |
| パスのマッピング | devcontainer の中のパス → ホストのパスの対応。コンテナで作った worktree を読むのに使う |

## 5. 詳細

開発の手順 (環境の整え方・テスト) は `docs/how-to/development/` にある。

| ファイル | 内容 |
| --- | --- |
| [ui.md](ui.md) | 画面の骨組み (タブ・ホーム・設定・worktree バー・メニュー・エディタの分割・Ctrl+F・パスのサジェスト・状態の保存) |
| [projects.md](projects.md) | プロジェクトの登録・編集・解除、worktree の検出、devcontainer のパスの読み替え |
| [files.md](files.md) | エクスプローラ、SPEC、除外パターン、大きなリポジトリの扱い、ファイルの表示 |
| [search.md](search.md) | 内容の検索とファイル名の検索 |
| [git.md](git.md) | 未コミットの差分・COMPARE・HISTORY・差分の作り方・git の実行 |
| [live-reload.md](live-reload.md) | 自動更新 (監視・SSE・読み直し・通知) |
| [api.md](api.md) | API の一覧と型、エラー、ブラウザ側の取得 |
| [storage.md](storage.md) | SQLite のテーブルとマイグレーション |
| [security.md](security.md) | 待ち受け、Host / Origin の確認、パスの検証、git を安全に呼ぶ決まり |
| [ci.md](ci.md) | CI (GitHub Actions)、依存の脆弱性の扱い、Dependabot、ESLint 10 の互換、TypeScript 6 と 7 の並用 |
