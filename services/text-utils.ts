// Shared text utilities used by multiple analyzers (duplicate, broken-link).

const STOPWORDS = new Set([
  'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'mit', 'für', 'fuer',
  'bei', 'zum', 'zur', 'auf', 'aus', 'vom', 'ins', 'als', 'von', 'ein', 'eine',
  'einer', 'einem', 'eines', 'nicht', 'auch', 'noch', 'nur', 'bis', 'so',
  'and', 'or', 'the', 'for', 'with', 'from', 'to', 'in', 'on', 'at', 'by', 'of',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'not', 'but', 'also',
])

export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w))
  return new Set(words)
}

export function tokenizeContent(text: string): Set<string> {
  // Strip code blocks and frontmatter for cleaner content comparison
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/^---[\s\S]*?---/, ' ')
  const words = cleaned
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4) // longer threshold for content
  // Keep most frequent 100 tokens for speed
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)
  return new Set(top.map(([w]) => w))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersect = 0
  for (const x of a) if (b.has(x)) intersect++
  const union = a.size + b.size - intersect
  return intersect / union
}
