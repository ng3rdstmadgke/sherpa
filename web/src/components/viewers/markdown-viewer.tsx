"use client"

import { useMemo, useState } from "react"
import ReactMarkdown, { type Options } from "react-markdown"
import { cn } from "cn"
import remarkGfm from "remark-gfm"
import { buildMarkdownDiff, diffSides, type MdDiffSide, type MdNode } from "@/lib/diff"
import { createSlugger } from "@/lib/slug"
import type { DiffLine } from "@/lib/types"
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

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const textOf = (n: HastNode): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""))

// 見出しに、リンク先の名前 (GitHub と同じ作り方) を data-heading-id で付ける。
// id にしないのは、画面のほかの要素の id とぶつからないようにするため (同じファイルを 2 つのグループで開くこともある)
function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = createSlugger()
    const walk = (n: HastNode) => {
      if (n.type === "element" && /^h[1-6]$/.test(n.tagName ?? "")) n.properties = { ...n.properties, dataHeadingId: slug(textOf(n)) }
      n.children?.forEach(walk)
    }
    walk(tree)
  }
}

// `#見出し` のリンク。同じプレビューの中の見出し (なければ同じ id の要素。脚注など) へスクロールする
function scrollToAnchor(from: HTMLElement, hash: string) {
  const root = from.closest(".markdown-body")
  if (!root) return
  let name = hash
  try {
    name = decodeURIComponent(hash)
  } catch {
    // 正しくない % の並びは、そのまま使う
  }
  if (!name) return root.scrollIntoView({ block: "start" })
  const q = (sel: string) => root.querySelector<HTMLElement>(sel)
  const target =
    q(`[data-heading-id="${CSS.escape(name)}"]`) ?? q(`[data-heading-id="${CSS.escape(name.toLowerCase())}"]`) ?? q(`[id="${CSS.escape(name)}"]`)
  target?.scrollIntoView({ block: "start" })
}

type ViewerProps = {
  onOpenLink?: (href: string) => void
  resolveImage?: (src: string) => string
}

// 画像の相対パスは、呼び出し元 (resolveImage) がサーバーの raw の URL にする。http(s) はそのまま
export function MarkdownViewer({
  content,
  onOpenLink,
  resolveImage = (src) => src,
  remarkPlugins = [],
}: ViewerProps & { content: string; remarkPlugins?: Options["remarkPlugins"] }) {
  return (
    <article className="markdown-body px-8 py-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
        rehypePlugins={[rehypeHeadingIds]}
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
            // `#見出し` だけのリンクは、別のタブで開かずに、同じファイルの中をスクロールする
            if (href?.startsWith("#"))
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    scrollToAnchor(e.currentTarget, href.slice(1))
                  }}
                >
                  {children}
                </a>
              )
            const isRelative = href && !/^(https?:|mailto:)/.test(href)
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

// 変更後の木を、変更前と突き合わせて印を付けた木に置き換える。変更前も同じ設定 (GFM) で読むため、this.parse を使う
function remarkDiff(this: { parse: (text: string) => unknown }, opts: { lines: DiffLine[]; before: string[]; after: string[]; side: MdDiffSide }) {
  return (tree: unknown) =>
    buildMarkdownDiff(this.parse(opts.before.join("\n")) as MdNode, tree as MdNode, opts.lines, opts.before, opts.after, opts.side)
}

// Markdown のプレビューの差分。lines はファイル全体の差分 (partial でないもの)。追加は緑、削除は赤の取り消し線で示す。
// side: both は 1 つに重ねる (Unified)。before / after は Split の左 (変更前と削除) / 右 (変更後と追加)
export function MarkdownDiffViewer({ lines, side = "both", ...props }: ViewerProps & { lines: DiffLine[]; side?: MdDiffSide }) {
  const { before, after } = useMemo(() => diffSides(lines), [lines])
  const plugins = useMemo(() => [[remarkDiff, { lines, before, after, side }]] as Options["remarkPlugins"], [lines, before, after, side])
  return <MarkdownViewer content={after.join("\n")} remarkPlugins={plugins} {...props} />
}
