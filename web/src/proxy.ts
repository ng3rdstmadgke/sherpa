import os from "node:os"
import { NextResponse, type NextRequest } from "next/server"
import { checkRequest, machineHosts, parseAllowedHosts } from "@/lib/request-guard"

// ローカルのほかに許すホスト名 (docs/architecture/security.md §2): このマシンの IP アドレスとホスト名と、SHERPA_ALLOWED_HOSTS。
// IP アドレスは DHCP などで変わるので、10 秒ごとに読み直す
const EXTRA_HOSTS = parseAllowedHosts(process.env.SHERPA_ALLOWED_HOSTS)
let cached: { at: number; hosts: string[] } | null = null
function allowedHosts() {
  if (!cached || Date.now() - cached.at > 10_000) {
    const addresses = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address))
    cached = { at: Date.now(), hosts: [...machineHosts(addresses, os.hostname()), ...EXTRA_HOSTS] }
  }
  return cached.hosts
}

// すべての要求で Host を確かめ、書き込みでは Origin と Content-Type も確かめる (docs/architecture/security.md §2)
export function proxy(request: NextRequest) {
  const denied = checkRequest(request.method, request.headers, request.nextUrl.pathname, allowedHosts())
  if (denied) return NextResponse.json({ error: { code: "FORBIDDEN", message: denied.message } }, { status: denied.status })
  return NextResponse.next()
}
