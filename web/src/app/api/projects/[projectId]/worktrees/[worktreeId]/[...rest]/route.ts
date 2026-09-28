import { ApiError, notFound, readJson, route } from "@/server/errors"
import { listChildren, listDir, listSpec, listTree, rawFile, readContent } from "@/server/files"
import { changes, commitDetail, compare, fileDiff, listBranches } from "@/server/git"
import { checkRel } from "@/server/paths"
import { getCtx, setSpecPaths } from "@/server/projects"
import { searchContent, searchNames, type SearchParams } from "@/server/search"
import { restartProject } from "@/server/watch"

// worktree を対象にする API (docs/architecture/api.md §2)。/api/projects/:projectId/worktrees/:worktreeId/<rest>

type Ctx = { params: Promise<{ projectId: string; worktreeId: string; rest: string[] }> }

const flag = (q: URLSearchParams, k: string) => q.get(k) === "1"

function searchParams(q: URLSearchParams): SearchParams {
  return {
    q: q.get("q") ?? "",
    caseSensitive: flag(q, "caseSensitive"),
    regex: flag(q, "regex"),
    include: q.get("include") ?? "",
    exclude: q.get("exclude") ?? "",
    ignored: flag(q, "ignored"),
  }
}

export const GET = route<Ctx>(async (req, { params }) => {
  const { projectId, worktreeId, rest } = await params
  const q = new URL(req.url).searchParams
  const ctx = await getCtx(projectId, worktreeId)
  const action = rest.join("/")
  switch (action) {
    case "tree":
      return listTree(ctx, flag(q, "ignored"))
    case "tree/children":
      return listChildren(ctx, q.get("path") ?? "")
    case "dir":
      return listDir(ctx, q.get("dir") ?? "")
    case "spec":
      return listSpec(ctx, q.get("input") ?? "")
    case "file":
      return readContent(ctx, checkRel(q.get("path")))
    case "raw":
      return rawFile(ctx, q.get("path") ?? "", q.get("rev") || null)
    case "changes":
      return changes(ctx)
    case "branches":
      return listBranches(ctx)
    case "compare": {
      const branch = q.get("branch")
      if (!branch) throw new ApiError("NO_COMPARE_BRANCH", "比較対象のブランチを選んでください")
      return compare(ctx, branch, flag(q, "includeUncommitted"))
    }
    case "diff": {
      const oldPath = q.get("oldPath")
      return fileDiff(ctx, checkRel(q.get("path")), oldPath ? checkRel(oldPath) : null, q.get("base") ?? "uncommitted")
    }
    case "search/content":
      return searchContent(ctx, searchParams(q))
    case "search/files":
      return searchNames(ctx, searchParams(q))
  }
  if (rest[0] === "commits" && rest.length === 2) return commitDetail(ctx, rest[1])
  throw notFound("API が見つかりません")
})

export const PUT = route<Ctx>(async (req, { params }) => {
  const { projectId, worktreeId, rest } = await params
  if (rest.join("/") !== "spec-paths") throw notFound("API が見つかりません")
  const { input } = await readJson<{ input: string }>(req)
  await getCtx(projectId, worktreeId)
  setSpecPaths(projectId, worktreeId, String(input ?? ""))
  // SPEC の場所は無視されていても監視するので、監視を組み直す
  restartProject(projectId)
  return {}
})
