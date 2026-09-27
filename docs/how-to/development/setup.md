# 開発環境を整える

sherpa を開発するための環境の手順。アプリを動かすだけなら README の「Getting started」で足りる。
開発の決まり (コーディング規約・確認のしかたなど) は `CLAUDE.md`、仕組みは `docs/architecture/overview.md` にある。

## 1. アプリを動かせるようにする

README の「Getting started」の「依存パッケージのインストール」と「Sherpa のパッケージインストール」を済ませる (Node.js 24・git・ビルドに使うもの、`npm install`)。

```bash
cd ~/sherpa/web
nvm use          # web/.nvmrc の版 (24) に切り替える。シェルを開くたびに要る
npm install
```

## 2. playwright-cli を入れる

画面の確認には [playwright-cli](https://github.com/microsoft/playwright-cli) を使う (Claude Code からは `.claude/skills/playwright-cli` のスキルで使う)。
インストールは公式の手順に沿って行う。npm で入れる場合の例:

```bash
npm install -g @playwright/cli@latest
playwright-cli --version
```

ブラウザは Google Chrome を `playwright-cli open --browser=chrome` で使う。
Chrome が入っていないと `open` はエラーで止まる (自動では入れない)。その場合は次のコマンドで入れる (Google Chrome をシステムに入れるので sudo の権限が要る)。

```bash
playwright-cli install-browser chrome
```

## 3. 起動して確かめる

```bash
cd ~/sherpa/web
npm run dev      # http://127.0.0.1:4747
```

- 同じディレクトリで `npm run dev` を 2 つ同時に起動することはできない。動いていればそれを使う
- `npm run dev` は実際の DB (`~/.local/share/sherpa/sherpa.db`) に書き込む。試しに登録したプロジェクトなどを残したくないときは、一時ファイルを指定して起動する

  ```bash
  SHERPA_DB=/tmp/sherpa-try.db npm run dev
  ```

- テストと確認のしかたは [testing.md](testing.md)
