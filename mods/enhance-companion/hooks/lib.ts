export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatTime(mtimeMs: number): string {
  const d = new Date(mtimeMs)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Slash-command arguments as the cc-enhance CLI takes them. */
export function splitArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/** Install folders of cc-enhance listed in Claude Code's installed_plugins.json, first one first. */
export function installPaths(registry: string): string[] {
  try {
    const parsed = JSON.parse(registry) as {
      plugins?: Record<string, { installPath?: unknown }[]>
    }
    return (parsed.plugins?.['cc-enhance@agent-enhance'] ?? []).flatMap(entry =>
      typeof entry.installPath === 'string' ? [entry.installPath] : [],
    )
  } catch {
    return []
  }
}

/** The connection a capability uses, or why it has none. */
export function describeRow(row: {
  state: string
  service?: string
  via?: string
  alternatives: number
  note?: string
}): string {
  if (row.state !== 'ready') return row.note ?? row.state
  return [
    row.service,
    row.via === 'preferred' || row.via === 'default' ? row.via : undefined,
    row.alternatives ? `+${row.alternatives}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}
