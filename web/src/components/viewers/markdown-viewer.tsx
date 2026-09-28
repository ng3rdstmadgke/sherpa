"use client"

import { useState } from "react"
import ReactMarkdown from "react-markdown"
import { cn } from "cn"
import remarkGfm from "remark-gfm"
import { useHighlight } from "./code-viewer"
import { MermaidDiagram } from "./mermaid-diagram"
import { ZoomDialog } from "./zoom-dialog"

function HighlightedBlock({ code, lang }: { code: string; lang: string }) {
  const html = useHighlight(code, lang)
  if (!html) return <pre>{code}</pre>
  return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />
}

// クリックでモーダルを開き、拡大・縮小する。リンクの中の画像 (バッジなど) はリンクのほうを優先する
function MarkdownImage({ src, alt, name }: { src: string; alt: string; name: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={cn("rounded border", size && "cursor-zoom-in in-[a]:cursor-pointer")}
        onLoad={(e) => {
          const { naturalWidth: width, naturalHeight: height } = e.currentTarget
          setSize(width > 0 && height > 0 ? { width, height } : null)
        }}
        onClick={(e) => {
          if (size && !e.currentTarget.closest("a")) setOpen(true)
        }}
      />
      {size && (
        <ZoomDialog open={open} onOpenChange={setOpen} title={alt || name} {...size}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} draggable={false} className="block size-full" />
        </ZoomDialog>
      )}
    </>
  )
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
            const path = String(src ?? "")
            return <MarkdownImage src={resolveImage(path)} alt={alt ?? ""} name={path.split(/[?#]/)[0].split("/").pop() ?? ""} />
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
