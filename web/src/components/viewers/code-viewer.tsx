"use client"

import { useEffect, useRef, useState } from "react"

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  json: "json",
  md: "markdown",
  tf: "hcl",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
}

export function langFromPath(path: string): string {
  const name = path.split("/").pop() ?? ""
  if (name === "Dockerfile") return "docker"
  if (name === "Makefile") return "make"
  return EXT_LANG[name.split(".").pop() ?? ""] ?? "text"
}

export function useHighlight(code: string, lang: string) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // 本実装ではサーバー側でハイライトして HTML を返す想定
    import("shiki").then(({ codeToHtml }) =>
      codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      })
        .catch(() => codeToHtml(code, { lang: "text", themes: { light: "github-light", dark: "github-dark" }, defaultColor: false }))
        .then((h) => !cancelled && setHtml(h)),
    )
    return () => {
      cancelled = true
    }
  }, [code, lang])
  return html
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

// ハイライトしないときも、shiki と同じ形 (code > .line) にして、行番号と行の強調を効かせる
function plainHtml(code: string) {
  const lines = code.replace(/\n$/, "").split("\n")
  return `<pre class="shiki"><code>${lines.map((l) => `<span class="line">${escapeHtml(l)}</span>`).join("\n")}</code></pre>`
}

// plain: 大きなファイルなど、シンタックスハイライトしない (重いため)
export function CodeViewer({ path, code, highlightLine, plain }: { path: string; code: string; highlightLine?: number; plain?: boolean }) {
  const highlighted = useHighlight(plain ? "" : code, plain ? "text" : langFromPath(path))
  const html = plain ? plainHtml(code) : highlighted
  const ref = useRef<HTMLDivElement>(null)

  // 検索結果から開いたときは該当行へスクロールして強調する
  useEffect(() => {
    const root = ref.current
    if (!root || !html) return
    root.querySelectorAll(".line.highlighted").forEach((el) => el.classList.remove("highlighted"))
    if (!highlightLine) return
    const line = root.querySelectorAll("code > .line")[highlightLine - 1]
    line?.classList.add("highlighted")
    line?.scrollIntoView({ block: "center" })
  }, [html, highlightLine])

  if (!html) {
    return <pre className="code-view sherpa-code-text p-4 font-mono text-muted-foreground">{code}</pre>
  }
  return <div ref={ref} className="code-view with-line-numbers" dangerouslySetInnerHTML={{ __html: html }} />
}
