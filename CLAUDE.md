# sherpa

複数の開発プロジェクト (git リポジトリ / worktree) のソースコード・Markdown・git 差分を、1 つのブラウザ画面で横断して閲覧するローカル Web アプリ。閲覧専用。

## 資料

- 仕様: `docs/agent-tasks/init/spec-draft.md` (§6 がモックとの差異)
- 起動方法とポートフォワード: `README.md`
- アプリ: `web/` (Next.js 16 + Tailwind CSS v4 + shadcn/ui)
- 本実装前のモック: `mock/` (git の管理外。手元にだけある。ない場合は使わない)
  - 画面の動きを見比べるための参照用。**編集しない**。本実装は `web/` で行う
  - 起動するときは別のポートにする: `cd mock && PORT=4748 npm run dev`
  - コードを検索するときは `mock/` を対象から外す (同じ名前のファイルが `web/` にもあるため)

## コマンド (web/ で実行)

- `npm run dev`: `127.0.0.1:4747` で起動する (`PORT` で変更できる)
- `npm run lint` / `npx tsc --noEmit` / `npm run build` / `npm test`
- `npx tsx scripts/check-real-repos.mts <repo> [<repo>=<除外>,…]`: 実際のリポジトリに対する読み取り専用の確認
- `npx tsc --noEmit` の `LayoutProps` のエラーは、Next.js が起動時に型を生成するまで出るもので無視してよい

## 守ること

- 確認に使う実際のリポジトリ (`CLAUDE.local.md` に書く。公開しない) は読み取り専用。fetch / checkout / add など書き込む操作は実行しない。git は `GIT_OPTIONAL_LOCKS=0` を付けて実行する (`git status` が index を書き換えないように)
- `127.0.0.1` 以外では待ち受けない
- 同じディレクトリで `next dev` を 2 つ起動できない。`127.0.0.1:4747` で dev サーバーが動いていればそれを使う。自分で起動したら、終わったら止める

## 開発上の注意

- Next.js 16 は学習データと違う。書く前に `web/node_modules/next/dist/docs/` を読む (`web/AGENTS.md`)
- shadcn/ui は base-nova スタイル = Base UI。`asChild` ではなく `render` prop を使う (例: `<DialogTrigger render={<Button />}>`)。`cn` は `"cn"` パッケージから import する
- shadcn の Select (Base UI) は選んだ値の表示名の扱いが面倒なので、単純な選択欄はブラウザ標準の `select` を Input と同じ見た目にして使っている
- eslint は react-hooks v7。effect の中で直接 setState しない (MutationObserver や requestAnimationFrame などのコールバックの中なら可)
- Tailwind v4: `prose-neutral` と `dark:prose-invert` を同じ規則で `@apply` すると、ダークの配色が効かない。ダークは別の規則 (`.dark .markdown-body`) に分ける (`web/src/app/globals.css`)
- テーマ変数 (`--color-*`) は使われていないと CSS に出力されないことがある。確実に色を付けたい所は値を直接書く
- 画面の状態の保存は `web/src/lib/persist.ts` (SQLite の `ui_state`。page.tsx が読んで渡し、変更は `PUT /api/ui-state` でまとめて書く)
- サーバーの部品は `web/src/server/`、API は `web/src/app/api/`、ブラウザからの呼び出しは `web/src/lib/api.ts` (TanStack Query)

## コードの書き方

- モックに合わせる: セミコロンなし、ダブルクォート、2 スペース、1 行は長め (140 文字程度まで)
- コメントは日本語。何をするか・なぜそうするかを短く書く
- prettier の設定はない。prettier で書き換えない (既定の設定ではセミコロンが付いてしまう)

## 確認のしかた

- 型チェックと lint を通す
- 画面は、scratchpad に `puppeteer-core` を入れ、`/usr/bin/google-chrome` で操作してスクリーンショットを撮って確かめる。クリップボードは `overridePermissions` で `clipboard-read` / `clipboard-write` を許可すれば読める
- 純粋な関数は `npx tsx` で直接実行して確かめられる (拡張子なしの import があるため、Node の型の自動除去では読み込めない)

## コミット

- メッセージは日本語。1 行目に要約、空行のあとに箇条書きで変更点
- 最後に `Co-Authored-By` を付ける。push はしない
