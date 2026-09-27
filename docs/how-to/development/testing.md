# テストと確認

変更を確かめる手順。コマンドはすべて `web/` で実行する (`nvm use` を済ませておく)。

## 1. いつも通すもの

```bash
npm run lint          # eslint
npx tsc --noEmit      # 型チェック
npm test              # vitest (単体テストと結合テスト)
npm run build         # 大きく変えたとき
```

- `npx tsc --noEmit` の `LayoutProps` のエラーは、Next.js が起動時に型を生成するまで出るもので無視してよい
- `npm run build` の `globals.css` の `::highlight(...)` の警告は無視してよい (Turbopack の CSS パーサーが知らない擬似要素。規則は出力に残る)

## 2. 単体テスト (`web/test/unit/`)

純粋な関数と、git / rg の出力のパーサーが対象。

| ファイル | 対象 |
| --- | --- |
| `lib.test.ts` | glob (`**` と `*`、ディレクトリへの当てはめ、検索の対象 / 対象外の解釈)、SPEC 欄の解釈、検索語の解釈 (単語単位の日本語を含む)、相対時間の表示、Host / Origin / Content-Type の確認 |
| `server.test.ts` | `diff --raw --numstat -z` (名前の変更・バイナリ・日本語とスペースのあるパス)、`for-each-ref`、`log`、unified diff → `DiffLine[]`、rg の JSON (バイト位置 → UTF-16 の位置)、パスの検証、パスの読み替え、ツリーの組み立て |

## 3. 結合テスト (`web/test/integration/`)

`web/test/fixtures/make-repo.ts` が一時ディレクトリにリポジトリを作り、サーバーの関数・Route Handler・監視を実際に動かす。

- fixture の作るもの
  - `main`・`develop`・`feature/x` (main から先行・遅れ、マージコミットを含む) のリポジトリ
  - 未コミットの変更: Staged / Unstaged / 名前の変更 / 削除 / Untracked / バイナリ / 画像 / 日本語とスペースのあるファイル名
  - `.gitignore` の対象: `node_modules/`、`tmp/`、`agent-tasks/` (SPEC の資料)、中身だけを無視するパターン (`**/.terraform/*`)、無視されたディレクトリの中の別のリポジトリ
  - コンテナで作った worktree: `.git` ファイルと `gitdir` を偽のコンテナ内のパスに書き換え、そのパスに空のディレクトリを作る (ディレクトリはあるが worktree ではない状態)。コメント付きの `devcontainer.json`
  - 管理用のディレクトリの名前 (`<id>`) とディレクトリ名が違う worktree、ブランチにない HEAD の worktree、ディレクトリを消した worktree
  - リモート: `origin` ではない名前 (`upstream`) で、`<remote>/HEAD` のないもの (一時ディレクトリの bare リポジトリから fetch する)
  - 別のリポジトリ: `master` だけ、`trunk` だけ (自動の比較対象がない)、ローカルに main がなくリモートにだけある、コミットがない、git リポジトリでないディレクトリ
- 利用者の git の設定は読まない (`GIT_CONFIG_GLOBAL=/dev/null` など)
- `SHERPA_DB` に一時ファイル、`SHERPA_HOME` に一時ディレクトリを渡してから、サーバーの部品を読み込む

| ファイル | 対象 |
| --- | --- |
| `server.test.ts` | worktree の検出とパスの読み替え、一覧 (gitignore ON / OFF・lazy・除外パターン・別の worktree)、SPEC、ファイルの内容、未コミットの差分と COMPARE (`git diff --numstat` を直接実行した結果と比べる)、履歴、1 ファイルの差分、検索、エラー、読み取りだけであること (index の mtime) |
| `api.test.ts` | Route Handler を直接呼ぶ (`new Request("http://127.0.0.1:4747/…")`): 登録 (と登録できない場合)・編集・登録の解除・設定・画面の状態・worktree の API |
| `watch.test.ts` | chokidar と SSE の通知: 作業ツリー・git の変化・worktree の追加、無視されたディレクトリは届かず SPEC の場所は届くこと |

結合テストはファイルごとに順に流す (`fileParallelism: false`)。

## 4. 実際のリポジトリの確認 (`web/scripts/check-real-repos.mts`)

手元の実際のリポジトリを読み取りだけで確かめる。確認に使うリポジトリは公開しないので、引数で渡す。

```bash
npx tsx scripts/check-real-repos.mts ~/repo-a ~/repo-b='archives/**,tmp/**'
```

- `=` の後は、そのリポジトリの除外パターン (カンマ区切り)
- DB には登録せず、メモリ上のプロジェクトとしてサーバーの関数を呼び、git を直接実行した結果と比べる
- 項目: worktree の一覧 (パスの読み替え)、ブランチの一覧、ファイルツリー、ファイルの内容、検索、未コミットの差分、COMPARE、HISTORY、読み取り専用
- 実行の前後で `.git` の `index`・`HEAD`・`packed-refs`・`config`・`refs`・`worktrees/*` の mtime と大きさを比べ、変わっていたら NG にする
- NG が 1 つでもあれば終了コード 1

## 5. 画面で確かめる

- playwright-cli のスキルで操作し、スクリーンショットを撮って確かめる (入れ方は [setup.md](setup.md))
- 実際のリポジトリに書き込まずに自動更新を確かめたいときは、ホームの下に使い捨てのリポジトリを作って登録し、そのファイルを書き換える。終わったら登録を解除して消す
