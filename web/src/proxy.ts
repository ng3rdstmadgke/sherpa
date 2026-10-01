import { NextResponse, type NextRequest } from "next/server"
import { checkRequest, parseAllowedHosts } from "@/lib/request-guard"

// ローカルのほかに許すホスト名 (IP アドレスやホスト名で開くとき。docs/architecture/security.md §2)
const ALLOWED_HOSTS = parseAllowedHosts(process.env.SHERPA_ALLOWED_HOSTS)

// すべての要求で Host を確かめ、書き込みでは Origin と Content-Type も確かめる (docs/architecture/security.md §2)
export function proxy(request: NextRequest) {
  const denied = checkRequest(request.method, request.headers, request.nextUrl.pathname, ALLOWED_HOSTS)
  if (denied) return NextResponse.json({ error: { code: "FORBIDDEN", message: denied.message } }, { status: denied.status })
  return NextResponse.next()
}
