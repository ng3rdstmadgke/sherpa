# 自動更新

[overview.md](overview.md) から分けた、ファイルの監視と画面の読み直し。実装は `web/src/server/watch.ts` (監視)、`web/src/app/api/events/route.ts` (SSE)、`web/src/lib/events.ts` (ブラウザ)。

## 1. 振る舞い

- worktree のファイルと git の状態を監視し、変更があれば、開いているタブ・差分・ツリー・件数を自動で読み直す
- 開いているタブ (ファイル・差分) を読み直したときだけ、画面の右下に「`spec.md` が更新されたため再読み込みしました」と 4 秒出す。ツリーや件数だけが変わったときは出さない
- worktree バーの右端に手動の再読み込みボタンを置く。押すと、その worktree のデータをすべて読み直す
- ボタンの点で状態を示す
  - 緑: サーバーとつながっていて、その worktree を監視している
  - 灰色: サーバーとの接続 (SSE) が切れている、または監視できない (inotify の上限など)。ツールチップに理由を出す

## 2. 監視 (chokidar)

- 監視するのは、ブラウザで開いているタブの worktree だけ。購読がなくなって 30 秒たったら止める
- 作業ツリー: worktree の直下を監視する (`followSymlinks: false`)。次は監視から外す
  - 除外パターン、worktree の中の別の worktree、`.git`
  - `.gitignore` で無視されたディレクトリ (`git ls-files --others --ignored --directory` の結果)。ただし SPEC の場所 (その親と中) は監視する (AI の作業ファイルは無視されていることが多い)
  - 無視されたディレクトリを外すのは、`tmp/` や `.pnpm-store`、`.worktree/` のような大きなディレクトリを監視すると、inotify の数と起動の時間が無駄になるため
- git: `<GIT_DIR>/HEAD`・`<GIT_DIR>/index`・共通の `.git/refs/`・`.git/packed-refs`、worktree の追加・削除のために `.git/worktrees/` (直下だけ)
- 変更は 300 ms まとめてから、worktree ごとに通知にする
- SPEC 欄の保存、プロジェクトの設定・全体の設定の変更のときは、監視を組み直す
- inotify の上限 (`ENOSPC`) などで監視できなければ、`watch-error` を送る
- 監視と購読者は、開発中の再読み込み (HMR) で二重にならないよう `globalThis` に置く

## 3. SSE (`GET /api/events?watch=<projectId>/<worktreeId>,…`)

- ブラウザは `EventSource` を 1 つだけ張る (HTTP/1.1 では同じサーバーへの接続が 6 本までなので、worktree ごとに張らない)。開いているタブの worktree が変わったら張り直す
- 25 秒ごとにコメント行 (`: ping`) を送る。切断は `request.signal` とストリームの `cancel` で知り、購読をやめる
- 送るもの (`WatchEvent`)

  | type | 中身 | いつ |
  | --- | --- | --- |
  | `files` | projectId・worktreeId・変わったパス・`structure` (追加・削除・`.gitignore` の変更を含む) | 作業ツリーの変更 |
  | `git` | projectId・worktreeId | HEAD / index / refs の変化 |
  | `worktrees` | projectId | worktree の追加・削除 |
  | `projects` | なし | 登録・編集・登録の解除、全体の設定の変更 |
  | `watch-error` | projectId・worktreeId・文言 | 監視できない |

## 4. ブラウザで何を読み直すか

キャッシュのキーは `["wt", projectId, worktreeId, …]` ([api.md](api.md) §5)。

| 通知 | 無効にするキャッシュ |
| --- | --- |
| `files` / `git` | その worktree のすべて (内容・差分・ツリー・SPEC・検索・COMPARE など) と、プロジェクトの一覧 |
| `worktrees` | プロジェクトの一覧と全体の設定 |
| `projects` | 上に加えて、すべての worktree |
| `watch-error` | なし (点を灰色にする) |

- 無効にしたキャッシュのうち、表示中のものだけを取り直す
- SSE がつながり直したら、切れている間の変更を取りこぼさないよう、すべて読み直す

## 5. 制約

- 無視されたディレクトリの中で、SPEC の場所の外にあるファイルは監視しない。そのようなファイルを開いているときは、手動の再読み込みが要る
- サーバーではキャッシュしない (git の実行は 10〜20 ms、一覧も 1 秒以内で済むため)。キャッシュはブラウザの TanStack Query だけ
