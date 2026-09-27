import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// 結合テスト用の git リポジトリを一時ディレクトリに作る (docs/agent-tasks/init/implementation-plan.md §10.2)。
// コンテナで作った worktree (.git が偽のコンテナ内のパスを指す) を再現する

export type Fixture = {
  root: string // SHERPA_HOME にする
  proj: string // main worktree
  fake: string // 偽のコンテナ内の root (/workspaces/proj の代わり)
  wt1: string // feature/x の worktree (コンテナ内のパスを記録している)
  wt2: string // 管理用のディレクトリの名前 (wt2admin) とディレクトリ名 (wt2-dir) が違う worktree
  det: string // ブランチにない HEAD の worktree
  masterOnly: string
  trunkOnly: string
  remoteOnly: string // ローカルに main がなく、upstream/main だけがある
  noCommit: string
  plain: string // git リポジトリでないディレクトリ
  commits: { feat1: string; side1: string; merge: string; mainC2: string; base: string }
  cleanup: () => void
}

// 利用者の git の設定を読まないようにする
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Tester",
  GIT_AUTHOR_EMAIL: "tester@example.com",
  GIT_COMMITTER_NAME: "Tester",
  GIT_COMMITTER_EMAIL: "tester@example.com",
  GIT_TERMINAL_PROMPT: "0",
}
delete env.GIT_DIR
delete env.GIT_WORK_TREE

let clock = Date.parse("2026-09-01T00:00:00Z") / 1000

export function git(cwd: string, ...args: string[]) {
  // コミットの日時を 1 分ずつ進め、log の順を決まったものにする
  clock += 60
  const date = `${clock} +0900`
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function write(file: string, content: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// 1x1 の PNG
const png = (color: number) =>
  Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"),
    Buffer.from([0, 0, 0, 13, color, 0, 0, 0, 0, 0, 0]),
  ])

