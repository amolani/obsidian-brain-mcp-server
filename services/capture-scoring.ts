import type { ClassifiedIntent } from './intent-classifier.ts'
import { isMutatingCommand, performedCommands } from './intent-classifier.ts'
import type { KnowledgeSalienceSelection } from './knowledge-salience.ts'

export interface CaptureScoreInput {
  content: string
  tags?: string[]
  intent?: ClassifiedIntent | { intent: string; confidence?: string }
  clientMatchMethod?: string
  redactionCount?: number
  selection?: KnowledgeSalienceSelection
}

export interface CaptureScores {
  captureValue: number
  runbookReadiness: number
  reviewNeed: number
  reasons: string[]
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function scoreCapture(input: CaptureScoreInput): CaptureScores {
  if (input.selection) return scoreSemanticCapture(input, input.selection)

  // Compatibility path for captures created before knowledge-salience-v1.
  // New captures never use headings or command volume as importance proxies.
  const tags = input.tags ?? []
  const content = input.content
  const commands = performedCommands(content)
  const mutating = commands.filter(isMutatingCommand)
  const hasSummary = /## Zusammenfassung/i.test(content)
  const hasFlow = /## Ablauf/i.test(content)
  const hasFixes = /## Fehler und Workarounds/i.test(content)
  const hasValidation = /## Validierung|\b(validiert|geprüft|geprueft|erfolgreich getestet)\b/i.test(content)
  const intent = String(input.intent?.intent ?? 'unknown')
  const reasons: string[] = []

  let captureValue = 25
  if (hasSummary) {
    captureValue += 15
    reasons.push('Zusammenfassung vorhanden')
  }
  if (hasFlow) {
    captureValue += 15
    reasons.push('Ablauf vorhanden')
  }
  if (commands.length >= 3) {
    captureValue += 15
    reasons.push(`${commands.length} Befehle erfasst`)
  }
  if (hasFixes) {
    captureValue += 15
    reasons.push('Fehler/Workaround enthalten')
  }
  if (tags.includes('auto-capture')) captureValue += 5

  let runbookReadiness = 0
  if (['implementation', 'troubleshooting'].includes(intent)) runbookReadiness += 25
  if (mutating.length > 0) runbookReadiness += Math.min(30, 10 + mutating.length * 8)
  if (hasFlow) runbookReadiness += 15
  if (commands.length >= 3) runbookReadiness += 15
  if (hasValidation) runbookReadiness += 10
  if (hasFixes) runbookReadiness += 5

  let reviewNeed = 10
  if (['fuzzy_cwd', 'exact_content'].includes(String(input.clientMatchMethod ?? ''))) {
    reviewNeed += 30
    reasons.push('Kundenzuordnung prüfen')
  }
  if (String(input.clientMatchMethod ?? '') === 'none') reviewNeed += 20
  if (input.redactionCount && input.redactionCount > 0) {
    reviewNeed += 35
    reasons.push(`${input.redactionCount} Secret-Redaction(s)`)
  }
  if (intent === 'research' || intent === 'planning') reviewNeed += 15
  if (!hasValidation && runbookReadiness >= 55) reviewNeed += 10

  return {
    captureValue: clamp(captureValue),
    runbookReadiness: clamp(runbookReadiness),
    reviewNeed: clamp(reviewNeed),
    reasons: reasons.slice(0, 6),
  }
}

function scoreSemanticCapture(input: CaptureScoreInput, selection: KnowledgeSalienceSelection): CaptureScores {
  const facts = selection.facts
  const reasons: string[] = []
  const salience = facts.map(fact => fact.salienceScore)
  const evidence = facts.map(fact => fact.evidenceScore)
  const topSalience = Math.max(0, ...salience)
  const meanSalience = salience.reduce((sum, score) => sum + score, 0) / Math.max(1, salience.length)
  const captureValue = clamp(topSalience * 0.65 + meanSalience * 0.35)

  const strongChanges = facts.filter(fact => fact.kind === 'change' && fact.evidenceScore >= 75)
  const strongVerifications = facts.filter(fact => fact.kind === 'verification' && fact.evidenceScore >= 75)
  const supportedCauses = facts.filter(fact => fact.kind === 'cause' && fact.evidenceScore >= 45)
  let runbookReadiness = 0
  if (strongChanges.length > 0) runbookReadiness += 45
  if (strongVerifications.length > 0) runbookReadiness += 35
  if (supportedCauses.length > 0) runbookReadiness += 10
  if (['implementation', 'troubleshooting'].includes(String(input.intent?.intent ?? ''))) runbookReadiness += 10
  if (strongChanges.length === 0 || strongVerifications.length === 0) {
    runbookReadiness = Math.min(runbookReadiness, 55)
  }

  const weakImportant = facts.filter(fact => fact.salienceScore >= 60 && fact.evidenceScore < 45)
  const mediumImportant = facts.filter(fact => fact.salienceScore >= 60 && fact.evidenceScore >= 45 && fact.evidenceScore < 75)
  const openQuestions = facts.filter(fact => fact.kind === 'open_question')
  let reviewNeed = 5
  if (weakImportant.length > 0) {
    reviewNeed += Math.min(50, 20 + weakImportant.length * 10)
    reasons.push(`${weakImportant.length} wichtige Wissensatome mit schwacher Evidenz`)
  }
  if (mediumImportant.length > 0) {
    reviewNeed += Math.min(20, mediumImportant.length * 5)
    reasons.push(`${mediumImportant.length} wichtige Wissensatome mit mittlerer Evidenz`)
  }
  if (openQuestions.length > 0) {
    reviewNeed += Math.min(20, openQuestions.length * 8)
    reasons.push(`${openQuestions.length} konkrete offene Frage(n)`)
  }
  const routeMethod = String(input.clientMatchMethod ?? '')
  if (['fuzzy_cwd', 'exact_content', 'ambiguous_cwd', 'ambiguous_content', 'unknown_cwd'].includes(routeMethod)) {
    reviewNeed += 25
    reasons.push('Kunden-/Projektzuordnung ist nicht eindeutig')
  } else if (routeMethod === 'none') {
    reviewNeed += 10
  }
  if ((input.redactionCount ?? 0) > 0) {
    reviewNeed += 30
    reasons.push(`${input.redactionCount} Secret-Redaction(s)`)
  }

  if (topSalience > 0) reasons.unshift(`Salienz ${topSalience}/100 nach ${selection.modelVersion}`)
  if (strongChanges.length > 0 && strongVerifications.length > 0) {
    reasons.push('Änderung und Verifikation sind stark belegt')
  }

  return {
    captureValue,
    runbookReadiness: clamp(runbookReadiness),
    reviewNeed: clamp(reviewNeed),
    reasons: reasons.slice(0, 8),
  }
}
