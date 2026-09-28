"use client"

import { useId } from "react"

// sherpa のロゴ (山並みと、麓から頂上へ登る git の枝)。色は currentColor。
// 枝は白抜き (mask) なので、下の背景の色が見える。同じ形を app/icon.svg (favicon) と docs/images/logo*.svg (README) にも置く
export function Logo({ className }: { className?: string }) {
  const id = `logo-${useId().replace(/:/g, "")}`
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <mask id={id}>
        <rect width="32" height="32" fill="#fff" />
        <g stroke="#000" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12.5 29V14" />
          <path d="M19 29c0-5-6.5-5-6.5-9.5" />
        </g>
        <circle cx="12.5" cy="12.2" r="2.4" fill="#000" />
        <circle cx="19" cy="24.5" r="1.9" fill="#000" />
      </mask>
      <path
        d="M1.5 27.5 12.5 5l5.2 9.6 4.3-5.6 8.5 18.5Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        mask={`url(#${id})`}
      />
    </svg>
  )
}
