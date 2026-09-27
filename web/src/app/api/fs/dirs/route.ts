import { route } from "@/server/errors"
import { listHomeDirs } from "@/server/projects"

// ディレクトリのサジェスト。ホームの下のディレクトリの名前だけを返す
export const GET = route((req) => listHomeDirs(new URL(req.url).searchParams.get("dir") ?? ""))
