import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface ExtractTroubleshootingPatternResult {
  source: string
  title: string
  errors: string[]
  fixes: string[]
  commands: string[]
  patternMarkdown: string
}

export interface PromoteCaptureToRunbookOptions {
  path: string
  outputFolder?: string
  dryRun?: boolean
}

export interface PromoteCaptureToRunbookResult {
  dryRun: boolean
  source: string
  path: string
  stepCount: number
  fixCount: number
  content: string
}

export interface GeneratePostmortemOptions {
  path: string
  outputFolder?: string
  dryRun?: boolean
}

export interface GeneratePostmortemResult {
  dryRun: boolean
  source: string
  path: string
  content: string
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function resolveNote(vault: Vault, pathOrTitle: string): NoteEntry | null {
  const withMd = pathOrTitle.endsWith('.md') ? pathOrTitle : `${pathOrTitle}.md`
  return vault.notes.get(pathOrTitle)
    ?? vault.notes.get(withMd)
    ?? [...vault.notes.values()].find(entry =>
      entry.title.toLowerCase() === pathOrTitle.toLowerCase()
        || basename(entry.relativePath, '.md').toLowerCase() === pathOrTitle.toLowerCase(),
    )
    ?? null
}

function section(content: string, headingPatterns: string[]): string {
  for (const heading of headingPatterns) {
    const match = content.match(new RegExp(`^##\\s+${heading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`, 'im'))
    if (match) return match[1].trim()
  }
  return ''
}

function listItems(text: string): string[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => /^(-|\*|\d+\.)\s+/.test(line))
    .map(line => line.replace(/^(-|\*|\d+\.)\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim())
    .filter(Boolean)
}

function commands(content: string): string[] {
  const result: string[] = []
  for (const match of content.matchAll(/```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/gi)) {
    for (const line of match[1].split('\n').map(l => l.trim()).filter(Boolean)) {
      if (line.startsWith('#')) continue
      result.push(line)
    }
  }
  for (const line of content.split('\n').map(l => l.trim())) {
    if (/^(sudo |apt |npm |pnpm |docker |docker-compose |kubectl |systemctl |journalctl |qm |pvesh |git )/.test(line)) {
      result.push(line)
    }
  }
  return [...new Set(result)].slice(0, 30)
}

function extractFixes(content: string): string[] {
  const fixes = [
    ...listItems(section(content, ['Fehler und Workarounds', 'Fix', 'Fixes', 'Lösung', 'Loesung', 'Workaround', 'Workarounds'])),
  ]
  for (const match of content.matchAll(/(?:fix|lösung|loesung|workaround|resolved|behoben)[:：]\s*(.+)$/gim)) {
    fixes.push(match[1].trim())
  }
  return [...new Set(fixes)].slice(0, 20)
}

function extractErrors(content: string): string[] {
  const errors = [
    ...listItems(section(content, ['Fehler', 'Problem', 'Probleme', 'Incident', 'Symptome'])),
  ]
  for (const match of content.matchAll(/(?:error|fehler|exception|failed|problem)[:：]\s*(.+)$/gim)) {
    errors.push(match[1].trim())
  }
  return [...new Set(errors)].slice(0, 20)
}

function extractSteps(content: string): string[] {
  const direct = listItems(section(content, ['Durchgeführte Befehle', 'Durchgeführte Schritte', 'Schritte', 'Vorgehen']))
  return [...new Set([...direct, ...commands(content)])].slice(0, 40)
}

export function extractTroubleshootingPattern(vault: Vault, path: string): ExtractTroubleshootingPatternResult {
  const note = resolveNote(vault, path)
  if (!note) throw new Error(`Note nicht gefunden: ${path}`)
  const errors = extractErrors(note.content)
  const fixes = extractFixes(note.content)
  const cmds = commands(note.content)
  const patternMarkdown = [
    `# Troubleshooting Pattern: ${note.title}`,
    '',
    `Quelle: [[${note.relativePath}|${note.title}]]`,
    '',
    '## Symptome',
    errors.length > 0 ? errors.map(item => `- ${item}`).join('\n') : '- (keine expliziten Symptome gefunden)',
    '',
    '## Fixes',
    fixes.length > 0 ? fixes.map(item => `- ${item}`).join('\n') : '- (keine expliziten Fixes gefunden)',
    '',
    '## Relevante Befehle',
    cmds.length > 0 ? cmds.map(item => `- \`${item}\``).join('\n') : '- (keine Befehle gefunden)',
  ].join('\n')

  return {
    source: note.relativePath,
    title: note.title,
    errors,
    fixes,
    commands: cmds,
    patternMarkdown,
  }
}

export function promoteCaptureToRunbook(vault: Vault, options: PromoteCaptureToRunbookOptions): PromoteCaptureToRunbookResult {
  const dryRun = options.dryRun ?? true
  const note = resolveNote(vault, options.path)
  if (!note) throw new Error(`Note nicht gefunden: ${options.path}`)
  const steps = extractSteps(note.content)
  const fixes = extractFixes(note.content)
  const folder = options.outputFolder ?? 'Runbooks'
  const relativePath = dryRun
    ? `${folder}/Runbook ${sanitizePathSegment(note.title)}.md`
    : uniqueRelativePath(vault.vaultPath, folder, `Runbook ${sanitizePathSegment(note.title)}.md`)
  const sourceLink = `[[${note.relativePath}|${note.title}]]`
  const content = `---
status: aktiv
tags:
  - runbook
  - promoted-capture
datum: ${today()}
quelle: ${note.relativePath}
---

# Runbook: ${note.title}

Quelle: ${sourceLink}

## Schritte

${steps.length > 0 ? steps.map((step, idx) => `${idx + 1}. ${step}`).join('\n') : '1. Quelle manuell prüfen und Schritte ergänzen.'}

## Bekannte Probleme und Workarounds

${fixes.length > 0 ? fixes.map((fix, idx) => `### ${idx + 1}.\n${fix}`).join('\n\n') : '- Keine expliziten Workarounds gefunden.'}
`

  if (!dryRun) {
    mkdirSync(vaultJoin(vault.vaultPath, folder), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, relativePath)
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'promote_capture_to_runbook',
      mode: 'apply',
      targets: [relativePath],
      summary: `Capture zu Runbook promoted: ${note.relativePath}`,
      meta: { source: note.relativePath, steps: steps.length, fixes: fixes.length },
    })
  }

  return { dryRun, source: note.relativePath, path: relativePath, stepCount: steps.length, fixCount: fixes.length, content }
}

export function generatePostmortem(vault: Vault, options: GeneratePostmortemOptions): GeneratePostmortemResult {
  const dryRun = options.dryRun ?? true
  const note = resolveNote(vault, options.path)
  if (!note) throw new Error(`Note nicht gefunden: ${options.path}`)
  const pattern = extractTroubleshootingPattern(vault, note.relativePath)
  const folder = options.outputFolder ?? 'Postmortems'
  const relativePath = dryRun
    ? `${folder}/${today()} ${sanitizePathSegment(note.title)} Postmortem.md`
    : uniqueRelativePath(vault.vaultPath, folder, `${today()} ${sanitizePathSegment(note.title)} Postmortem.md`)
  const sourceLink = `[[${note.relativePath}|${note.title}]]`
  const content = `---
status: entwurf
tags:
  - postmortem
  - incident
datum: ${today()}
quelle: ${note.relativePath}
---

# Postmortem: ${note.title}

Quelle: ${sourceLink}

## Zusammenfassung

Aus der Quelle generierter Entwurf. Bitte Impact, Timeline und Follow-ups prüfen.

## Symptome

${pattern.errors.length > 0 ? pattern.errors.map(item => `- ${item}`).join('\n') : '- (ergänzen)'}

## Ursache

- (ergänzen)

## Lösung / Workaround

${pattern.fixes.length > 0 ? pattern.fixes.map(item => `- ${item}`).join('\n') : '- (ergänzen)'}

## Timeline

- ${today()}: Quelle ausgewertet: ${sourceLink}

## Follow-ups

- [ ] Runbook prüfen oder erstellen
- [ ] Monitoring/Prävention ergänzen
`

  if (!dryRun) {
    mkdirSync(vaultJoin(vault.vaultPath, folder), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, relativePath)
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'generate_postmortem',
      mode: 'apply',
      targets: [relativePath],
      summary: `Postmortem-Entwurf erzeugt aus ${note.relativePath}`,
      meta: { source: note.relativePath, errors: pattern.errors.length, fixes: pattern.fixes.length },
    })
  }

  return { dryRun, source: note.relativePath, path: relativePath, content }
}
