// 表示用の小さな関数 (相対時間、ホームの ~ への短縮)

let HOME = ""

export function setHome(home: string) {
  HOME = home
}

export function tildify(path: string) {
  if (HOME && (path === HOME || path.startsWith(HOME + "/"))) return "~" + path.slice(HOME.length)
  return path
}

// ISO 8601 の日時を「2時間前」のような表示にする (モックの表示に合わせる)
export function relTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const sec = Math.max(0, Math.round((now - t) / 1000))
  const min = Math.floor(sec / 60)
  const hour = Math.floor(min / 60)
  const day = Math.floor(hour / 24)
  if (sec < 60) return "たった今"
  if (min < 60) return `${min}分前`
  if (hour < 24) return `${hour}時間前`
  if (day === 1) return "昨日"
  if (day < 7) return `${day}日前`
  if (day < 30) return `${Math.floor(day / 7)}週間前`
  if (day < 365) return `${Math.floor(day / 30)}か月前`
  return `${Math.floor(day / 365)}年前`
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
