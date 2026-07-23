import { existsSync, readFileSync } from 'node:fs'
import { parseFrontmatter } from './note-parser.ts'
import { vaultJoin } from './vault-paths.ts'

interface LegacySurfaceSignature {
  path: string
  generator: string
  tag: string
  heading: RegExp
  bodyMarker: string
}

const LEGACY_SURFACE_SIGNATURES: LegacySurfaceSignature[] = [
  { path: 'Knowledge/_brain.md', generator: 'brain-dashboard', tag: 'brain-dashboard', heading: /^# Brain Dashboard$/m, bodyMarker: '## Operating Review' },
  { path: 'Maintenance/Capture Review.md', generator: 'capture-review', tag: 'capture-review', heading: /^# Capture Review$/m, bodyMarker: '## Neue Captures' },
  { path: 'Knowledge/evidence.md', generator: 'evidence-dashboard', tag: 'evidence-dashboard', heading: /^# Evidence Dashboard$/m, bodyMarker: '## Summary' },
  { path: 'Maintenance/Knowledge Inbox.md', generator: 'knowledge-inbox', tag: 'knowledge-inbox', heading: /^# Knowledge Inbox$/m, bodyMarker: '## Provisional Claims' },
  { path: 'Knowledge/index.md', generator: 'knowledge-index', tag: 'knowledge-index', heading: /^# Knowledge Index$/m, bodyMarker: '## Bereiche' },
  { path: 'Knowledge/hot.md', generator: 'hot-cache', tag: 'hot-cache', heading: /^# Hot Cache(?:$|:)/m, bodyMarker: 'Diese Datei wird nicht automatisch in Sessions injiziert.' },
  { path: 'Maintenance/Change Ledger.md', generator: 'change-ledger', tag: 'change-ledger', heading: /^# Change Ledger$/m, bodyMarker: 'Brain-Schreibaktionen' },
]

export interface GeneratedSurfaceOwnershipOptions {
  allowRecognizedLegacy?: boolean
}

/**
 * Older releases emitted the fixed surfaces without `quelle`. Recognition is
 * deliberately narrow: exact fixed path + generator + tag + heading + a
 * generator-specific body marker. It never treats a foreign `quelle` as
 * legacy ownership.
 */
export function isRecognizedLegacyGeneratedSurface(
  vaultPath: string,
  relativePath: string,
  generator: string,
): boolean {
  const signature = LEGACY_SURFACE_SIGNATURES.find(item => item.path === relativePath && item.generator === generator)
  if (!signature) return false
  const fullPath = vaultJoin(vaultPath, relativePath)
  if (!existsSync(fullPath)) return false
  try {
    const content = readFileSync(fullPath, 'utf-8')
    const frontmatter = parseFrontmatter(content)
    if (frontmatter.quelle !== undefined && frontmatter.quelle !== null && frontmatter.quelle !== '') return false
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : []
    return frontmatter.status === 'aktiv'
      && tags.includes(signature.tag)
      && signature.heading.test(content)
      && content.includes(signature.bodyMarker)
  } catch {
    return false
  }
}

/**
 * Fixed generated surfaces may only replace files carrying their own exact
 * frontmatter ownership marker. Missing, malformed, or foreign frontmatter is
 * treated as user-owned and therefore fails closed.
 */
export function assertGeneratedSurfaceOwnership(
  vaultPath: string,
  relativePath: string,
  generator: string,
  options: GeneratedSurfaceOwnershipOptions = {},
): void {
  const fullPath = vaultJoin(vaultPath, relativePath)
  if (!existsSync(fullPath)) return

  const frontmatter = parseFrontmatter(readFileSync(fullPath, 'utf-8'))
  if (frontmatter.quelle !== generator) {
    if (options.allowRecognizedLegacy && isRecognizedLegacyGeneratedSurface(vaultPath, relativePath, generator)) return
    throw new Error(`${relativePath} existiert und ist nicht auto-generiert (nicht von ${generator} generiert)`)
  }
}
