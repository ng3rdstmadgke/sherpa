import type { DisplaySettings } from "@/lib/display"
import { readJson, route } from "@/server/errors"
import { displaySettings, globalExcludes, setDisplaySettings, setGlobalExcludes } from "@/server/projects"
import { broadcast, restartAll } from "@/server/watch"

// 全体の設定。PUT は送られた項目だけを変える
type Settings = { excludes: string[] } & DisplaySettings

const current = (): Settings => ({ excludes: globalExcludes(), ...displaySettings() })

export const GET = route(() => current())

export const PUT = route(async (req) => {
  const body = await readJson<Partial<Settings>>(req)
  if (body.excludes !== undefined) {
    setGlobalExcludes((body.excludes ?? []).map(String).filter(Boolean))
    // 除外パターンは一覧と監視に効くので、監視を組み直す
    restartAll()
  }
  if (body.codeFontSize !== undefined || body.markdownFontSize !== undefined) {
    setDisplaySettings({ codeFontSize: body.codeFontSize, markdownFontSize: body.markdownFontSize } as Partial<DisplaySettings>)
  }
  broadcast({ type: "projects" })
  return current()
})
