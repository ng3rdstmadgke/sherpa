import type { ProjectInput } from "@/lib/types"
import { readJson, route } from "@/server/errors"
import { buildProject, createProject, globalExcludes, listProjects, specPathsOf } from "@/server/projects"
import { broadcast } from "@/server/watch"

export const GET = route(() => listProjects())

export const POST = route(async (req) => {
  const row = await createProject(await readJson<ProjectInput>(req))
  broadcast({ type: "projects" })
  return buildProject(row, globalExcludes(), specPathsOf(row.id))
})
