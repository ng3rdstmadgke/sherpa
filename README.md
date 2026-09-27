# sherpa

複数の開発プロジェクト (git リポジトリ / worktree) のソースコード・Markdown・git 差分を、1 つのブラウザ画面で横断して閲覧するローカル Web アプリ。

- 仕様: [docs/spec-draft.md](docs/spec-draft.md)、本実装の計画と未決事項: [docs/implementation-plan.md](docs/implementation-plan.md)
- アプリ本体: [web/](web/) (Next.js + Tailwind CSS + shadcn/ui。サーバーは Route Handler から git と ripgrep を呼ぶ)
- 保存: SQLite (`~/.local/share/sherpa/sherpa.db`。環境変数 `SHERPA_DB` で変えられる)
- ripgrep は npm の `@vscode/ripgrep` に同梱のものを使う (`npm install` で入る)。git は開発サーバーのものを使う

## 起動 (開発サーバー上)

```bash
cd ~/sherpa/web
npm install      # 初回のみ
npm run dev      # http://127.0.0.1:4747 で待ち受け
PORT=4800 npm run dev   # ポートを変える場合
npm test                # vitest (単体テストと、一時ディレクトリの git リポジトリでの結合テスト)
npx tsx scripts/check-real-repos.mts ~/repo-a ~/repo-b='archives/**'   # 手元の実際のリポジトリに対する読み取り専用の確認 (= の後は除外パターン)
```

- プロジェクトはホームの「プロジェクトを登録」で登録する (ホームの下の git リポジトリのディレクトリ)

- ポートの既定値は **4747**。3000 などの、他の開発ツールがよく使うポートと重ならない番号にしている
- サーバー上のファイルを読むアプリなので、`127.0.0.1` でのみ待ち受ける。
  IP アドレス (例 `http://<開発サーバーの IP>:4747`) を指定して直接アクセスすることはできない
- 手元の PC からは、SSH のポートフォワードを使って開く (次の節)

## 手元の PC から開く (SSH ポートフォワード)

サーバーの `127.0.0.1:4747` を、SSH の接続を通して手元の PC の `localhost:4747` に転送する。

### 設定手順 (最初に 1 回だけ)

`~/.ssh/config` に `LocalForward` を 1 行追記しておくと、普段どおりに SSH で接続するだけで転送も始まる。

1. **手元の PC** (開発サーバーではない) で SSH の設定ファイルを開く

   | OS | 場所 |
   | --- | --- |
   | macOS / Linux | `~/.ssh/config` |
   | Windows | `C:\Users\<ユーザー名>\.ssh\config` (拡張子なし) |

   ファイルがなければ新しく作る。

2. 開発サーバーに接続するときに使っている `Host` のブロックを探し、その中に次の 1 行を追記する。
   インデントは、同じブロックの他の行に合わせる

   ```sshconfig
   Host <いつも接続に使っているホスト名>
     HostName <開発サーバーのホスト名 or IP>
     User <ユーザー名>
     LocalForward 4747 127.0.0.1:4747    # ← この行を追記
   ```

   `Host` のブロックがまだない場合 (いつも `ssh <ユーザー名>@<開発サーバーの IP>` のように直接指定して接続している場合) は、上のブロックをまるごと追加する。
   以後は `ssh <Host に書いた名前>` で接続する

3. 開発サーバーに接続し直す。すでに開いている SSH 接続には反映されないので、一度切断してから接続する

   ```bash
   ssh <Host に書いた名前>
   ```

4. 開発サーバー上で sherpa を起動し (`npm run dev`)、手元の PC のブラウザで http://localhost:4747 を開く

SSH で接続している間だけ開ける。tmux を使うためにいつも SSH で接続しているなら、その接続だけで sherpa も開けるようになる。

### うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| 接続したときに `bind [127.0.0.1]:4747: Address already in use` と出る | 手元の PC で 4747 番がすでに使われている。よくあるのは、SSH の接続をもう 1 本開いていて、そちらが先に転送している場合。**この場合は警告だけなので無視してよい** (先に開いた接続で転送されている)。他のアプリが 4747 番を使っているなら、`LocalForward 4800 127.0.0.1:4747` のように左側の番号を変え、http://localhost:4800 で開く |
| ブラウザで開くと、SSH のターミナルに `channel ... open failed: connect failed` と出る | 開発サーバーで sherpa が起動していない。`npm run dev` で起動する |
| つながらない (`ERR_CONNECTION_REFUSED`) | 手順 3 で接続し直していない。または、追記した `Host` と実際に接続している `Host` が違う。`ssh -G <Host名> \| grep -i localforward` で、設定が読み込まれているか確認できる |

### 設定を書かずに一時的に転送する

```bash
# 転送だけする接続を別に張る (-N: コマンドを実行しない)
ssh -N -L 4747:127.0.0.1:4747 <ユーザー名>@<開発サーバー>
```

すでに開いている SSH 接続に後から追加することもできる。改行の直後に `~C` と入力すると `ssh>` という入力欄が出るので、`-L 4747:127.0.0.1:4747` と入力して Enter を押す。

### VS Code の Remote-SSH を使っている場合

VS Code で開発サーバーに接続している間は、ポート 4747 が自動で転送される (「ポート」タブで確認できる)。上の設定は不要。

## 注意

- 同じディレクトリで `next dev` を 2 つ同時に起動することはできない (Next.js 16 の仕様)。
  `Another next dev server is already running` と表示されたら、既存のプロセスを止めてから起動し直す。
