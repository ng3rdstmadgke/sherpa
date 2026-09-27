import type { WatchEvent } from "@/lib/types"
import { isShuttingDown, subscribe, watchErrors } from "@/server/watch"

// 自動更新の通知 (SSE)。?watch=<projectId>/<worktreeId>,… の worktree を監視する
export function GET(req: Request) {
  // 止めている途中は、接続ごと閉じる。ブラウザの EventSource は同じ keep-alive の接続でつなぎ直してくるので、
  // ストリームを閉じるだけだと接続が空かず、next start の終了処理が終わらない。200 以外を返すと EventSource はつなぎ直さない
  if (isShuttingDown()) return new Response(null, { status: 503, headers: { Connection: "close" } })
  const keys = (new URL(req.url).searchParams.get("watch") ?? "").split(",").filter((k) => k.includes("/"))
  const enc = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: WatchEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
        } catch {
          cleanup()
        }
      }
      // サーバーを止めるときに呼ばれる。ストリームを閉じて、接続を終わらせる
      const close = () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // すでに閉じている
        }
      }
      const unsubscribe = subscribe(keys, send, close)
      controller.enqueue(enc.encode(": connected\n\n"))
      setTimeout(() => {
        for (const w of watchErrors(keys)) send({ type: "watch-error", projectId: w.projectId, worktreeId: w.worktreeId, message: w.error ?? "" })
      }, 1000)
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"))
        } catch {
          cleanup()
        }
      }, 25_000)
      cleanup = () => {
        clearInterval(ping)
        unsubscribe()
        cleanup = () => {}
      }
      req.signal.addEventListener("abort", () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  })
}
