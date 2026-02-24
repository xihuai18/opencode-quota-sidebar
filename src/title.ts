export function normalizeBaseTitle(title: string) {
  const firstLine = stripAnsi(title).split(/\r?\n/, 1)[0] || 'Session'
  return firstLine.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trimEnd() || 'Session'
}

export function stripAnsi(value: string) {
  // Remove terminal escape sequences. Sidebar titles must be plain text.
  // We intentionally strip more than SGR to avoid resize/render corruption.
  return (
    value
      // OSC: ESC ] ... BEL or ST (ESC \)
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // CSI: ESC [ ... final byte
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // 2-byte escapes and other single-ESC controls
      .replace(/\u001b[@-Z\\-_]/g, '')
      // Any leftover ESC
      .replace(/\u001b/g, '')
  )
}

export function canonicalizeTitle(value: string) {
  return stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
}

/**
 * Comparison canonicalizer for decorated titles.
 * OpenCode may normalize runs of spaces; treat those as equivalent.
 */
export function canonicalizeTitleForCompare(value: string) {
  const lines = stripAnsi(value).split(/\r?\n/)
  return lines
    .map((line, index) => {
      const safe = line.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trimEnd()
      return safe.trim().replace(/[ \t]+/g, ' ')
    })
    .join('\n')
}

/**
 * Detect whether a title already contains our decoration.
 * Current layout has token/quota lines after base title line.
 */
export function looksDecorated(title: string): boolean {
  const lines = stripAnsi(title).split(/\r?\n/)
  if (lines.length < 2) return false
  const detail = lines.slice(1).map((line) => line.trim())
  return detail.some((line) => {
    if (!line) return false
    if (/^Input\s+\S+\s+Output\s+\S+/.test(line)) return true
    if (/^Cache\s+(Read|Write)\s+\S+/.test(line)) return true
    if (/^\$\S+\s+as API cost/.test(line)) return true
    if (/^(OpenAI|Copilot|Anthropic|RightCode|RC)\b/.test(line)) return true
    return false
  })
}
