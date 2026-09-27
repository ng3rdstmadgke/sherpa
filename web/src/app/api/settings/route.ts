import { readJson, route } from "@/server/errors"
import { globalExcludes, setGlobalExcludes } from "@/server/projects"
import { broadcast, restartAll } from "@/server/watch"

export const GET = route(() => ({ excludes: globalExcludes() }))

export const PUT = route(async (req) => {
  const { excludes } = await readJson<{ excludes: string[] }>(req)
  setGlobalExcludes((excludes ?? []).map(String).filter(Boolean))
  restartAll()
  broadcast({ type: "projects" })
  return { excludes: globalExcludes() }
})
