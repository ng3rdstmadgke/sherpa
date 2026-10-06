# sherpa

複数の開発プロジェクト (git リポジトリ / worktree) のソースコード・Markdown・git 差分を、1 つのブラウザ画面で横断して閲覧するローカル Web アプリ。閲覧専用。

## 原則

- ユーザには日本語で応答すること

## 資料

- 仕様と仕組みの正本: `docs/architecture/overview.md` (機能ごとの詳細は `docs/architecture/*.md`)
- 開発の手順書: `docs/how-to/development/` (環境の整え方 `setup.md`、テストと確認 `testing.md`)。開発の手順を書くときもここに置く
- 初回の実装のときの資料 (仕様のドラフト・実装計画・経緯): `docs/agent-tasks/init/` (更新しない)
- 起動方法とポートフォワード: `README.md`
- アプリ: `web/` (Next.js 16 + Tailwind CSS v4 + shadcn/ui)
  - サーバーの部品は `web/src/server/`、API は `web/src/app/api/`、ブラウザからの呼び出しは `web/src/lib/api.ts` (TanStack Query)
  - 画面の状態の保存は `web/src/lib/persist.ts` (SQLite の `ui_state`。page.tsx が読んで渡し、変更は `PUT /api/ui-state` でまとめて書く)

## 資料の直し方

- コードを変えたら (画面の動き・API・git のコマンド・保存・上限や時間の値・開発の手順など)、同じコミットで `docs/architecture/` と `docs/how-to/` の該当する所を、変えたあとの仕様に合わせて直す
  - 直す所がないと思っても、関係するファイルを読んで確かめる
  - 新しい機能で当てはまるファイルがなければ、`docs/architecture/` に作り、`overview.md` の表に足す
- 書くのは**今の仕様だけ**。過去の仕様は残さない
  - 「以前は」「〜から変えた」「旧:」「(v2 では)」のような経緯や比較を書かない。書き換えた所は、はじめからそうだったように書く
  - なくした機能や設定は、記述ごと消す (「廃止」「使わない」と残さない)
  - 経緯や理由の移り変わりはコミットメッセージに書く。今の仕様の理由 (なぜそうしているか) は書いてよい
- 値 (上限・時間・コマンドの引数など) はコードに合わせる。推測で書かない
- `docs/agent-tasks/` は作業ごとの記録なので、ここに合わせて直さない

## コマンド (web/ で実行)

- `npm run dev`: `0.0.0.0:4747` で起動する (`PORT` でポート、`SHERPA_HOST` で待ち受けるアドレスを変更できる。このマシンの IP アドレスとホスト名以外の名前で開くときは `SHERPA_ALLOWED_HOSTS`)
- `bin/sherpa run [-p <PORT>] [-H <ADDR>] [--allow-host <NAME>] [-d]` (リポジトリの直下から): Node.js の切り替え・npm install・必要なときのビルドをしてから起動する。`-d` は `npm run dev`
- `npm run lint` / `npx tsc --noEmit` / `npm run build` / `npm test`
- `npx tsx scripts/check-real-repos.mts <repo> [<repo>=<除外>,…]`: 実際のリポジトリに対する読み取り専用の確認
- `npx tsc --noEmit` の `LayoutProps` のエラーは、Next.js がまだ型を生成していないときに出る。`npx next typegen` を先に実行すれば出ない
- CI (`.github/workflows/ci.yml`) は push / pull request で `npm audit --audit-level=critical`・lint・型チェック・`npm test`・build を流す。仕組みは `docs/architecture/ci.md`
- `npm run build` の `globals.css` の `::highlight(...)` の警告 (Turbopack の CSS パーサーが知らない擬似要素) は無視してよい。規則は出力に残り、Ctrl+F の強調は効く

## 守ること

- 確認に使う実際のリポジトリ (`CLAUDE.local.md` に書く。公開しない) は読み取り専用。fetch / checkout / add など書き込む操作は実行しない
  - git は `GIT_OPTIONAL_LOCKS=0` と `-c diff.autoRefreshIndex=false` を付けて実行する (`GIT_OPTIONAL_LOCKS=0` だけでは、`git diff` が stat の変わったファイルのために index を書き直すことがある)
