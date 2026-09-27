import { route } from "@/server/errors"
import { detect } from "@/server/projects"

export const GET = route((req) => detect(new URL(req.url).searchParams.get("path") ?? "~/"))
