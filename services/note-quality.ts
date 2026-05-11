import { basename } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { normalizeTag } from './frontmatter-linter.ts'

export type QualityGrade = 'excellent' | 'good' | 'fair' | 'poor'

export interface QualityIssue {
  dimension: string
  severity: 'info' | 'warning' | 'error'
  message: string
  suggestion: string
  penalty: number
}

export interface NoteQualityScore {
  path: string
  title: string
  score: number
  grade: QualityGrade
  dimensions: Record<string, number>
  issues: QualityIssue[]
}

export interface QualitySummary {
  total: number
  excellent: number
  good: number
  fair: number
  poor: number
  averageScore: number
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function grade(score: number): QualityGrade {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}

function isSkippable(path: string, entry: NoteEntry): boolean {
  if (path.startsWith('Daily/')) return true
  if (path.startsWith('Maintenance/')) return true
  if (basename(path, '.md') === '_MOC') return true
  return entry.tags.includes('daily') || entry.frontmatter?.quelle === 'vault-gardener'
}

function addIssue(
  issues: QualityIssue[],
  dimensions: Record<string, number>,
  dimension: string,
  penalty: number,
  severity: QualityIssue['severity'],
  message: string,
  suggestion: string,
): void {
  issues.push({ dimension, severity, message, suggestion, penalty })
  dimensions[dimension] = clampScore((dimensions[dimension] ?? 100) - penalty)
}

function bodyWordCount(content: string): number {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/^#+\s+.+$/gm, ' ')
    .split(/\s+/)
    .filter(w => w.trim().length > 0).length
}

function headingCount(content: string, level: 1 | 2): number {
  const re = level === 1 ? /^#\s+\S/gm : /^##\s+\S/gm
  return (content.match(re) ?? []).length
}

function codeBlockCount(content: string): number {
  return (content.match(/```[\s\S]*?```/g) ?? []).length
}

function listLineCount(content: string): number {
  return content.split('\n').filter(l => /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)).length
}

export function scoreNoteQuality(vault: Vault, pathOrTitle: string): NoteQualityScore | null {
  const entry = vault.notes.get(pathOrTitle) ?? [...vault.notes.values()].find(n =>
    n.title.toLowerCase() === pathOrTitle.toLowerCase()
      || basename(n.relativePath, '.md').toLowerCase() === pathOrTitle.toLowerCase()
  )
  if (!entry) return null
  return scoreEntry(vault, entry.relativePath, entry)
}

export function listLowQualityNotes(vault: Vault, maxScore: number = 69): NoteQualityScore[] {
  return [...vault.notes.entries()]
    .filter(([path, entry]) => !isSkippable(path, entry))
    .map(([path, entry]) => scoreEntry(vault, path, entry))
    .filter(result => result.score <= maxScore)
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
}

export function summarizeQuality(vault: Vault): QualitySummary {
  const scores = [...vault.notes.entries()]
    .filter(([path, entry]) => !isSkippable(path, entry))
    .map(([path, entry]) => scoreEntry(vault, path, entry))

  const summary: QualitySummary = {
    total: scores.length,
    excellent: scores.filter(s => s.grade === 'excellent').length,
    good: scores.filter(s => s.grade === 'good').length,
    fair: scores.filter(s => s.grade === 'fair').length,
    poor: scores.filter(s => s.grade === 'poor').length,
    averageScore: 0,
  }
  if (scores.length > 0) {
    summary.averageScore = Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
  }
  return summary
}