- 待ち受けは既定で `0.0.0.0` (認証はない)。許すホスト名を広げるときは `SHERPA_ALLOWED_HOSTS` を使い、Host / Origin の確認 (`web/src/lib/request-guard.ts`) は外さない
- 同じディレクトリで `next dev` を 2 つ起動できない。`4747` で dev サーバーが動いていればそれを使う。自分で起動したら、終わったら止める

## 開発上の注意

- Next.js 16 は学習データと違う。書く前に `web/node_modules/next/dist/docs/` を読む (`web/AGENTS.md`)
- shadcn/ui は base-nova スタイル = Base UI。`asChild` ではなく `render` prop を使う (例: `<DialogTrigger render={<Button />}>`)。`cn` は `"cn"` パッケージから import する
- shadcn の Select (Base UI) は選んだ値の表示名の扱いが面倒なので、単純な選択欄はブラウザ標準の `select` を Input と同じ見た目にして使っている
- eslint は react-hooks v7。effect の中で直接 setState しない (MutationObserver や requestAnimationFrame などのコールバックの中なら可)
- ESLint 10。`eslint-config-next` の中のプラグインが ESLint 10 に対応していないので、`web/eslint.config.mjs` で `@eslint/compat` の `fixupConfigRules` で包んで動かしている (`docs/architecture/ci.md` §4)
- Tailwind v4: `prose-neutral` と `dark:prose-invert` を同じ規則で `@apply` すると、ダークの配色が効かない。ダークは別の規則 (`.dark .markdown-body`) に分ける (`web/src/app/globals.css`)
- テーマ変数 (`--color-*`) は使われていないと CSS に出力されないことがある。確実に色を付けたい所は値を直接書く
- サーバーから git / rg を呼ぶときは `web/src/server/exec.ts` の `git()` / `run()` を通す (環境変数・`-c` の設定・同時実行数の制限がまとまっている)
- `@vscode/ripgrep` は import しない。Turbopack が rg の実行ファイルまでバンドルしようとして失敗するので、`exec.ts` の `rgPath()` でパスを組み立てている
- TypeScript は 6 と 7 を並べて入れている。`tsc` は 7 (型チェック)、API を使う道具 (typescript-eslint・`next build`) は `typescript` の名前の 6 を使う。6 のコマンドは `tsc6` (`docs/architecture/ci.md` §5)
- `web/package.json` の `overrides` は、依存の中の脆弱な版を上書きしている (理由は `docs/architecture/ci.md` §2)。上の依存が直したら外せる
- テーブルの定義 (`web/src/server/db/schema.ts`) を変えたら、`npx drizzle-kit generate` で SQL を作り、`web/drizzle/` もコミットする (起動時に自動で当たる)

## コードの書き方

- 既存のコードに合わせる: セミコロンなし、ダブルクォート、2 スペース、1 行は長め (140 文字程度まで)
- コメントは日本語。何をするか・なぜそうするかを短く書く
- prettier の設定はない。prettier で書き換えない (既定の設定ではセミコロンが付いてしまう)

## 確認のしかた

- `npm run lint`・`npx tsc --noEmit`・`npm test` を通す。大きく変えたら `npm run build` も
- 実際にアプリを画面で確認する場合は、playwright-cli スキル (`.claude/skills/playwright-cli`) を使う。puppeteer などを自分で入れて操作しない
  - `playwright-cli` が入っていなければ、`docs/how-to/development/setup.md` の手順で入れる (グローバルに入れるので、利用者に確かめてから)
  - ブラウザは `playwright-cli open --browser=chrome` (`/usr/bin/google-chrome`) で開き、操作してスクリーンショットを撮って確かめる。出力は scratchpad に置く
  - 何段階もの操作は `playwright-cli run-code --filename=<script.js>` にまとめると速い
- `npm run dev` は実際の DB (`~/.local/share/sherpa/sherpa.db`) に書き込む。試しに登録したプロジェクトなどを残したくないときは、`SHERPA_DB` に一時ファイルを指定して起動する
- 純粋な関数は `npx tsx` で直接実行して確かめられる (拡張子なしの import があるため、Node の型の自動除去では読み込めない)

## コミット

- メッセージは日本語。1 行目に要約、空行のあとに箇条書きで変更点
- 最後に `Co-Authored-By` を付ける。push はしない
