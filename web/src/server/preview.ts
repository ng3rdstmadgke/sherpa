import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { ApiError } from "./errors"

// HTML のプレビューの URL に入れる合言葉 (docs/architecture/security.md §6)。
// プレビューの中からの読み込みは Sec-Fetch-Site が cross-site になり、Referer も送られないので、ほかのサイトからの要求と
// 見分けるのに使う。サーバーを起動するたびに作る秘密の値から、worktree ごとに作る (別の worktree のファイルは読めない)。
// 開発中の再読み込み (HMR) で変わらないよう globalThis に置く

const g = globalThis as unknown as { __sherpaPreviewSecret?: Buffer }
const secret = () => (g.__sherpaPreviewSecret ??= randomBytes(32))

export function previewToken(projectId: string, worktreeId: string) {
  return createHmac("sha256", secret()).update(`${projectId}\0${worktreeId}`).digest("base64url").slice(0, 32)
}

export function checkPreviewToken(projectId: string, worktreeId: string, token: string) {
  const want = Buffer.from(previewToken(projectId, worktreeId))
  const got = Buffer.from(token)
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ApiError("FORBIDDEN", "プレビューの URL が正しくありません (開き直してください)", 403)
}
