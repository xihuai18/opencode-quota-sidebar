export function normalizeBaseTitle(title: string) {
  return stripAnsi(title).split(/\r?\n/, 1)[0] || 'Session'
}

export function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

export function canonicalizeTitle(value: string) {
  return stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
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
    // Backward compatibility: old plugin versions had a separate Reasoning line.
    if (/^Reasoning\s+\S+/.test(line)) return true
    if (/^(OpenAI|Copilot|Anthropic|RightCode|RC)\b/.test(line)) return true
    return false
  })
}
