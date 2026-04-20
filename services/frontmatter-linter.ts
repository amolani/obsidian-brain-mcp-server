import { readFileSync, writeFileSync, statSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { loadTagAliases } from '../config.ts'
import { appendActionLog } from './action-log.ts'

export interface LintIssue {
  path: string
  field: string
  severity: 'error' | 'warning' | 'info'
  issue: string
  suggestion: string
  autoFixable: boolean
}

const VALID_STATUSES = new Set(['aktiv', 'planung', 'archiviert', 'entwurf', 'moc'])
const KNOWN_FIELDS = new Set([
  'status', 'tags', 'datum', 'erstellt', 'aktualisiert', 'projekt',
  'kunde', 'quelle', 'verknüpft', 'quellen', 'aliases',
])

// Normalize a tag: lowercase, trim, replace spaces with hyphens, apply aliases
function normalizeTag(tag: string): string {
  const aliases = loadTagAliases()
  const cleaned = tag.trim().toLowerCase().replace(/\s+/g, '-')
  return aliases[cleaned] ?? cleaned
}

export function buildFrontmatter(fm: Record<string, any>): string {
  const order = ['status', 'projekt', 'kunde', 'tags', 'datum', 'erstellt', 'aktualisiert', 'verknüpft', 'aliases', 'quelle']
  const lines: string[] = []
  const seen = new Set<string>()

  const emit = (key: string, val: any) => {
    if (val === undefined || val === null) return
    if (Array.isArray(val)) {
      lines.push(`${key}:`)
      for (const v of val) lines.push(`  - ${v}`)
    } else {
      lines.push(`${key}: ${val}`)
    }
    seen.add(key)
  }

  for (const k of order) {
    if (k in fm) emit(k, fm[k])
  }
  for (const k of Object.keys(fm)) {
    if (!seen.has(k) && !k.startsWith('_')) emit(k, fm[k])
  }

  return lines.join('\n') + '\n'
}

export function lintFrontmatter(vault: Vault): LintIssue[] {
  loadTagAliases()
  const issues: LintIssue[] = []

  for (const [relPath, entry] of vault.notes) {
    const fm = entry.frontmatter

    // 1. Missing status field (only warn for non-archive, non-daily)
    if (!relPath.startsWith('Archiv/') && !relPath.startsWith('Daily/') && !fm.tags?.includes?.('daily')) {
      if (!fm.status) {
        issues.push({
          path: relPath,
          field: 'status',
          severity: 'warning',
          issue: 'status fehlt',
          suggestion: 'status: aktiv',
          autoFixable: true,
        })
      } else if (typeof fm.status === 'string' && !VALID_STATUSES.has(fm.status.toLowerCase())) {
        issues.push({
          path: relPath,
          field: 'status',
          severity: 'warning',
          issue: `Unbekannter Status "${fm.status}"`,
          suggestion: `Erlaubt: ${[...VALID_STATUSES].join(', ')}`,
          autoFixable: false,
        })
      }
    }

    // 2. Date format check
    for (const dateField of ['datum', 'erstellt', 'aktualisiert']) {
      const val = fm[dateField]
      if (val && typeof val === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        issues.push({
          path: relPath,
          field: dateField,
          severity: 'warning',
          issue: `${dateField}: "${val}" ist kein ISO-Datum`,
          suggestion: 'Format: YYYY-MM-DD',
          autoFixable: false,
        })
      }
    }

    // 3. Tag normalization
    if (Array.isArray(fm.tags)) {
      const original = fm.tags.map(String)
      const normalized = original.map(normalizeTag)
      const deduped = [...new Set(normalized)]

      for (let i = 0; i < original.length; i++) {
        if (original[i] !== normalized[i]) {
          issues.push({
            path: relPath,
            field: 'tags',
            severity: 'info',
            issue: `Tag "${original[i]}" sollte "${normalized[i]}" sein`,
            suggestion: normalized[i],
            autoFixable: true,
          })
        }
      }

      if (deduped.length < normalized.length) {
        issues.push({
          path: relPath,
          field: 'tags',
          severity: 'info',
          issue: `${normalized.length - deduped.length} doppelte Tag(s)`,
          suggestion: `Deduplizieren auf: [${deduped.join(', ')}]`,
          autoFixable: true,
        })
      }
    }

    // 4. Unknown field names (typos)
    for (const field of Object.keys(fm)) {
      if (KNOWN_FIELDS.has(field)) continue
      if (field.startsWith('_')) continue
      const lower = field.toLowerCase()
      if (lower !== field) {
        issues.push({
          path: relPath,
          field,
          severity: 'info',
          issue: `Feldname "${field}" sollte lowercase sein`,
          suggestion: lower,
          autoFixable: true,
        })
      }
    }
  }

  return issues
}

export function fixFrontmatter(vault: Vault, dryRun: boolean = true): {
  fixed: Array<{ path: string; changes: string[] }>
  skipped: Array<{ path: string; reason: string }>
} {
  loadTagAliases()
  const fixed: Array<{ path: string; changes: string[] }> = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const [relPath, entry] of vault.notes) {
    const changes: string[] = []
    const fm = { ...entry.frontmatter }
    let modified = false

    // Fix 1: Normalize tags
    if (Array.isArray(fm.tags)) {
      const original = fm.tags.map(String)
      const normalized = [...new Set(original.map(normalizeTag))]
      if (JSON.stringify(original) !== JSON.stringify(normalized)) {
        changes.push(`Tags: [${original.join(', ')}] → [${normalized.join(', ')}]`)
        fm.tags = normalized
        modified = true
      }
    }

    // Fix 2: Lowercase field names
    const renames: Array<[string, string]> = []
    for (const key of Object.keys(fm)) {
      if (key.startsWith('_')) continue
      const lower = key.toLowerCase()
      if (lower !== key && !fm[lower]) {
        renames.push([key, lower])
      }
    }
    for (const [oldK, newK] of renames) {
      fm[newK] = fm[oldK]
      delete fm[oldK]
      changes.push(`${oldK} → ${newK}`)
      modified = true
    }

    // Fix 3: Add missing status for non-daily, non-archive notes
    if (!relPath.startsWith('Archiv/') && !relPath.startsWith('Daily/')
        && !fm.tags?.includes?.('daily') && !fm.status) {
      fm.status = 'aktiv'
      changes.push('status: aktiv hinzugefügt')
      modified = true
    }

    if (!modified) continue

    if (!dryRun) {
      try {
        const raw = readFileSync(entry.path, 'utf-8')
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!fmMatch) {
          skipped.push({ path: relPath, reason: 'kein Frontmatter gefunden' })
          continue
        }

        const newFm = buildFrontmatter(fm)
        const newRaw = raw.replace(fmMatch[0], `---\n${newFm}---`)
        writeFileSync(entry.path, newRaw, 'utf-8')

        const stat = statSync(entry.path)
        vault.indexNote(entry.path, stat.mtimeMs)
      } catch (err) {
        skipped.push({ path: relPath, reason: `Fehler: ${err}` })
        continue
      }
    }

    fixed.push({ path: relPath, changes })
  }

  if (!dryRun && fixed.length > 0) {
    vault.buildLinkIndex()
    const totalChanges = fixed.reduce((n, f) => n + f.changes.length, 0)
    appendActionLog(vault.vaultPath, {
      tool: 'fix_frontmatter',
      mode: 'apply',
      targets: fixed.map(f => f.path),
      summary: `${totalChanges} Frontmatter-Änderung(en) in ${fixed.length} Datei(en)`,
      meta: { fixed },
    })
  }
  return { fixed, skipped }
}
