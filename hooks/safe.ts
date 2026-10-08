// Untrusted provider text and links: titles, authors, branch and job names are display data only.

// ESC/CSI/OSC sequences, then any remaining C0/C1 control or bidi override character.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[@-Z\\-_])/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

/** One line of display text: control sequences stripped, whitespace collapsed, length capped. */
export function cleanText(value: unknown, max = 300): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return ''
  }

  const text = String(value)
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * A link the pane may draw: http(s) only, no embedded credentials, no control characters,
 * at most 2048 characters. Anything else is null, and the pane says there is no link.
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null
  }

  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(value)) {
    return null
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }

  if (url.username !== '' || url.password !== '' || url.hostname === '') {
    return null
  }

  return url.toString()
}

/** Error text safe to show: one line, no control characters, no token-shaped values. */
export function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'

  return cleanText(raw.replace(/\b(?:glpat|ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9_-]+/g, '[redacted]'), 200)
}
