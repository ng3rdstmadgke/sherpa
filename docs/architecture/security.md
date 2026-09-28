# セキュリティ

[overview.md](overview.md) から分けた、ローカルの Web アプリとしての守り。実装は `web/src/proxy.ts` と `web/src/lib/request-guard.ts` (要求の確認)、`web/src/server/paths.ts` (パスの検証)、`web/src/server/exec.ts` (git の実行)、`web/src/server/preview.ts` (HTML のプレビューの合言葉)。

## 1. 待ち受け

- `127.0.0.1` でだけ待ち受ける (`package.json` の `next dev -H 127.0.0.1` / `next start -H 127.0.0.1`)。Next.js の既定は `0.0.0.0` なので、`-H` を消さない
- 認証は設けない。手元の PC からは SSH のポートフォワードで開く

## 2. Host と Origin の確認 (`proxy.ts`)

すべての要求 (ページ・`/_next`・API) で確かめる。

- `Host` のホスト名が `127.0.0.1`・`localhost`・`[::1]` 以外なら 421 (DNS rebinding の対策)
  - ポートは見ない。SSH のポートフォワードで手元の別のポート (`LocalForward 4800 127.0.0.1:4747`) から開くと、`Host` は `localhost:4800` になるため
- `Sec-Fetch-Site: cross-site` の要求は 403 (ほかのサイトのページから読ませない。`<img>` などを含む)
  - 例外: HTML のプレビュー (`…/preview/<合言葉>/<path>`) の GET / HEAD。プレビューの中からの読み込みは cross-site になるため。代わりに合言葉を確かめる (§6)
- 書き込み (GET / HEAD / OPTIONS 以外)
  - `Origin` があれば、そのホスト名も上と同じであること (違えば 403)
  - `Content-Type: application/json` に限る (違えば 415)。ほかのサイトのページからの単純なリクエスト (preflight のないもの) で書き換えられないように
- CORS のヘッダーは返さない

## 3. 読める場所とパスの検証 (`paths.ts`)

- 読める場所は、登録したプロジェクトのディレクトリと、その worktree のパス (読み替えたもの) だけ。API は projectId / worktreeId から読む場所を決め、利用者から場所を受け取らない
- 受け取った相対パスは、空・絶対パス・`\0`・`\`・`..` / `.` / 空の区切りを含むものを断る (`INVALID_PATH`)
- `path.resolve(root, rel)` が root の下にあることを確かめたうえで、`realpath` の結果も `realpath(root)` の下にあることを確かめる (シンボリックリンクで外に出ない。`OUTSIDE`)
- シンボリックリンクそのものは `lstat` で見分ける。中を指すリンクはリンク先を読み、外を指すリンクは中身を読まずにリンク先のパスだけを返す
- 一覧・SPEC・監視・Untracked の行数ではシンボリックリンクをたどらない
- 例外: `GET /api/fs/dirs` と `GET /api/projects/detect` はホームの下を読むが、返すのはディレクトリの名前・`.git` の有無・`devcontainer.json` の `workspaceFolder`・ブランチの一覧だけ。`realpath` もホームの下であることを確かめる
- プロジェクトとして登録できるのは、ホームの下のディレクトリだけ

## 4. git を安全に呼ぶ

- シェルを通さずに実行する (`spawn`)
- 利用者の入力は、そのまま引数にしない
  - ブランチは一覧にある名前だけを受け付け、完全な ref (`refs/heads/…` / `refs/remotes/…`) にして渡す (`--output=…` のようなオプションや、同じ名前のファイルと取り違えない)
  - コミットは 16 進数だけを受け付け、`--end-of-options` を付けて確かめる
  - パスは `--` の後に `:(literal)<path>` で渡す
- 登録したリポジトリには書き込まない ([git.md](git.md) §1)
  - `GIT_OPTIONAL_LOCKS=0` と `-c diff.autoRefreshIndex=false` で index を書き換えない
  - `-c gc.auto=0 -c maintenance.auto=false` で gc を起こさない (コンテナで作った worktree の管理用のディレクトリが消えるため)
- git の設定 (`.git/config` のフックやフィルタ) は利用者のものなので信頼する。ただし `--no-ext-diff --no-textconv` と `core.fsmonitor=false` で、差分や status のたびに外部のコマンドを動かさない

## 5. ファイルの生の応答 (`GET …/raw`)

- `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、`Cache-Control: no-store` を付ける
- Content-Type は拡張子から決めた画像の型だけ。それ以外は `application/octet-stream` にする (worktree の中の HTML や SVG が sherpa の画面として動かないように)
- 50 MB を超えるものは返さない

## 6. HTML のプレビュー (`GET …/preview/<合言葉>/<path>`)

worktree の中の HTML は、sherpa の画面から、sherpa と別の origin として動かす。同じ origin で動くと、ページの中のスクリプトが sherpa の API ですべてのプロジェクトを読んだり、登録を書き換えたりできてしまうため。

- 画面では `<iframe sandbox="allow-scripts">` で開く。応答にも `Content-Security-Policy: sandbox allow-scripts` を付ける (URL を直接開いても同じ)
  - スクリプトは動く。`allow-same-origin` を付けないので、ページの origin は `null` になる
  - ページから sherpa の API への要求は cross-site になり、§2 で断る。CORS のヘッダーも返さないので、応答は読めない
  - フォームの送信・ポップアップ・一番上のページの移動はできない (`allow-forms` などを付けない)
- ページの中の CSS・画像・スクリプトの読み込みとリンクの移動も cross-site になり、Referer も付かない。そこで URL に合言葉を入れ、§2 の例外で通したうえで Route Handler で確かめる (`web/src/server/preview.ts`)
  - 合言葉は、サーバーを起動するたびに作る秘密の値から、worktree ごとに HMAC で作る。別の worktree の合言葉では読めない
  - 画面は `GET …/preview-token` で合言葉を受け取る (§2 のとおり、ほかのサイトからは読めない)。合言葉を知らないほかのサイトは、プレビューの URL を読めない
  - ページは自分の URL (合言葉) を知っているので、同じ worktree のほかのファイルを読み込める。ただし origin が `null` なので、スクリプトから中身を読めるのは、スクリプトとして動かしたものだけ (CORS のため)
- パスの検証は §3 と同じ (外を指すリンクは読まない)。Content-Type は拡張子から決め (HTML・CSS・JavaScript・JSON・画像・フォントなど)、知らないものは `application/octet-stream`。`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、50 MB まで
