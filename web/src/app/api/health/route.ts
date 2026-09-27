import { route } from "@/server/errors"
import { tools } from "@/server/exec"
import { home } from "@/server/paths"

export const GET = route(async () => ({ ...(await tools()), home: home() }))
