import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { TooltipProvider } from "@/components/ui/tooltip"
import { connection } from "next/server"
import { getTheme } from "@/server/ui-state"
import { displaySettings } from "@/server/projects"
import { DISPLAY_DEFAULTS, displayCssVars } from "@/lib/display"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "sherpa",
  description: "複数プロジェクトを横断するローカルのコード / ドキュメントビューア",
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // 保存済みのテーマをサーバーで <html> に付ける (読み込み直後にライトで一瞬表示されないように)
  await connection()
  const dark = getTheme() === "dark"
  // フォントサイズ (全体の設定) も同じく最初から効かせる
  let display = DISPLAY_DEFAULTS
  try {
    display = displaySettings()
  } catch (e) {
    console.error(e)
  }
  return (
    // dark クラスはブラウザでテーマを切り替えたときにも付け外すので、食い違っても警告しない
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${dark ? " dark" : ""}`}
      style={displayCssVars(display) as React.CSSProperties}
      suppressHydrationWarning
    >
      <body className="h-full">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
