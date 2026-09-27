"use client"

import { useEffect, useId, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useHighlight } from "./code-viewer"
import { useIsDark } from "@/lib/theme"

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/:/g, "")
  const [svg, setSvg] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const dark = useIsDark()

  // テーマを切り替えたら、そのテーマで描き直す
  useEffect(() => {
    let cancelled = false
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" })
      try {
        const { svg } = await mermaid.render(`m${id}`, code)
        if (!cancelled) setSvg(svg)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })
    return () => {
      cancelled = true
    }
  }, [code, id, dark])

  if (error) return <pre className="text-destructive text-xs">{error}</pre>
  return <div className="my-4 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
}

function HighlightedBlock({ code, lang }: { code: string; lang: string }) {
  const html = useHighlight(code, lang)
  if (!html) return <pre>{code}</pre>
  return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />
}

// 画像の相対パスは、呼び出し元 (resolveImage) がサーバーの raw の URL にする。http(s) はそのまま
export function MarkdownViewer({
  content,
  onOpenLink,
  resolveImage = (src) => src,
}: {
  content: string
  onOpenLink?: (href: string) => void
  resolveImage?: (src: string) => string
}) {
  return (
    <article className="markdown-body px-8 py-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1]
            const code = String(children).replace(/\n$/, "")
            if (lang === "mermaid") return <Mermaid code={code} />
            if (lang) return <HighlightedBlock code={code} lang={lang} />
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          pre({ children }) {
            return <>{children}</>
          },
          img({ src, alt }) {
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={resolveImage(String(src ?? ""))} alt={alt ?? ""} className="rounded border" />
          },
          a({ href, children }) {
            const isRelative = href && !/^(https?:|#|mailto:)/.test(href)
            return (
              <a
                href={href}
                onClick={(e) => {
                  if (isRelative && onOpenLink) {
                    e.preventDefault()
                    onOpenLink(href!)
                  }
                }}
                target={isRelative ? undefined : "_blank"}
                rel="noreferrer"
              >
                {children}
              </a>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}
