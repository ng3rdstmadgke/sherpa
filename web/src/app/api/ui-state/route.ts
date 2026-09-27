import { readJson, route } from "@/server/errors"
import { applyUiState, getUiState } from "@/server/ui-state"

type Body = { set?: Record<string, unknown>; deletePrefixes?: string[] }

export const GET = route(() => getUiState())

export const PUT = route(async (req) => {
  applyUiState(await readJson<Body>(req))
  return {}
})

// ページを閉じるときの navigator.sendBeacon (POST しか送れない)
export const POST = PUT
