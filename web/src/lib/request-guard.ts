// Host / Origin の確認 (DNS rebinding と、ほかのサイトからの要求を防ぐ)。proxy.ts から使う純粋な関数

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

// "localhost:4800" や "[::1]:4747" からホスト名を取り出す。ポートは見ない (SSH のポートフォワードで別のポートから開くため)
export function hostname(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1)
  return h.split(":")[0]
}

export function isLocalHost(host: string | null) {
  return !!host && LOCAL_HOSTS.has(hostname(host))
}

// HTML のプレビュー (…/preview/<合言葉>/<path>) の GET / HEAD か。プレビューは sandbox の iframe で sherpa と別の origin として
// 動くので、その中の CSS・画像・スクリプトの読み込みやリンクの移動は Sec-Fetch-Site が cross-site になる (Referer も付かない)。
// これだけは cross-site でも通し、URL の合言葉を Route Handler で確かめる (server/preview.ts。ほかのサイトは合言葉を知らない)
const PREVIEW_PATH = /^\/api\/projects\/[^/]+\/worktrees\/[^/]+\/preview\/[^/]+\/./
export function isPreviewRequest(method: string, pathname: string) {
  const m = method.toUpperCase()
  return (m === "GET" || m === "HEAD") && PREVIEW_PATH.test(pathname)
}

// 断るときは { status, message } を返す。通すときは null。pathname は要求のパス (プレビューの例外を見るのに使う)
export function checkRequest(method: string, headers: { get(name: string): string | null }, pathname = ""): { status: number; message: string } | null {
  if (!isLocalHost(headers.get("host"))) return { status: 421, message: "Host が 127.0.0.1 / localhost ではありません" }
  if (headers.get("sec-fetch-site") === "cross-site" && !isPreviewRequest(method, pathname))
    return { status: 403, message: "ほかのサイトからの要求は受け付けません" }
  const m = method.toUpperCase()
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const origin = headers.get("origin")
    if (origin) {
      let originHost = ""
      try {
        originHost = new URL(origin).host
      } catch {
        return { status: 403, message: "Origin が正しくありません" }
      }
      if (!isLocalHost(originHost)) return { status: 403, message: "ほかのサイトからの要求は受け付けません" }
    }
    const type = headers.get("content-type") ?? ""
    if (!type.toLowerCase().startsWith("application/json")) return { status: 415, message: "Content-Type は application/json にしてください" }
  }
  return null
}
