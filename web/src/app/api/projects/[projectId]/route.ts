import type { ProjectInput } from "@/lib/types"
import { readJson, route } from "@/server/errors"
import { buildProject, deleteProject, globalExcludes, specPathsOf, updateProject } from "@/server/projects"
import { broadcast, restartProject } from "@/server/watch"

type Ctx = { params: Promise<{ projectId: string }> }

export const PATCH = route<Ctx>(async (req, { params }) => {
  const { projectId } = await params
  const row = updateProject(projectId, await readJson<ProjectInput>(req))
  restartProject(projectId)
  broadcast({ type: "projects" })
  return buildProject(row, globalExcludes(), specPathsOf(row.id))
})

// 登録の解除。sherpa の DB の行だけを消す (リポジトリのファイルには触れない)
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { projectId } = await params
  deleteProject(projectId)
  restartProject(projectId)
  broadcast({ type: "projects" })
  return {}
})
