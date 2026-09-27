# CI と依存の管理

[overview.md](overview.md) から分けた、GitHub Actions の CI と、依存の脆弱性・更新の見張り方、道具の版の扱い。設定は `.github/workflows/ci.yml` と `.github/dependabot.yml`。手元でテストを流す手順は `docs/how-to/development/testing.md`。

## 1. CI (`.github/workflows/ci.yml`)

- いつ: `main` への push と、pull request のたび。同じブランチで新しく push したら、前の実行を止める (`concurrency`)
- どこで: `ubuntu-24.04`。Node.js は `web/.nvmrc` の版 (`actions/setup-node` の `node-version-file`)。npm のキャッシュは `web/package-lock.json` をキーにする
- 権限: `contents: read` だけ。20 分で止める
- 手順 (すべて `web/` で実行する)

  | # | コマンド | 内容 |
  | --- | --- | --- |
  | 1 | `npm ci` | lockfile のとおりに入れる。better-sqlite3 は node-gyp でビルドする (ランナーに gcc / make / python3 がある)。rg は `@vscode/ripgrep` に同梱のものが入る |
  | 2 | `npm audit --audit-level=critical` | 依存に critical の脆弱性があれば落とす (§2) |
  | 3 | `npm run lint` | ESLint |
  | 4 | `npx next typegen && npx tsc --noEmit` | まっさらな状態では Next.js の型 (`LayoutProps` など) がないので、先に作ってから型チェックする。`tsc` は TypeScript 7 (§5) |
  | 5 | `npm test` | vitest。結合テストはランナーの git で、一時ディレクトリにリポジトリを作る |
  | 6 | `npm run build` | 本番のビルド |

- 実際のリポジトリに対する確認スクリプト (`web/scripts/check-real-repos.mts`) は、手元にしかないリポジトリを読むので CI では流さない
- 流す手順を変えたら、この表と `docs/how-to/development/testing.md` を直す

## 2. 依存の脆弱性

| 深刻度 | どこで見るか | 扱い |
| --- | --- | --- |
| critical | CI の `npm audit` | CI が落ちる。すぐに直す |
| high 以下 | GitHub の Dependabot alerts (リポジトリの Security タブ) | CI は落とさない。Dependabot の pull request か、手で直す |

- Dependabot alerts はリポジトリの設定で有効にしている
- 直接の依存を上げても直らないときは、`web/package.json` の `overrides` で、依存の中の版を上書きする。今の上書き

  | 上書き | 使っている依存 | 理由 |
  | --- | --- | --- |
  | `lodash-es` → `^4.18.1` | mermaid (chevrotain・dagre-d3-es) | `_.template` のコード注入、`_.unset` / `_.omit` のプロトタイプ汚染 (4.17.23 以下) |
  | `@esbuild-kit/core-utils` の `esbuild` → `^0.25.4` | drizzle-kit (@esbuild-kit/esm-loader) | esbuild の開発サーバーに、ほかのサイトから要求を送って応答を読める (0.24.2 以下) |

  - 上書きしたら、その依存を使う機能 (mermaid の図、`drizzle-kit generate`) が動くことを確かめる
  - 上の依存が直した版を出したら、上書きを外す
- `npm audit fix --force` は、直接の依存のメジャー版を下げる案を出すことがある (mermaid を 11 に、drizzle-kit を 0.18 に、など)。そのまま実行しない

## 3. 依存の更新 (`.github/dependabot.yml`)

| 対象 | ディレクトリ | 頻度 | まとめ方 |
| --- | --- | --- | --- |
| npm | `/web` | 週に 1 回 | minor / patch を 1 つの pull request にまとめる。メジャー版は 1 つずつ。開く pull request は 10 まで |
| GitHub Actions | `/` | 週に 1 回 | すべてを 1 つの pull request にまとめる |

- `@types/node` のメジャー版の更新は作らせない (`ignore`)。Node.js の版 (`web/.nvmrc`) を上げるときに、同じメジャー版に手で上げる。Node.js は LTS の版を使う
- pull request にも CI が流れる。通ったものを取り込む
- メジャー版の更新は、変更点を読んで、画面でも確かめてから取り込む (ESLint 10 のように、依存のプラグインが追いついていないことがある)

## 4. ESLint 10 の互換

- `eslint-config-next` の中の eslint-plugin-react / import / jsx-a11y は ESLint 10 に対応していない (ESLint 10 で消えた `context.getFilename()` などを使う)
- `web/eslint.config.mjs` で、Next.js の設定を `@eslint/compat` の `fixupConfigRules` で包み、消えた API を補って動かしている
- `npm install` / `npm ci` の「ERESOLVE overriding peer dependency」の警告はこのため。プラグインが ESLint 10 に対応したら外せる

## 5. TypeScript 6 と 7 の並用

TypeScript 7.0 にはプログラムから使う API がない (7.1 で入る予定)。TypeScript を中から呼ぶ道具 (typescript-eslint、`next build` の型チェック) は 7 では動かないので、公式の方法で 6 と 7 を並べて入れている (`web/package.json`)。

| 名前 | 中身 | 使うもの |
| --- | --- | --- |
| `typescript` | `npm:@typescript/typescript6` (TypeScript 6) | typescript-eslint、`next build` / `next typegen`、エディタのプラグインなど API を使うもの。コマンドは `tsc6` |
| `@typescript/native` | `npm:typescript@7` (TypeScript 7) | コマンドの `tsc` (CI と手元の型チェック) |

- 型チェックは `tsc` (7) で行う。6 より速い (手元で 2 秒ほど。6 は 7 秒ほど)
- TypeScript 7 では `baseUrl`、`moduleResolution: node`、`target: es5` などが使えない。`web/tsconfig.json` にこれらを足さない
- typescript-eslint と Next.js が TypeScript 7 の API に対応したら、`typescript` を 7 にして 1 つにまとめられる