function scoreEntry(vault: Vault, path: string, entry: NoteEntry): NoteQualityScore {
  const issues: QualityIssue[] = []
  const dimensions: Record<string, number> = {
    title: 100,
    frontmatter: 100,
    tags: 100,
    links: 100,
    todos: 100,
    structure: 100,
    content: 100,
    freshness: 100,
  }

  const title = entry.title.trim()
  if (title.length < 6 || /^(notizen|todo|todos|untitled|problem)$/i.test(title)) {
    addIssue(issues, dimensions, 'title', 35, 'warning', 'Titel ist zu generisch oder zu kurz', 'Aussagekräftigen Titel mit Thema/System/Kontext setzen.')
  } else if (title.length > 80) {
    addIssue(issues, dimensions, 'title', 15, 'info', 'Titel ist sehr lang', 'Titel kürzen und Details in den Body verschieben.')
  }

  const fm = entry.frontmatter
  if (!fm.status && !path.startsWith('Archiv/')) {
    addIssue(issues, dimensions, 'frontmatter', 25, 'warning', 'status fehlt', 'status: aktiv, planung, entwurf oder archiviert setzen.')
  }
  if (!fm.datum && !fm.erstellt && !fm.aktualisiert) {
    addIssue(issues, dimensions, 'frontmatter', 15, 'info', 'Datumsfeld fehlt', 'datum oder aktualisiert im Frontmatter ergänzen.')
  }

  if (entry.tags.length === 0) {
    addIssue(issues, dimensions, 'tags', 30, 'warning', 'Keine Tags vorhanden', '2-5 relevante Tags ergänzen.')
  } else {
    const normalized = entry.tags.map(normalizeTag)
    if (JSON.stringify(entry.tags) !== JSON.stringify(normalized)) {
      addIssue(issues, dimensions, 'tags', 15, 'info', 'Tags sind nicht normalisiert', 'Tag-Aliases anwenden oder fix_frontmatter nutzen.')
    }
    if (entry.tags.length > 10) {
      addIssue(issues, dimensions, 'tags', 10, 'info', 'Sehr viele Tags', 'Tags auf die wichtigsten Themen reduzieren.')
    }
  }

  const inbound = vault.linkIndex.get(path)?.size ?? 0
  const outbound = entry.outgoingLinks.length
  if (inbound === 0 && outbound === 0) {
    addIssue(issues, dimensions, 'links', 30, 'warning', 'Keine ein- oder ausgehenden Links', 'Mindestens eine passende Kunden-, Technik- oder MOC-Note verlinken.')
  } else if (inbound === 0) {
    addIssue(issues, dimensions, 'links', 15, 'info', 'Keine Backlinks', 'Von Dashboard, MOC oder verwandter Note aus verlinken.')
  } else if (outbound === 0) {
    addIssue(issues, dimensions, 'links', 10, 'info', 'Keine ausgehenden Links', 'Verwandte Notes im Text verlinken.')
  }

  const orphanTodos = entry.todos.filter(t => !t.done && t.text.trim().length < 8).length
  if (orphanTodos > 0) {
    addIssue(issues, dimensions, 'todos', 15, 'info', `${orphanTodos} sehr kurze/offene TODOs`, 'TODOs konkret formulieren oder entfernen.')
  }

  const h1 = headingCount(entry.content, 1)
  const h2 = headingCount(entry.content, 2)
  if (h1 === 0) {
    addIssue(issues, dimensions, 'structure', 20, 'warning', 'H1 fehlt', 'Eine klare # Überschrift ergänzen.')
  } else if (h1 > 1) {
    addIssue(issues, dimensions, 'structure', 10, 'info', 'Mehrere H1-Überschriften', 'Nur eine H1 verwenden, weitere Ebenen als H2/H3.')
  }
  if (bodyWordCount(entry.content) > 120 && h2 === 0) {
    addIssue(issues, dimensions, 'structure', 15, 'info', 'Längere Note ohne H2-Struktur', 'Abschnitte mit ## gliedern.')
  }

  const words = bodyWordCount(entry.content)
  const codeBlocks = codeBlockCount(entry.content)
  const listLines = listLineCount(entry.content)
  if (words < 20 && entry.todos.length === 0) {
    addIssue(issues, dimensions, 'content', 25, 'warning', 'Sehr wenig Inhalt', 'Kontext, Entscheidung oder konkrete Schritte ergänzen.')
  }
  if (codeBlocks >= 2 && words < 80) {
    addIssue(issues, dimensions, 'content', 20, 'warning', 'Wirkt wie Befehls-/Config-Dump ohne Erklärung', 'Kurz beschreiben: Zweck, Voraussetzungen, Ergebnis, Stolperfallen.')
  }
  if (listLines > 20 && h2 < 2) {
    addIssue(issues, dimensions, 'content', 10, 'info', 'Viele Listenpunkte ohne Struktur', 'Listen in thematische Abschnitte aufteilen.')
  }

  const ageDays = Math.floor((Date.now() - entry.lastModified) / (24 * 60 * 60 * 1000))
  if (entry.frontmatter?.status === 'aktiv' && ageDays > 180 && !path.startsWith('Archiv/')) {
    addIssue(issues, dimensions, 'freshness', 20, 'info', `Aktive Note seit ${ageDays} Tagen nicht bearbeitet`, 'Aktualisieren oder auf archiviert setzen.')
  }

  const totalPenalty = issues.reduce((sum, issue) => sum + issue.penalty, 0)
  const score = clampScore(100 - totalPenalty)
  return {
    path,
    title: entry.title,
    score,
    grade: grade(score),
    dimensions,
    issues: issues.sort((a, b) => b.penalty - a.penalty),
  }
}
