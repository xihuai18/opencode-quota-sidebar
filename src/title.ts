function sanitizeTitleFragment(value: string) {
  return stripAnsi(value)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    .trimEnd()
}

function isCoreDecoratedDetail(line: string) {
  if (!line) return false
  // Legacy coverage/Cov/CRC/CC tokens remain recognized so old decorated titles
  // can still be detected and cleaned up after format migrations.
  if (/^Requests\s+\$?\d[\d.,]*[kKmM]?$/.test(line)) return true
  if (
    /^Input\s+\$?[\d.,]+[kKmM]?(?:\s+Output(?:\s+\$?[\d.,]+[kKmM]?)?)?~?$/.test(
      line,
    )
  ) {
    return true
  }
  if (/^Cache\s+(Read|Write)\s+\$?\d[\d.,]*[kKmM]?$/.test(line)) return true
  if (/^Cache(?:\s+Read)?\s+Coverage\s+\d[\d.,]*(?:%|~)?$/.test(line)) {
    return true
  }
  if (/^Cache(?:\s+Read|\s+R)?\s+Cov\s+\d[\d.,]*(?:%|~)?$/.test(line)) {
    return true
  }
  if (/^Cached\s+\d[\d.,]*(?:%|~)?$/.test(line)) return true
  if (/^\$\S+\s+as API cost$/.test(line)) return true
  if (/^API\s+\$\S+$/.test(line)) return true
  if (/^Est\$\S+$/.test(line)) return true
  if (
    /^(?:R\$?[\d.,]+[kKmM]?|I\$?[\d.,]+[kKmM]?|O\$?[\d.,]+[kKmM]?|CR\$?[\d.,]+[kKmM]?|CW\$?[\d.,]+[kKmM]?|Cd\d[\d.,]*%|CC\d[\d.,]*%|CRC\d[\d.,]*%|API\$\S+|Est\$\S+)(?:\s+(?:R\$?[\d.,]+[kKmM]?|I\$?[\d.,]+[kKmM]?|O\$?[\d.,]+[kKmM]?|CR\$?[\d.,]+[kKmM]?|CW\$?[\d.,]+[kKmM]?|Cd\d[\d.,]*%|CC\d[\d.,]*%|CRC\d[\d.,]*%|API\$\S+|Est\$\S+))*$/.test(
      line,
    )
  ) {
    return true
  }

  // Single-line compact mode compatibility.
  if (
    /^I(?:nput)?\s+\$?\d[\d.,]*[kKmM]?\s+O(?:utput)?\s+\$?\d[\d.,]*[kKmM]?$/.test(
      line,
    )
  )
    return true
  if (
    /^R(?:eq(?:uests)?)?\s*\$?\d[\d.,]*[kKmM]?(?:\s+I\$?\d[\d.,]*[kKmM]?\s+O\$?\d[\d.,]*[kKmM]?)?$/.test(
      line,
    )
  ) {
    return true
  }
  if (/^C(?:ache\s*)?R(?:ead)?\s+\$?\d[\d.,]*[kKmM]?$/.test(line)) return true
  if (/^C(?:ache\s*)?W(?:rite)?\s+\$?\d[\d.,]*[kKmM]?$/.test(line)) return true
  if (
    /^C(?:ache(?:\s*R(?:ead)?)?)?\s*Coverage\s+\d[\d.,]*(?:%|~)?$/.test(line)
  ) {
    return true
  }
  if (/^C(?:ache(?:\s*(?:R|Read))?)?\s*Cov\s+\d[\d.,]*(?:%|~)?$/.test(line)) {
    return true
  }
  if (/^Cached\s+\d[\d.,]*(?:%|~)?$/.test(line)) return true
  if (/^API\s+\$\S+$/.test(line)) return true
  return false
}

function isQuotaDecoratedDetail(line: string) {
  if (!line) return false
  if (
    /^(OAI|Cop|Ant|Kimi|XYAI|RC(?:-[^\s]+)?)(?:\s+(?:\?|unsupported|unavailable|error|(?:\d+h|D|W|M)\d{1,3}|D[\d.,]+\/[\d.,]+|B(?:[￥$-])?[\d.,]+))+$/i.test(
      line,
    )
  ) {
    return true
  }
  if (/^(OpenAI|Copilot|Anthropic|Kimi|XYAI|RC(?:-[^\s]+)?)\s*$/.test(line)) {
    return true
  }
  if (
    /^(?:(?:Daily\s+\$[\d.,]+\/\$[\d.,]+|\$[\d.,]+\/\$[\d.,]+)(?:\s+(?:Rst|Exp\+?)\s+[-:\d]+)?|(?:\d+[hdw]|Weekly|Monthly)\s+\d{1,3}%(?:\s+Rst\s+[-:\d]+)?|Balance\s+\$[\d.,]+|Remaining\s+\?|(?:error|unsupported|unavailable))$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:D\$?[\d.,]+\/\$?[\d.,]+|B(?:[￥$-])?[\d.,]+|(?:\d+[hdw]|[DWM])\d{1,3}|(?:S7d|O7d|OA7d|Co7d)\d{1,3})(?:\s+(?:R|E\+?)\d[\d:.-]*)?$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(OpenAI|Copilot|Anthropic|Kimi|XYAI|RC(?:-[^\s]+)?)(?:\s+(?:(?:Daily\s+\$[\d.,]+\/\$[\d.,]+|\$[\d.,]+\/\$[\d.,]+)(?:\s+(?:Rst|Exp\+?)\s+[-:\d]+)?|(?:\d+[hdw]|Weekly|Monthly)\s+\d{1,3}%(?:\s+Rst\s+[-:\d]+)?|(?:error|unsupported|unavailable)))$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(OpenAI|Copilot|Anthropic|Kimi|XYAI|RC(?:-[^\s]+)?)(?:\s+(?:D\$?[\d.,]+\/\$?[\d.,]+|B(?:[￥$-])?[\d.,]+|(?:\d+[hdw]|[DWM])\d{1,3}|(?:S7d|O7d|OA7d|Co7d)\d{1,3})(?:\s+(?:R|E\+?)\d[\d:.-]*)?)$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:(?:D\$?[\d.,]+\/\$?[\d.,]+|B(?:[￥$-])?[\d.,]+|(?:\d+[hdw]|[DWM])\d{1,3}|(?:S7d|O7d|OA7d|Co7d)\d{1,3}|(?:R|E\+?)\d[\d:.-]*))(?:\s+(?:(?:D\$?[\d.,]+\/\$?[\d.,]+|B(?:[￥$-])?[\d.,]+|(?:\d+[hdw]|[DWM])\d{1,3}|(?:S7d|O7d|OA7d|Co7d)\d{1,3}|(?:R|E\+?)\d[\d:.-]*)))*$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(OpenAI|Copilot|Anthropic|Kimi|XYAI|RC(?:-[^\s]+)?)(?:\s+(?:(?:D\$?[\d.,]+\/\$?[\d.,]+|B(?:[￥$-])?[\d.,]+|(?:\d+[hdw]|[DWM])\d{1,3}|(?:S7d|O7d|OA7d|Co7d)\d{1,3}|(?:R|E\+?)\d[\d:.-]*)))*$/.test(
      line,
    )
  ) {
    return true
  }
  return false
}

