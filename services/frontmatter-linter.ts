import { readFileSync, writeFileSync, statSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { loadTagAliases } from '../config.ts'
import { appendActionLog } from './action-log.ts'

export type FrontmatterProfile =
  | 'Kunde'
  | 'Referenz'
  | 'Troubleshooting'
  | 'Learning'
  | 'Runbook'
  | 'Daily'
  | 'Maintenance-Report'
  | 'Auto-Capture'
  | 'MOC'

export interface LintIssue {
  path: string
  field: string
  profile?: FrontmatterProfile
  severity: 'error' | 'warning' | 'info'
  issue: string
  suggestion: string
  autoFixable: boolean
}

export interface FrontmatterLintOptions {
  profile?: FrontmatterProfile
}

export interface FrontmatterFixOptions extends FrontmatterLintOptions {
  dryRun?: boolean
}

const VALID_STATUSES = new Set(['aktiv', 'planung', 'archiviert', 'entwurf', 'moc'])
const KNOWN_FIELDS = new Set([
  'status', 'tags', 'datum', 'erstellt', 'aktualisiert', 'projekt',
  'kunde', 'quelle', 'verknüpft', 'quellen', 'aliases', 'lifecycle_reviewed',
  'profile', 'typ', 'type',
])

const PROFILE_DEFAULT_STATUS: Partial<Record<FrontmatterProfile, string>> = {
  Kunde: 'aktiv',
  Referenz: 'aktiv',
  Troubleshooting: 'aktiv',
  Learning: 'aktiv',
  Runbook: 'aktiv',
  Daily: 'aktiv',
  'Maintenance-Report': 'aktiv',
  'Auto-Capture': 'aktiv',
  MOC: 'moc',
}

const PROFILE_REQUIRED_FIELDS: Record<FrontmatterProfile, string[]> = {
  Kunde: ['status', 'tags', 'kunde'],
  Referenz: ['status', 'tags'],
  Troubleshooting: ['status', 'tags'],
  Learning: ['status', 'tags'],
  Runbook: ['status', 'tags', 'quelle'],
  Daily: ['tags', 'datum'],
  'Maintenance-Report': ['status', 'tags', 'aktualisiert', 'quelle'],
  'Auto-Capture': ['status', 'tags', 'datum', 'quelle'],
  MOC: ['status', 'tags', 'quelle'],
}

const PROFILE_RECOMMENDED_TAGS: Record<FrontmatterProfile, string[]> = {
  Kunde: ['kunde'],
  Referenz: [],
  Troubleshooting: ['troubleshooting'],
  Learning: ['learning'],
  Runbook: ['runbook'],
  Daily: ['daily'],
  'Maintenance-Report': ['maintenance', 'review-queue'],
  'Auto-Capture': ['auto-capture'],
  MOC: ['moc'],
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function hasTag(fm: Record<string, any>, tag: string): boolean {
  return Array.isArray(fm.tags) && fm.tags.map(String).map(normalizeTag).includes(normalizeTag(tag))
}

export function inferFrontmatterProfile(path: string, fm: Record<string, any>): FrontmatterProfile {
  const explicit = String(fm.profile ?? fm.typ ?? fm.type ?? '')
  if (isFrontmatterProfile(explicit)) return explicit
  if (path.startsWith('Daily/') || hasTag(fm, 'daily')) return 'Daily'
  if (path.startsWith('Maintenance/') || fm.quelle === 'vault-gardener' || hasTag(fm, 'maintenance')) return 'Maintenance-Report'
  if (path.endsWith('_MOC.md') || fm.status === 'moc' || hasTag(fm, 'moc')) return 'MOC'
  if (fm.quelle === 'knowledge-harvester' || hasTag(fm, 'auto-capture')) return 'Auto-Capture'
  if (path.startsWith('Kunden/')) return 'Kunde'
  if (hasTag(fm, 'runbook') || path.startsWith('Runbooks/')) return 'Runbook'
  if (hasTag(fm, 'troubleshooting')) return 'Troubleshooting'
  if (hasTag(fm, 'learning')) return 'Learning'
  return 'Referenz'
}

export function isFrontmatterProfile(value: string): value is FrontmatterProfile {
  return [
    'Kunde',
    'Referenz',
    'Troubleshooting',
    'Learning',
    'Runbook',
    'Daily',
    'Maintenance-Report',
    'Auto-Capture',
    'MOC',
  ].includes(value)
}

function addIssue(
  issues: LintIssue[],
  issue: Omit<LintIssue, 'severity' | 'autoFixable'> & Pick<LintIssue, 'severity' | 'autoFixable'>,
): void {
  issues.push(issue)
}

function addTagIfMissing(fm: Record<string, any>, tag: string, changes: string[]): boolean {
  const normalized = normalizeTag(tag)
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String).map(normalizeTag) : []
  if (tags.includes(normalized)) return false
  fm.tags = [...tags, normalized]
  changes.push(`Tag ${normalized} hinzugefügt`)
  return true
}

function customerFromPath(path: string): string | null {
  const match = path.match(/^Kunden\/([^/]+)/)
  return match ? match[1] : null
}

// Normalize a tag: lowercase, trim, replace spaces with hyphens, apply aliases
export function normalizeTag(tag: string): string {
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

export function lintFrontmatter(vault: Vault, options: FrontmatterLintOptions = {}): LintIssue[] {
  loadTagAliases()
  const issues: LintIssue[] = []

  for (const [relPath, entry] of vault.notes) {
    const fm = entry.frontmatter
    const profile = options.profile ?? inferFrontmatterProfile(relPath, fm)
    const requiredFields = PROFILE_REQUIRED_FIELDS[profile]

    // 1. Missing status field (only warn for non-archive, non-daily)
    if (!relPath.startsWith('Archiv/') && profile !== 'Daily') {
      if (!fm.status) {
        addIssue(issues, {
          path: relPath,
          field: 'status',
          profile,
          severity: 'warning',
          issue: 'status fehlt',
          suggestion: `status: ${PROFILE_DEFAULT_STATUS[profile] ?? 'aktiv'}`,
          autoFixable: true,
        })
      } else if (typeof fm.status === 'string' && !VALID_STATUSES.has(fm.status.toLowerCase())) {
        addIssue(issues, {
          path: relPath,
          field: 'status',
          profile,
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
        addIssue(issues, {
          path: relPath,
          field: dateField,
          profile,
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
          addIssue(issues, {
            path: relPath,
            field: 'tags',
            profile,
            severity: 'info',
            issue: `Tag "${original[i]}" sollte "${normalized[i]}" sein`,
            suggestion: normalized[i],
            autoFixable: true,
          })
        }
      }

      if (deduped.length < normalized.length) {
        addIssue(issues, {
          path: relPath,
          field: 'tags',
          profile,
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
        addIssue(issues, {
          path: relPath,
          field,
          profile,
          severity: 'info',
          issue: `Feldname "${field}" sollte lowercase sein`,
          suggestion: lower,
          autoFixable: true,
        })
      }
    }

    // 5. Profile-specific required fields
    for (const field of requiredFields) {
      if (field === 'status' || field in fm && fm[field] !== undefined && fm[field] !== null && fm[field] !== '') continue
      const autoFixable = field === 'tags'
        || field === 'datum'
        || field === 'aktualisiert'
        || field === 'quelle'
        || (field === 'kunde' && !!customerFromPath(relPath))
      addIssue(issues, {
        path: relPath,
        field,
        profile,
        severity: 'warning',
        issue: `${profile}-Profil benötigt "${field}"`,
        suggestion: profileSuggestion(profile, field, relPath),
        autoFixable,
      })
    }

    for (const tag of PROFILE_RECOMMENDED_TAGS[profile]) {
      if (hasTag(fm, tag)) continue
      addIssue(issues, {
        path: relPath,
        field: 'tags',
        profile,
        severity: 'info',
        issue: `${profile}-Profil empfiehlt Tag "${tag}"`,
        suggestion: tag,
        autoFixable: true,
      })
    }
  }

  return issues
}

function profileSuggestion(profile: FrontmatterProfile, field: string, path: string): string {
  switch (field) {
    case 'status':
      return `status: ${PROFILE_DEFAULT_STATUS[profile] ?? 'aktiv'}`
    case 'tags':
      return `tags: [${PROFILE_RECOMMENDED_TAGS[profile].join(', ')}]`
    case 'datum':
    case 'aktualisiert':
      return `${field}: ${today()}`
    case 'kunde':
      return customerFromPath(path) ? `kunde: ${customerFromPath(path)}` : 'kunde ergänzen'
    case 'quelle':
      return `quelle: ${profile.toLowerCase()}`
    default:
      return `${field} ergänzen`
  }
}

export function fixFrontmatter(vault: Vault, dryRunOrOptions: boolean | FrontmatterFixOptions = true): {
  fixed: Array<{ path: string; changes: string[] }>
  skipped: Array<{ path: string; reason: string }>
} {
  loadTagAliases()
  const options: FrontmatterFixOptions = typeof dryRunOrOptions === 'boolean'
    ? { dryRun: dryRunOrOptions }
    : dryRunOrOptions
  const dryRun = options.dryRun ?? true
  const fixed: Array<{ path: string; changes: string[] }> = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const [relPath, entry] of vault.notes) {
    const changes: string[] = []
    const fm = { ...entry.frontmatter }
    const profile = options.profile ?? inferFrontmatterProfile(relPath, fm)
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
    if (!relPath.startsWith('Archiv/') && profile !== 'Daily' && !fm.status) {
      const status = PROFILE_DEFAULT_STATUS[profile] ?? 'aktiv'
      fm.status = status
      changes.push(`status: ${status} hinzugefügt`)
      modified = true
    }

    // Fix 4: Profile-aware safe defaults
    if (!Array.isArray(fm.tags)) {
      fm.tags = []
      changes.push('tags hinzugefügt')
      modified = true
    }
    for (const tag of PROFILE_RECOMMENDED_TAGS[profile]) {
      if (addTagIfMissing(fm, tag, changes)) modified = true
    }
    if (!fm.datum && PROFILE_REQUIRED_FIELDS[profile].includes('datum')) {
      fm.datum = today()
      changes.push('datum hinzugefügt')
      modified = true
    }
    if (!fm.aktualisiert && PROFILE_REQUIRED_FIELDS[profile].includes('aktualisiert')) {
      fm.aktualisiert = today()
      changes.push('aktualisiert hinzugefügt')
      modified = true
    }
    if (!fm.kunde && PROFILE_REQUIRED_FIELDS[profile].includes('kunde')) {
      const kunde = customerFromPath(relPath)
      if (kunde) {
        fm.kunde = kunde
        changes.push(`kunde: ${kunde} hinzugefügt`)
        modified = true
      }
    }
    if (!fm.quelle && PROFILE_REQUIRED_FIELDS[profile].includes('quelle')) {
      fm.quelle = profile.toLowerCase()
      changes.push(`quelle: ${fm.quelle} hinzugefügt`)
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
