import type { ErrorCode } from "@/lib/types"

// API のエラー。message は画面にそのまま出せる日本語にする
export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export const notFound = (message: string) => new ApiError("NOT_FOUND", message, 404)

type Handler<C> = (req: Request, ctx: C) => Promise<unknown> | unknown

// Route Handler を包み、戻り値を JSON に、ApiError をエラーの応答にする
export function route<C>(handler: Handler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const out = await handler(req, ctx)
      if (out instanceof Response) return out
      return Response.json(out ?? {})
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status })
      console.error(e)
      return Response.json({ error: { code: "INTERNAL", message: `サーバーのエラー: ${(e as Error).message}` } }, { status: 500 })
    }
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new ApiError("INVALID_REQUEST", "JSON が正しくありません")
  }
}
