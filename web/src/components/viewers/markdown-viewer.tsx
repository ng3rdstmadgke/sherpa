"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useHighlight } from "./code-viewer"
import { MermaidDiagram } from "./mermaid-diagram"

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
            if (lang === "mermaid") return <MermaidDiagram code={code} />
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
