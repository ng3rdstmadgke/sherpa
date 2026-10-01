"use client"

// 文字列をクリップボードにコピーする。成功したら true。
// navigator.clipboard は https か localhost で開いたときにしかない (http で IP アドレスやホスト名から開くとない) ので、
// そのときは画面にない textarea を選んで document.execCommand("copy") でコピーする (クリックなどの操作の中で呼ぶこと)
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 許可がないときなどは、下の方法を試す
    }
  }
  return copyWithExecCommand(text)
}

function copyWithExecCommand(text: string): boolean {
  const active = document.activeElement as HTMLElement | null
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  // 画面に出さず、スクロールもさせない
  ta.style.position = "fixed"
  ta.style.top = "0"
  ta.style.left = "0"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.()
  return ok
}
