import type { ClassifiedIntent } from './intent-classifier.ts'
import { isMutatingCommand, performedCommands } from './intent-classifier.ts'

export interface CaptureScoreInput {
  content: string
  tags?: string[]
  intent?: ClassifiedIntent | { intent: string; confidence?: string }
  clientMatchMethod?: string
  redactionCount?: number
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
