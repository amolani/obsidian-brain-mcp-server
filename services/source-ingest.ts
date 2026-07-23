import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath, assertSingleLineText, sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface SourceManifestEntry {
  hash: string
  ingestedAt: string
  sourcePath: string
  outputPath: string
  title: string
}

export interface SourceManifest {
  sources: Record<string, SourceManifestEntry>
}

export interface IngestSourceOptions {
  sourcePath: string
  title?: string
  outputFolder?: string
  dryRun?: boolean
  force?: boolean
  profile?: SourceIngestProfile
}

export interface IngestSourceResult {
  dryRun: boolean
  skipped: boolean
  reason: string
  sourcePath: string
  outputPath: string
  title: string
  hash: string
  headings: string[]
  keyPoints: string[]
  links: string[]
  profile: SourceIngestProfile
}

const MANIFEST_PATH = '.raw/.manifest.json'
export type SourceIngestProfile = 'markdown' | 'ticket' | 'incident_log' | 'web_export'

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function readManifest(vaultPath: string): SourceManifest {
  const path = vaultJoin(vaultPath, MANIFEST_PATH)
  if (!existsSync(path)) return { sources: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SourceManifest>
    if (!parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
      throw new Error('sources-Objekt erforderlich')
    }
    for (const [source, entry] of Object.entries(parsed.sources)) {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string' || typeof entry.outputPath !== 'string') {
        throw new Error(`ungültiger Source-Eintrag: ${source}`)
      }
    }
    return { sources: parsed.sources }
  } catch (error) {
    throw new Error(`Source-Ingest-Manifest ist beschädigt (${MANIFEST_PATH}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeManifest(vaultPath: string, manifest: SourceManifest): void {
  const path = vaultJoin(vaultPath, MANIFEST_PATH)
  mkdirSync(vaultJoin(vaultPath, '.raw'), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeSourcePath(sourcePath: string): string {
  const clean = sourcePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean.startsWith('.raw/')) throw new Error('ingest_source verarbeitet nur Quellen unter .raw/')
  return assertSafeRelativePath(clean)
}

function titleFromSource(sourcePath: string, content: string, explicit?: string): string {
  if (explicit !== undefined) return assertSingleLineText(explicit, 'title')
  const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (h1) return assertSingleLineText(h1.slice(0, 100), 'Source-Titel')
  return assertSingleLineText(basename(sourcePath).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || `Source ${today()}`, 'Source-Titel')
}

function extractHeadings(content: string): string[] {
  return [...content.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map(match => match[1].trim())
    .filter(Boolean)
    .slice(0, 20)
}

function extractKeyPoints(content: string): string[] {
  const points = content.split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(line => line.length >= 20)
  const paragraphs = content.split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length >= 80 && p.length <= 500)
  return [...new Set([...points, ...paragraphs])].slice(0, 12)
}

function extractLinks(content: string): string[] {
  const markdown = [...content.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)].map(match => match[1])
  const plain = [...content.matchAll(/\bhttps?:\/\/[^\s)]+/g)].map(match => match[0])
  return [...new Set([...markdown, ...plain])].slice(0, 20)
}

function normalizeProfile(value: unknown): SourceIngestProfile {
  return ['markdown', 'ticket', 'incident_log', 'web_export'].includes(String(value))
    ? value as SourceIngestProfile
    : 'markdown'
}

function profileSection(profile: SourceIngestProfile): string {
  if (profile === 'ticket') {
    return '## Ticket Kontext\n\n- [ ] Betroffene Systeme klaeren\n- [ ] Kunden-/Projektbezug pruefen\n- [ ] Ergebnis als Entscheidung, Claim oder Runbook speichern\n'
  }
  if (profile === 'incident_log') {
    return '## Incident Kontext\n\n- [ ] Symptome extrahieren\n- [ ] Timeline pruefen\n- [ ] Fix, Validierung und Follow-ups dokumentieren\n'
  }
  if (profile === 'web_export') {
    return '## Web Export Kontext\n\n- [ ] Primaerquelle und Aktualitaet pruefen\n- [ ] Claims extrahieren\n- [ ] Recheck-Datum setzen\n'
  }
  return ''
}

function renderSourceNote(result: Omit<IngestSourceResult, 'dryRun' | 'skipped' | 'reason'>): string {
  const headingLines = result.headings.length > 0
    ? result.headings.map(heading => `- ${heading}`).join('\n')
    : '- (keine Headings erkannt)'
  const keyPointLines = result.keyPoints.length > 0
    ? result.keyPoints.map(point => `- ${point}`).join('\n')
    : '- (keine Key Points automatisch erkannt)'
  const linkLines = result.links.length > 0
    ? result.links.map(link => `- ${link}`).join('\n')
    : '- (keine externen Links erkannt)'

  return `---
${buildFrontmatter({
    status: 'aktiv',
    tags: ['source', 'ingest', result.profile],
    datum: today(),
    quelle: result.sourcePath,
    source_hash: result.hash,
    profile: result.profile,
  })}---

# Source: ${result.title}

Quelle: [[${result.sourcePath}|${basename(result.sourcePath)}]]

## Kurzfassung

Automatisch ingestierte Source-Note. Die Quelle bleibt unverändert unter \`${result.sourcePath}\`.

## Erkannte Struktur

${headingLines}

## Key Points

${keyPointLines}

${profileSection(result.profile)}
## Externe Links

${linkLines}
`
}

export function ingestSource(vault: Vault, options: IngestSourceOptions): IngestSourceResult {
  const dryRun = options.dryRun ?? true
  const sourcePath = normalizeSourcePath(options.sourcePath)
  const fullSourcePath = vaultJoin(vault.vaultPath, sourcePath)
  if (!existsSync(fullSourcePath)) throw new Error(`Quelle nicht gefunden: ${sourcePath}`)

  const content = readFileSync(fullSourcePath, 'utf-8')
  const hash = sha256(content)
  const manifest = readManifest(vault.vaultPath)
  const existing = manifest.sources[sourcePath]
  const title = titleFromSource(sourcePath, content, options.title)
  const profile = normalizeProfile(options.profile)
  const outputFolder = options.outputFolder === undefined ? 'Referenz/Quellen' : assertSafeRelativePath(options.outputFolder)
  const fileStem = sanitizePathSegment(title)
  if (!fileStem) throw new Error('title ergibt keinen gültigen Dateinamen')
  const outputPath = existing?.outputPath ?? (
    dryRun
      ? `${outputFolder}/${fileStem}.md`
      : uniqueRelativePath(vault.vaultPath, outputFolder, `${fileStem}.md`)
  )
  const baseResult = {
    sourcePath,
    outputPath,
    title,
    hash,
    headings: extractHeadings(content),
    keyPoints: extractKeyPoints(content),
    links: extractLinks(content),
    profile,
  }

  if (existing) assertGeneratedSurfaceOwnership(vault.vaultPath, existing.outputPath, sourcePath)

  if (existing && existing.hash === hash && existsSync(vaultJoin(vault.vaultPath, existing.outputPath)) && !options.force) {
    return {
      dryRun,
      skipped: true,
      reason: 'Quelle unverändert laut Manifest',
      ...baseResult,
      outputPath: existing.outputPath,
      title: existing.title,
    }
  }

  if (dryRun) {
    return {
      dryRun,
      skipped: false,
      reason: existing ? 'Quelle geändert oder force=true; Re-Ingest möglich' : 'Neue Quelle; Ingest möglich',
      ...baseResult,
    }
  }

  assertCanWriteTool('ingest_source', [sourcePath, outputPath, MANIFEST_PATH])
  assertGeneratedSurfaceOwnership(vault.vaultPath, outputPath, sourcePath)
  const noteContent = renderSourceNote(baseResult)
  const fullOutputPath = vaultJoin(vault.vaultPath, outputPath)
  mkdirSync(vaultJoin(vault.vaultPath, outputFolder), { recursive: true })
  writeFileSync(fullOutputPath, noteContent, 'utf-8')
  vault.indexNote(fullOutputPath, statSync(fullOutputPath).mtimeMs)
  vault.buildLinkIndex()

  manifest.sources[sourcePath] = {
    hash,
    ingestedAt: new Date().toISOString(),
    sourcePath,
    outputPath,
    title,
  }
  writeManifest(vault.vaultPath, manifest)

  appendActionLog(vault.vaultPath, {
    tool: 'ingest_source',
    mode: 'apply',
    targets: [sourcePath, outputPath, MANIFEST_PATH],
    summary: `Quelle ingestiert: ${sourcePath} → ${outputPath}`,
    meta: { hash, title, headings: baseResult.headings.length, keyPoints: baseResult.keyPoints.length },
  })

  return {
    dryRun,
    skipped: false,
    reason: existing ? 'Quelle re-ingestiert' : 'Quelle ingestiert',
    ...baseResult,
  }
}
