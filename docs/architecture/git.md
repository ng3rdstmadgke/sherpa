# git (差分・履歴・ブランチ)

[overview.md](overview.md) から分けた、Git メニューと差分の仕組み。実装は `web/src/server/git.ts`、git の出力のパースは `web/src/server/git-parse.ts`、実行は `web/src/server/exec.ts`。

## 1. git の実行

- `spawn` (シェルを通さない) で実行する。既定で 10 秒で止め、出力は 64 MB まで。同時に 8 個まで
- すべての git に付けるもの
  - 環境変数: `GIT_OPTIONAL_LOCKS=0`、`GIT_DIR`・`GIT_WORK_TREE` (main worktree も含め、常に 2 つとも明示する。`GIT_DIR` だけだと、git は実行したディレクトリを worktree の直下とみなす)、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`、`GIT_PAGER=cat`
  - 設定: `-c core.quotepath=false -c color.ui=false -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false -c diff.autoRefreshIndex=false`
  - 出力にパスが入るものは `-z` (日本語やスペースのあるファイル名があるため)。diff には `--no-ext-diff --no-textconv --no-color`
- 設定の理由
  - `gc.auto=0` / `maintenance.auto=false`: ホストの git から見ると、コンテナで作った worktree は `prunable` なので、gc が走ると `.git/worktrees/*` が消える
  - `diff.autoRefreshIndex=false`: `GIT_OPTIONAL_LOCKS=0` でも、`git diff` は stat だけが変わったファイルがあると index を書き直すため
  - `core.fsmonitor=false`・`--no-ext-diff`・`--no-textconv`: 差分や status のたびに外部のコマンドを動かさない
- 利用者の入力を引数に入れるときの決まり ([security.md](security.md) §4)
  - ブランチ: ブランチの一覧にある名前だけを受け付け、`refs/heads/…` か `refs/remotes/…` の完全な名前にして渡す
  - コミット: 4〜64 桁の 16 進数だけを受け付け、`git rev-parse --verify --end-of-options <hash>^{commit}` で確かめる
  - パス: `--` の後に `:(literal)<path>` で渡す (ファイル名の `*` を glob として扱わない)
- コミットがないリポジトリでは、`HEAD` の代わりに空のツリー (`git hash-object -t tree --stdin`) と比べる

## 2. Git メニュー

```
▾ 未コミットの差分 (3)                 HEAD...作業ツリー
    ▾ app/src/config
            regions.ts        +9 -1  M
▾ COMPARE (6)                     main...作業ツリー
    ▾ app/ …  (ツリー)
▾ HISTORY (4)                            main..HEAD
    ref #33 設計判断をADRに記録する
    2ff64ad · Claude · 2時間前 · 2 files
```

- 3 つのセクション。境界線のドラッグで縦幅を変えられ、見出しのクリックで折りたためる ([ui.md](ui.md) §5)
- ツリーの行の右側に、追加・削除の行数 (`+9 -1`) と状態 (M / A / U / D / R) を出す。行数は比較元との実際の差分から数える。名前を変えたファイルは、元のパスをツールチップに出す
- ツリーの変更ファイルをクリックすると、Git 用のエディタ領域に差分のタブを開く
  - 比較元が違えば別のタブ。タブ名は `regions.ts (未コミット)`、`regions.ts (main)` のようにする
  - Unified / Split を切り替えられる。Markdown は、左に差分・右に変更後のプレビューを並べられる
  - 変更のない部分は、変更の前後 3 行だけを残して「N 行を表示」にまとめる。クリックで展開する
  - タブの中で「差分」と「ファイル全体」を 1 つのボタンで切り替える (押すたびに入れ替わる。ボタンには切り替え先を表示する)。どちらかはタブごとに保存する
- 読み込み中・エラー・比較対象がない・ブランチが見つからない・共通の祖先がない場合は、セクションに 1 行の文言を出す

## 3. 未コミットの差分 (HEAD...作業ツリー)

- `git diff <HEAD> --raw --numstat -z -M` (Staged と Unstaged をまとめる。`--raw` と `--numstat` は同時に出せる)。`--raw` から状態、`--numstat` から行数を取る。バイナリは行数が `-` なので `binary`
- 状態の対応: `A` → A、`D` → D、`R` → R、`C` → A、`M` / `T` / コンフリクト中 → M
- Untracked も含める (§8)
- Git のアイコンのバッジと、worktree の「変更の数」は、この件数

## 4. COMPARE (マージベースとの比較)

- 比較範囲は `<branch>...` (マージベースから)。`<branch>` の版そのものとは比べない (`<branch>` の側で進んだ変更を差分に混ぜないため)
- マージベース: `git merge-base <ref> HEAD`。なければ「<branch> と共通の祖先がありません」
- 「未コミットの変更を含む」ON: `git diff <mergeBase> --raw --numstat -z -M` (作業ツリーと比べる) + Untracked
- OFF: `git diff <mergeBase> HEAD --raw --numstat -z -M`
- 見出しに比較範囲 (`main...作業ツリー` / `main...HEAD`) を出す。比較対象は worktree バーで選び、このセクションには選択欄を置かない
- エクスプローラの記号と「変更のみ」、ファイル表示の「差分を見る」は、この結果を使う (ブラウザで同じキャッシュを共有するので、git は 1 回だけ実行する)

## 5. ブランチ・ahead / behind・既定の比較対象

- ブランチの一覧: `git for-each-ref --sort=-committerdate --format=%(refname)%00%(refname:short)%00%(committerdate:iso-strict)%00%(symref) refs/heads refs/remotes`。`symref` のあるもの (`origin/HEAD`) は除く
- ahead / behind: `git rev-list --left-right --count <ref>...HEAD` (左が behind、右が ahead)
  - worktree バーの (i) では、タブの比較対象に対する値
  - ホームのカード・worktree の選択・`+` メニューでは、プロジェクトの既定の比較対象に対する値。上流ブランチ (`@{u}`) は使わない (fetch しないうえ、上流のない worktree が多い)
- 既定の比較対象: プロジェクトの設定のブランチ (なくなっていれば自動) → 自動
  - 自動: ローカルの `main` → `master` → `develop`。どれもなければ、リモートの同じ名前 (`refs/remotes/*/main` など)。リモートが複数あれば `origin` を優先し、あとは名前の順。リモートの名前は決め打ちしない (`origin` 以外の名前が多い)
  - どれもなければ null。比較対象を選ぶまで COMPARE などは空になる

## 6. 1 ファイルの差分 (`GET …/diff`)

- `git diff <前> [<後>] -U100000 --no-ext-diff -M -- :(literal)<oldPath> :(literal)<path>` の unified diff をパースして `DiffLine[]` (1 行ずつ。変更のない行も含む) にする。git と同じ差分になるので、ツリーの行数 (`--numstat`) と一致する
  - 出力が 8 MB を超えたら `-U3` で取り直し、`partial` にする (変更の前後だけ。省略した部分は展開できない)
  - `\ No newline at end of file` は捨てる。`Binary files … differ` はバイナリ (画像なら前後の画像)
- 比較元ごとの前と後

  | base | 前 | 後 |
  | --- | --- | --- |
  | `uncommitted` | `HEAD` | 作業ツリー |
  | `branch-wt:<b>` (未コミットを含む) | `merge-base(<b>, HEAD)` | 作業ツリー |
  | `branch:<b>` | `merge-base(<b>, HEAD)` | `HEAD` |
  | `commit:<h>` | `<h>` の最初の親 (最初のコミットなら空のツリー) | `<h>` |

- 差分がないとき (名前の変更だけのときも含む) は、ファイル全体を変更のない行として返す。Untracked のファイルは git diff に出ないので、ファイルを読んですべて追加の行にする
- ファイル表示の「差分を見る」は、比較対象との差分をファイル全体に重ねて表示する (`expandAll`)

## 7. HISTORY とコミットの詳細

- 一覧: `git log --format=<…> --shortstat --diff-merges=first-parent --max-count=500 <ref>..HEAD` (比較対象のブランチにないコミットだけ)
  - `--shortstat` から変更ファイルの数を取る。500 件を超えたら「ほかに N 件のコミットがあります」(N は ahead から数える)
  - マージコミットも並べ、変更ファイルは最初の親との差分
  - 件数の表示は ahead の数
- クリックするとコミットの詳細のタブを開く (タブ名は短いハッシュ)
  - 件名・本文・作者・日時・変更ファイルの数と行数
  - 変更ファイルはアコーディオンで表示し、クリックするとその場で差分を展開する (別のタブは開かない)。「すべて展開」「すべて折りたたむ」、Unified / Split
  - 変更ファイル: `git diff --raw --numstat -z -M <最初の親> <hash>`。差分は `base=commit:<hash>` (§6)

## 8. Untracked の扱い

- 一覧: `git ls-files --others --exclude-standard -z` (`--directory` は付けない。ファイル単位で出す)
- 除外パターンと、worktree の中の別の worktree は除く (除かないと `.worktree/<name>/` の中身がすべて出る)
- 状態は `U`、追加の行数はファイルの行数 (バイナリは 0)、削除は 0。シンボリックリンクはたどらず 1 行と数える (git と同じ)
- 未コミットの差分と、COMPARE (未コミットを含む) に出す。COMPARE (含まない) には出さない
- SPEC の資料 (AI の作業ファイル) は `.gitignore` の対象なので、Untracked にも出ない