function isSingleLineDecoratedPrefix(line: string) {
  if (!line) return false
  if (/^Req(?:uests)?\s+\$?[\d.,]+[kKmM]?~?$/.test(line)) return true
  if (
    /^R\$?[\d.,]+[kKmM]?\s+I\$?[\d.,]+[kKmM]?\s+O\$?[\d.,]+[kKmM]?(?:~|$)/.test(
      line,
    )
  ) {
    return true
  }
  if (/^Input\s+\$?[\d.,]+[kKmM]?~?$/.test(line)) return true
  if (
    /^Input\s+\$?[\d.,]+[kKmM]?\s+Output(?:\s+\$?[\d.,]+[kKmM]?~?)?$/.test(line)
  ) {
    return true
  }
  if (/^Cache\s+(Read|Write)\s+\$?\d[\d.,]*[kKmM]?(?:~|$)/.test(line)) {
    return true
  }
  if (/^Cache(?:\s+Read)?\s+Coverage\s+\d[\d.,]*(?:%|~)$/.test(line)) {
    return true
  }
  if (/^Cache(?:\s+Read|\s+R)?\s+Cov\s+\d[\d.,]*(?:%|~)$/.test(line)) {
    return true
  }
  if (/^Cached\s+\d[\d.,]*(?:%|~)$/.test(line)) return true
  if (/^\$\S+\s+as API cost(?:~|$)/.test(line)) return true
  if (/^API\s+\$\S+(?:~|$)/.test(line)) return true
  if (/^Est\$\S+(?:~|$)/.test(line)) return true
  if (
    /^(?:R\$?[\d.,]+[kKmM]?|I\$?[\d.,]+[kKmM]?|O\$?[\d.,]+[kKmM]?|CR\$?[\d.,]+[kKmM]?|CW\$?[\d.,]+[kKmM]?|Cd\d[\d.,]*%|CC\d[\d.,]*%|CRC\d[\d.,]*%|API\$\S+|Est\$\S+)(?:\s+(?:R\$?[\d.,]+[kKmM]?|I\$?[\d.,]+[kKmM]?|O\$?[\d.,]+[kKmM]?|CR\$?[\d.,]+[kKmM]?|CW\$?[\d.,]+[kKmM]?|Cd\d[\d.,]*%|CC\d[\d.,]*%|CRC\d[\d.,]*%|API\$\S+|Est\$\S+))*?(?:~|$)/.test(
      line,
    )
  ) {
    return true
  }
  return false
}

function isSingleLineDetailPrefix(line: string) {
  return (
    isCoreDecoratedDetail(line) ||
    isSingleLineDecoratedPrefix(line) ||
    isQuotaDecoratedDetail(line)
  )
}

function decoratedSingleLineBase(line: string) {
  const parts = sanitizeTitleFragment(line)
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
  if (parts.length < 2) return undefined
  if (isSingleLineDetailPrefix(parts[0] || '')) return undefined
  const details = parts.slice(1)
  if (!details.some((detail) => isSingleLineDetailPrefix(detail))) {
    return undefined
  }
  return parts[0] || 'Session'
}

export function normalizeBaseTitle(title: string) {
  const safeTitle = canonicalizeTitle(title) || 'Session'
  const firstLine = stripAnsi(safeTitle).split(/\r?\n/, 1)[0] || 'Session'
  const decoratedBase = decoratedSingleLineBase(firstLine)
  if (decoratedBase) return decoratedBase

  const lines = stripAnsi(safeTitle).split(/\r?\n/)
  if (lines.length > 1) {
    const detail = lines
      .slice(1)
      .map((line) => sanitizeTitleFragment(line).trim())
    if (
      detail.some(
        (line) => isCoreDecoratedDetail(line) || isQuotaDecoratedDetail(line),
      )
    ) {
      return sanitizeTitleFragment(firstLine) || 'Session'
    }
  }

  return safeTitle
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
  if (lines.length < 2) {
    return Boolean(decoratedSingleLineBase(lines[0] || ''))
  }

  const detail = lines
    .slice(1)
    .map((line) => sanitizeTitleFragment(line).trim())
  return detail.some(
    (line) => isCoreDecoratedDetail(line) || isQuotaDecoratedDetail(line),
  )
}
