# Sherpa

## Overview

Sherpa は、複数の開発プロジェクト (git リポジトリ / worktree) のソースコード・Markdown・git の差分を、1 つのブラウザ画面で横断して閲覧するローカル Web アプリです。
プロジェクトごとに VS Code を開いたり devcontainer にアタッチしたりしなくても、ブラウザのタブを切り替えるだけで、AI が書いた spec や変更の中身を確かめられます。

- **プロジェクトと worktree をタブで開く**: 登録したリポジトリの worktree ごとにタブを開き、並べて見比べられます。devcontainer の中で作った worktree も、パスを読み替えて開けます
- **ファイルを見る**: ツリー、シンタックスハイライト、Markdown のプレビュー (GFM・mermaid・画像)、内容とファイル名の検索 (ripgrep)
- **SPEC**: AI が作る設計資料 (spec / plan など) の置き場所を worktree ごとに指定し、ツリーの上に常に表示します
- **git の差分を見る**: 未コミットの差分、任意のブランチとの比較 (マージベースから)、そのブランチにないコミットの一覧と詳細。Unified / Split で表示できます
- **画面分割**: タブをドラッグして、左右・上下に分割できます
- **自動更新**: ファイルが書き換わると、開いているタブと差分を自動で読み直します
- **閲覧専用**: 編集や git の操作 (add / commit / fetch など) はしません

開発サーバー (Linux) の上で起動し、`127.0.0.1:4747` でだけ待ち受けます。手元の PC からは SSH のポートフォワードを通して開きます。

仕様と仕組みは [docs/architecture/overview.md](docs/architecture/overview.md) にあります。

## Getting started

### 依存パッケージのインストール

開発サーバーに次のものが必要です。

| もの | 用途 |
| --- | --- |
| Node.js 22 以上 (24 で確認) | アプリの実行 |
| git | リポジトリの読み取り |
| gcc / make / python3 | SQLite のドライバ (better-sqlite3) のビルド |

ripgrep は npm のパッケージに同梱のものを使うので、別に入れる必要はありません。

#### Ubuntu 24.04 の場合

apt で git とビルドに使うものを入れます。

```bash
sudo apt update
sudo apt install -y git build-essential python3 curl
```

Node.js は nvm で入れます (apt の nodejs は 18 系で、古くて使えません)。
`nvm install` はシェルの既定の版 (`nvm alias default`) を変えません。Sherpa を動かすときは、`web/.nvmrc` に書いた版 (24) に `nvm use` で切り替えます。

```bash
# nvm の最新の版を調べる (github.com の releases/latest のリダイレクト先が最新のタグ)
NVM_VERSION=$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/nvm-sh/nvm/releases/latest)")
echo "$NVM_VERSION"   # v0.40.8 のように出る
curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
source ~/.bashrc
nvm install 24
```

#### Sherpa のパッケージインストール

```bash
git clone https://github.com/ng3rdstmadgke/sherpa.git ~/sherpa
cd ~/sherpa/web
nvm use          # web/.nvmrc の版 (24) に切り替える
node --version   # v24.x と出れば OK
npm install
```

### 起動


```bash
cd ~/sherpa/web
nvm use                      # web/.nvmrc の版 (24) に切り替える。シェルを開くたびに要る

# 開発用として起動する
(nvm use && npm run dev)                  # http://127.0.0.1:4747 で待ち受ける

# ビルドして起動する
(nvm use && npm run build && npm run start)

# ポートを指定する場合
(nvm use && PORT=4748 npm run dev)
(nvm use && npm run build && PORT=4748 npm run start)
```

ローカルのPCで http://localhost:4747 にアクセス

- 登録したプロジェクトや画面の状態 (開いていたタブ・分割・テーマなど) は SQLite (`~/.local/share/sherpa/sherpa.db`) に保存し、次に開いたときに復元します。場所は環境変数 `SHERPA_DB` で変えられます

### SSH ポートフォワード

リモートサーバーでSherpaを実行する場合、手元のPCから http://localhost:4747 でアクセスするには SSH ポートフォワードが必要です。
`~/.ssh/config` に以下のように `LocalForward 4747 127.0.0.1:4747` を指定します。

```~/.ssh/config
# ~/.ssh/config

Host remote-server-name
  HostName 192.168.50.10
  User ubuntu
  LocalForward 4747 127.0.0.1:4747    # ← この行を追記
```

追記したら、開発サーバーに再接続します。以後は設定どおり、リモートサーバーの `4747` ポートが手元のPCの `4747` ポートにフォワーディングされます。


ローカルのPCで http://localhost:4747 にアクセス

## Development

- 開発環境を整える (playwright-cli など): [docs/how-to/development/setup.md](docs/how-to/development/setup.md)
- テストと確認: [docs/how-to/development/testing.md](docs/how-to/development/testing.md)
- 仕組み (アーキテクチャ): [docs/architecture/overview.md](docs/architecture/overview.md)
- 開発の決まり (コーディング規約・確認のしかたなど): [CLAUDE.md](CLAUDE.md)
