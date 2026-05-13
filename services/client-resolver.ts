import { loadClients } from '../config.ts'

export type ClientMatchMethod = 'none' | 'exact_cwd' | 'exact_content' | 'fuzzy_cwd' | 'unknown_cwd'
export type ClientMatchConfidence = 'none' | 'low' | 'medium' | 'high'

export interface ClientMatch {
  client: string | null
  confidence: ClientMatchConfidence
  method: ClientMatchMethod
  matched: string | null
  candidate: string | null
  score: number
  reason: string
}

const UMLAUTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[äöüß]/g, char => UMLAUTS[char] ?? char)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, '')
}

function segments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .map(part => part.trim())
    .filter(Boolean)
}

function damerauLevenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1)
      }
    }
  }
  return dp[a.length][b.length]
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  return 1 - damerauLevenshtein(a, b) / Math.max(a.length, b.length)
}

function clientAliases(): Array<{ client: string; alias: string; normalized: string }> {
  const clients = loadClients()
  const rows: Array<{ client: string; alias: string; normalized: string }> = []
  const seen = new Set<string>()
  for (const [alias, client] of Object.entries(clients)) {
    const normalized = compact(alias)
    const key = `${client}:${normalized}`
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    rows.push({ client, alias, normalized })
  }
  for (const client of new Set(Object.values(clients))) {
    const normalized = compact(client)
    const key = `${client}:${normalized}`
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    rows.push({ client, alias: client, normalized })
  }
  return rows
}

function none(reason = 'kein Kunden-Match'): ClientMatch {
  return { client: null, confidence: 'none', method: 'none', matched: null, candidate: null, score: 0, reason }
}

export function resolveClientContext(cwd: string, content = ''): ClientMatch {
  const aliases = clientAliases()
  if (aliases.length === 0) return none('clients.json enthält keine nutzbaren Aliase')

  const cwdNormalized = compact(cwd)
  for (const alias of aliases) {
    if (cwdNormalized.includes(alias.normalized)) {
      return {
        client: alias.client,
        confidence: 'high',
        method: 'exact_cwd',
        matched: alias.alias,
        candidate: null,
        score: 1,
        reason: `CWD enthält Kundenalias "${alias.alias}"`,
      }
    }
  }

  const candidates = segments(cwd)
    .map(segment => ({ raw: segment, normalized: compact(segment) }))
    .filter(segment => segment.normalized.length >= 5 && segment.normalized.length <= 32)

  let best: ClientMatch | null = null
  for (const candidate of candidates) {
    for (const alias of aliases) {
      if (alias.normalized.length < 5) continue
      const score = similarity(candidate.normalized, alias.normalized)
      if (score < 0.84) continue
      if (!best || score > best.score) {
        best = {
          client: alias.client,
          confidence: score >= 0.9 ? 'medium' : 'low',
          method: 'fuzzy_cwd',
          matched: alias.alias,
          candidate: candidate.raw,
          score,
          reason: `CWD-Segment "${candidate.raw}" ähnelt Kundenalias "${alias.alias}" (${Math.round(score * 100)}%)`,
        }
      }
    }
  }

  if (best) return best

  const contentNormalized = ` ${normalize(content)} `
  const contentMatches = new Map<string, { count: number; alias: string }>()
  for (const alias of aliases) {
    const pattern = ` ${normalize(alias.alias)} `
    if (pattern.trim().length < 3) continue
    const count = contentNormalized.split(pattern).length - 1
    if (count <= 0) continue
    const current = contentMatches.get(alias.client)
    if (!current || count > current.count) contentMatches.set(alias.client, { count, alias: alias.alias })
  }
  if (contentMatches.size > 0) {
    const [client, match] = [...contentMatches.entries()].sort((a, b) => b[1].count - a[1].count)[0]
    return {
      client,
      confidence: match.count >= 2 ? 'high' : 'medium',
      method: 'exact_content',
      matched: match.alias,
      candidate: null,
      score: Math.min(0.95, 0.78 + match.count * 0.07),
      reason: `Session-Inhalt erwähnt Kundenalias "${match.alias}"`,
    }
  }

  return none()
}