function simpleRepo(dir: string, branch: string, commit = true) {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  write(path.join(dir, "a.txt"), "a\n")
  if (commit) {
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  }
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-test-"))
  const proj = path.join(root, "proj")
  const fake = path.join(root, "fake-workspaces", "proj")
  mkdirSync(proj, { recursive: true })
  git(proj, "init", "-q", "-b", "main")

  // --- main の最初のコミット
  write(path.join(proj, "README.md"), "# proj\n\nline 2\n")
  write(path.join(proj, "src/a.ts"), "export const Hello = 1\nconst helloWorld = 2\nhello\n")
  write(path.join(proj, "src/old.txt"), "old\n")
  write(path.join(proj, "docs/rename-me.md"), "# rename\n\nsame content\n")
  write(path.join(proj, "docs/メモ v2.md"), "日本語のテスト test\n")
  write(path.join(proj, "img.png"), png(1))
  write(path.join(proj, ".gitignore"), "node_modules/\ntmp/\nagent-tasks/\n**/.terraform/*\n**/.cache/*\n.worktree/\n")
  write(
    path.join(proj, ".devcontainer/devcontainer.json"),
    `// devcontainer の設定 (コメント付き)\n{\n  "name": "proj", // 名前\n  "workspaceFolder": "${fake}",\n}\n`,
  )
  git(proj, "add", "-A")
  git(proj, "commit", "-q", "-m", "init")
  const base = git(proj, "rev-parse", "HEAD")

  // develop
  git(proj, "branch", "develop")
  git(proj, "checkout", "-q", "develop")
  write(path.join(proj, "dev.txt"), "dev\n")
  git(proj, "add", "-A")
  git(proj, "commit", "-q", "-m", "develop only")

  // feature/x: main から 3 コミット先行 (feat1、side1、マージ)
  git(proj, "checkout", "-q", "-b", "feature/x", base)
  write(path.join(proj, "src/feature.ts"), "export const feature = true\nexport const n = 2\n")
  git(proj, "add", "-A")
  git(proj, "commit", "-q", "-m", "feat: feature.ts を追加", "-m", "本文の行")
  const feat1 = git(proj, "rev-parse", "HEAD")
  git(proj, "checkout", "-q", "-b", "side", base)
  write(path.join(proj, "side.txt"), "side\n")
  git(proj, "add", "-A")
  git(proj, "commit", "-q", "-m", "side: side.txt")
  const side1 = git(proj, "rev-parse", "HEAD")
  git(proj, "checkout", "-q", "feature/x")
  git(proj, "merge", "-q", "--no-ff", "-m", "Merge side", "side")
  const merge = git(proj, "rev-parse", "HEAD")

  // main は 1 コミット進む (feature/x は 1 コミット遅れ)
  git(proj, "checkout", "-q", "main")
  write(path.join(proj, "README.md"), "# proj\n\nline 2\nline 3\n")
  git(proj, "add", "-A")
  git(proj, "commit", "-q", "-m", "main: README")
  const mainC2 = git(proj, "rev-parse", "HEAD")

  // 共通の祖先のないブランチ
  const empty = git(proj, "hash-object", "-t", "tree", "-w", "--stdin")
  const orphan = git(proj, "commit-tree", empty, "-m", "orphan")
  git(proj, "branch", "orphan", orphan)

  // リモート upstream (<remote>/HEAD はない)。fetch はこの一時ディレクトリの中だけ
  const bare = path.join(root, "remote.git")
  git(root, "clone", "-q", "--bare", proj, bare)
  git(proj, "remote", "add", "upstream", bare)
  git(proj, "fetch", "-q", "upstream")

  // --- worktree
  git(proj, "worktree", "add", "-q", ".worktree/wt1", "feature/x")
  const wt1 = path.join(proj, ".worktree/wt1")
  write(path.join(wt1, "wt1-new.txt"), "new in wt1\n")
  git(proj, "worktree", "add", "-q", "-b", "feature/y", ".worktree/wt2-dir", "main")
  const wt2 = path.join(proj, ".worktree/wt2-dir")
  git(proj, "worktree", "add", "-q", "--detach", ".worktree/det", "main")
  const det = path.join(proj, ".worktree/det")
  git(proj, "worktree", "add", "-q", "-b", "feature/gone", ".worktree/gone", "main")
  rmSync(path.join(proj, ".worktree/gone"), { recursive: true, force: true })

  // wt1 をコンテナで作った状態にする (.git と gitdir が偽のコンテナ内のパスを指す)。そのパスには空のディレクトリを置く
  write(path.join(wt1, ".git"), `gitdir: ${fake}/.git/worktrees/wt1\n`)
  write(path.join(proj, ".git/worktrees/wt1/gitdir"), `${fake}/.worktree/wt1/.git\n`)
  mkdirSync(path.join(fake, ".worktree/wt1"), { recursive: true })

  // wt2: 管理用のディレクトリの名前をディレクトリ名と変える
  renameSync(path.join(proj, ".git/worktrees/wt2-dir"), path.join(proj, ".git/worktrees/wt2admin"))
  write(path.join(wt2, ".git"), `gitdir: ${proj}/.git/worktrees/wt2admin\n`)

  // --- main worktree の未コミットの変更
  write(path.join(proj, "src/a.ts"), "export const Hello = 1\nconst helloWorld = 2\nhello\nexport const staged = 3\n")
  git(proj, "add", "src/a.ts") // Staged
  write(path.join(proj, "README.md"), "# proj changed\n\nline 2\nline 3\n") // Unstaged
  git(proj, "mv", "docs/rename-me.md", "docs/renamed.md") // 名前の変更
  git(proj, "rm", "-q", "src/old.txt") // 削除
  write(path.join(proj, "img.png"), png(2)) // 画像の変更
  write(path.join(proj, "notes.txt"), "note 1\nnote 2\n") // Untracked
  write(path.join(proj, "メモ 1.md"), "# メモ\n")
  write(path.join(proj, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]))
  symlinkSync("/etc/hostname", path.join(proj, "link-out"))
  symlinkSync("README.md", path.join(proj, "link-in"))

  // --- .gitignore の対象
  write(path.join(proj, "node_modules/pkg/index.js"), "ignored-marker in node_modules\n")
  write(path.join(proj, "node_modules/pkg/README.md"), "# pkg\n")
  write(path.join(proj, "app/node_modules/x.js"), "x\n")
  write(path.join(proj, "tmp/memo.md"), "ignored-marker in tmp\n")
  write(path.join(proj, "agent-tasks/feature/x/spec.md"), "# spec\n")
  write(path.join(proj, "agent-tasks/feature/x/plan.md"), "# plan\n")
  write(path.join(proj, "agent-tasks/feature/x/log.txt"), "not md\n")
  write(path.join(proj, "infra/.terraform/modules/m.json"), "{}\n")
  write(path.join(proj, "build/.cache/a/b.txt"), "b\n")
  write(path.join(proj, "build/.cache/c.txt"), "c\n")
  write(path.join(proj, "build/keep.txt"), "keep\n")
  git(proj, "add", "build/keep.txt")
  // 無視されたディレクトリの中の別の git リポジトリ
  simpleRepo(path.join(proj, "tmp/other"), "main")

  // --- ほかのリポジトリ
  const masterOnly = path.join(root, "master-only")
  simpleRepo(masterOnly, "master")
  const trunkOnly = path.join(root, "trunk-only")
  simpleRepo(trunkOnly, "trunk")
  const noCommit = path.join(root, "no-commit")
  simpleRepo(noCommit, "main", false)
  const remoteOnly = path.join(root, "remote-only")
  simpleRepo(remoteOnly, "work")
  git(remoteOnly, "remote", "add", "upstream", bare)
  git(remoteOnly, "fetch", "-q", "upstream")
  const plain = path.join(root, "plain")
  mkdirSync(plain)

  return {
    root,
    proj,
    fake,
    wt1,
    wt2,
    det,
    masterOnly,
    trunkOnly,
    remoteOnly,
    noCommit,
    plain,
    commits: { feat1, side1, merge, mainC2, base },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// 読み取りだけで済ませているかを確かめるため、index の mtime を読む
export function gitEnvFor(gitDir: string, workTree: string): NodeJS.ProcessEnv {
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: gitDir, GIT_WORK_TREE: workTree }
}

export function gitWith(e: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}
