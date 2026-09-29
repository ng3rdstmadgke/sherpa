# プロジェクトと worktree

[overview.md](overview.md) から分けた、プロジェクトの登録と worktree の検出。実装は `web/src/server/projects.ts` と `web/src/server/worktrees.ts`。

## 1. 登録・編集・登録の解除

登録と編集は同じダイアログを使う。

- 登録: ホームの「プロジェクトを登録」ボタン
- 編集: カードの「…」メニューの「編集」、または worktree バーの (i) の「プロジェクトの設定」
- 項目
  - **ディレクトリ** (編集では変更できない): ホームの下のディレクトリだけ。末尾の `/` と `~` は正規化して絶対パスで保存する
  - **表示名**: 既定はディレクトリ名
  - **devcontainer のパスマッピング** (省略できる): 「devcontainer を使う」のチェックを ON にしたときだけ、コンテナのパスとホストのパスを入れて保存する。OFF ならマッピングなしで保存する
    - チェックの既定は、登録では自動の検出 (§3) でマッピングが見つかれば ON、見つからなければ OFF (横に「自動検出」/「devcontainer の設定なし」と出す)。編集では、保存したマッピングがあれば ON
    - コンテナのパスは自動で検出した値 (なければ `/workspaces/<ディレクトリ名>`)、ホストは手で書き換えるまでディレクトリと同じ値
  - **既定の比較対象のブランチ**: 「自動」かブランチの一覧 (ローカル / リモート) から選ぶ。自動なら、実際に使うブランチを横に出す ([git.md](git.md) §5)
  - **表示しないパス (除外パターン)**: 全体の設定に追加するパターン、1 行に 1 つ ([files.md](files.md) §3)。「全体の設定を開く」のリンクで設定タブの項目を開く
- ディレクトリを入力すると `GET /api/projects/detect` で調べ、登録できないときは理由を出して「登録」を押せなくする

  | 状態 | 文言 |
  | --- | --- |
  | ディレクトリがない | ディレクトリが見つかりません |
  | `.git` がファイル (linked worktree) | worktree のディレクトリです。main worktree のディレクトリを登録してください |
  | `.git/HEAD` がない | git リポジトリではありません |
  | 登録済み | 登録済みです |

- id はディレクトリ名から作る slug (重なれば `-2` を付ける)。色は登録の順に割り当てる
- **登録の解除**: カードの「…」メニューの「登録を解除」。確認のダイアログを出す
  - sherpa の DB の行 (プロジェクト・パスマッピング・SPEC 欄の入力) だけを消す。リポジトリのファイルには触れない
  - そのプロジェクトのタブをすべて閉じ、監視を止める。SSE で他のブラウザのタブにも伝える
  - 同じディレクトリをもう一度登録すると、新しいプロジェクトになる

## 2. worktree の検出

- main worktree: 登録したディレクトリ。id は `main`、表示名はプロジェクトの表示名
- ほかの worktree: `git worktree list` は使わずに、`<dir>/.git/worktrees/*/` を読む (コンテナで作った worktree を、ホストの git は `prunable` と誤判定するため)
  1. `gitdir` ファイル (worktree の `.git` ファイルのパス。コンテナの中のパスのことがある) を読む
  2. その親をパスのマッピングで読み替え (§3)、ホストの worktree のパスにする。マッピングに当たらなければそのまま使う
  3. そのパスに `.git` の**ファイル**があり、その `gitdir:` の末尾が `worktrees/<id>` であるときだけ有効とする。ディレクトリがあるだけでは有効としない (開発サーバーに `/workspaces/...` の空のディレクトリがあることがある)。有効でなければ `missing` (見つからない)
- id は `.git/worktrees/<id>` の `<id>`、表示名は worktree のディレクトリ名。この 2 つは一致するとは限らない (git は名前が重なると管理用のディレクトリ名を変える)
- ブランチは `HEAD` ファイルを読んで出す。`ref: refs/heads/<name>` でなければブランチにない HEAD
- git に渡す値: `GIT_DIR=<dir>/.git/worktrees/<id>`、`GIT_WORK_TREE=<ホストの worktree のパス>`。main worktree も `GIT_DIR=<dir>/.git`、`GIT_WORK_TREE=<dir>` を常に明示する ([git.md](git.md) §1)。`commondir` は相対パス (`../..`) なので読み替えはいらない
- worktree の中にある別の worktree (`.worktree/<name>` など) は、その worktree の一覧・検索・監視から外す ([files.md](files.md) §3)
- worktree の一覧は、要求のたびに作り直す (DB には保存しない)。`.git/worktrees` の追加・削除は監視して画面に伝える ([live-reload.md](live-reload.md))

## 3. devcontainer のパスの読み替え

worktree をコンテナの中で作ると、`.git` ファイルにコンテナの中のパスが記録される。

```
~/webapp/.worktree/33_new_region/.git
  → gitdir: /workspaces/webapp/.git/worktrees/33_new_region
```

そのため、ホストで `git status` を実行すると `fatal: not a git repository` で失敗する。`GIT_DIR` と `GIT_WORK_TREE` を明示すると動く。

- 「コンテナのパス → ホストのパス」の対応表をプロジェクトごとに持つ (画面では 1 行だけ編集する)
- 読み替えは前方一致。`/workspaces/webapp` は `/workspaces/webapp` と `/workspaces/webapp/...` にだけ当たり、`/workspaces/webappx` には当たらない
- 自動の検出 (登録ダイアログ)
  1. `.devcontainer/devcontainer.json`、`.devcontainer.json`、`.devcontainer/*/devcontainer.json` の `workspaceFolder` (コメント付き JSON。`${localWorkspaceFolderBasename}` は置き換える)
  2. 1 がなければ、worktree の `.git` ファイルに記録されている `gitdir: <X>/.git/worktrees/<id>` の `<X>` (実際に記録されているパスなので確実)
  3. どちらもなく、devcontainer.json があれば (`workspaceFolder` がないとき) `/workspaces/<ディレクトリ名>` (devcontainer の既定)
  4. devcontainer.json も、コンテナで作った worktree もなければ、devcontainer を使っていないとみなしてマッピングなし
- ホストの側は登録するディレクトリ
- (i) 詳細には、読み替えている worktree のコンテナの中のパスを出す

## 4. 制約

- 登録できるのはホームの下のディレクトリだけ (ディレクトリのサジェストと同じ範囲。[security.md](security.md))
- サブモジュールは特別に扱わない。git の出力のとおり、中身のないディレクトリになる
