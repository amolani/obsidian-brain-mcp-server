import { listSuggestions, promoteClientSuggestion, promoteTechnikSuggestion } from '../suggestions.ts'
import type { BrainCalibrationEvaluationResult, SaveKnowledgeResult } from '../vault.ts'
import { appendActionLog } from '../services/action-log.ts'
import type {
  BrainCalibrationLabel,
  RecordCalibrationLabelOptions,
} from '../services/brain-calibration.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { strings, type ToolHandlerRegistry } from './types.ts'

function evidenceConfidence(value: unknown): 'low' | 'medium' | 'high' | undefined {
  return ['low', 'medium', 'high'].includes(String(value)) ? value as 'low' | 'medium' | 'high' : undefined
}

function renderKnowledgeSave(result: SaveKnowledgeResult) {
  return {
    content: [{
      type: 'text' as const,
      text: [
        result.dryRun ? '# Knowledge Save Vorschau' : '# Knowledge gespeichert',
        '',
        `Typ: ${result.type}`,
        `Dry-Run: ${result.dryRun}`,
        `Pfad: \`${result.path}\``,
        `Tags: ${result.tags.join(', ')}`,
        '',
        result.dryRun ? '## Vorschau' : '',
        result.dryRun ? result.content : '',
      ].filter(Boolean).join('\n'),
    }],
  }
}

function renderBrainCalibrationReports(result: BrainCalibrationEvaluationResult): string {
  return result.reports.map(report => {
    const percent = (value: number | null) =>
      value === null ? 'n/a' : `${(value * 100).toFixed(1)} %`
    const interval = (value: { low: number; high: number } | null) =>
      value === null ? 'n/a' : `${value.low.toFixed(4)} bis ${value.high.toFixed(4)}`
    const scoreBands = report.responseCoverage.scoreBands
      .map(band => `${band.band}: ${percent(band.weightedResponseRate)}`)
      .join('; ')
    const populationBands = report.responseCoverage.candidatePopulationBands
      .map(band => `${band.band}: ${percent(band.weightedResponseRate)}`)
      .join('; ')
    const lines = [
      `## ${report.label}`,
      '',
      `Status: ${report.status}`,
      `Empfehlung: ${report.recommendation}`,
      `Split: train ${report.split.trainTargets} Targets/${report.split.trainGroups} Gruppen; test ${report.split.testTargets} Targets/${report.split.testGroups} Gruppen`,
      `Klassen: train +${report.split.trainPositive}/-${report.split.trainNegative}; test +${report.split.testPositive}/-${report.split.testNegative}`,
      `Zeitordnung: ${report.split.strictTemporalOrder ? 'strikt' : 'nicht verfügbar'}; Cutoff ${report.split.cutoffAt ?? 'n/a'}; embargoed ${report.split.embargoedTargets} Targets/${report.split.embargoedGroups} Gruppen`,
      `Abstentions: ${report.split.abstainedTies}`,
      '',
      'Response-Coverage:',
      `- Gesamt IPW: ${percent(report.responseCoverage.weightedResponseRate)} (${report.responseCoverage.labeledTargets}/${report.responseCoverage.eligibleTargets} roh)`,
      `- selected / sampled_unselected IPW: ${percent(report.responseCoverage.selected.weightedResponseRate)} / ${percent(report.responseCoverage.sampledUnselected.weightedResponseRate)}`,
      `- Holdout-Ära ab ${report.responseCoverage.holdoutEra.startsAt ?? 'n/a'}: ${percent(report.responseCoverage.holdoutEra.weightedResponseRate)}`,
      `- Score-Bänder: ${scoreBands || 'n/a'}`,
      `- Populationsgrößen: ${populationBands || 'n/a'}`,
      `- Ungültige Captures / Labels außerhalb Frame: ${report.responseCoverage.invalidCaptureBundles} / ${report.responseCoverage.labelsOutsideFrame}`,
    ]
    if (report.calibratedProductionScore && report.shadowCandidate && report.comparison) {
      lines.push(
        '',
        `Kalibrierter Produktionsscore: Brier ${report.calibratedProductionScore.metrics.brier.toFixed(4)}, Log-Loss ${report.calibratedProductionScore.metrics.logLoss.toFixed(4)}, eff. n ${report.calibratedProductionScore.metrics.effectiveSampleSize.toFixed(1)}, monoton ${report.calibratedProductionScore.monotonicOrdinalScore}`,
        `Shadow-Kandidat: Brier ${report.shadowCandidate.metrics.brier.toFixed(4)}, Log-Loss ${report.shadowCandidate.metrics.logLoss.toFixed(4)}, eff. n ${report.shadowCandidate.metrics.effectiveSampleSize.toFixed(1)}`,
        `ΔBrier: ${report.comparison.deltaBrier.toFixed(4)} (95 % ${report.comparison.brier95.low.toFixed(4)} bis ${report.comparison.brier95.high.toFixed(4)})`,
        `MNAR-ΔBrier: ${interval(report.comparison.mnarBrier95)}`,
        `ΔLog-Loss: ${report.comparison.deltaLogLoss.toFixed(4)} (95 % ${report.comparison.logLoss95.low.toFixed(4)} bis ${report.comparison.logLoss95.high.toFixed(4)})`,
        `ΔFalse-Promotion / ΔFPR 95 %: ${interval(report.comparison.falsePromotion95)} / ${interval(report.comparison.falsePositiveRate95)}`,
        `Promoted baseline/shadow: ${report.comparison.baselinePromotedCount}/${report.comparison.candidatePromotedCount}`,
        `Gepaarte Coverage: ${(report.comparison.pairedCoverage * 100).toFixed(1)} %`,
        '',
        'Shadow-Koeffizienten (standardisiert, diagnostisch):',
        ...report.shadowCandidate.featureNames.map((feature, index) =>
          `- ${feature}: ${report.shadowCandidate?.standardizedCoefficients[index]?.toFixed(4) ?? 'n/a'}`),
      )
    }
    if (report.reasons.length > 0) {
      lines.push('', 'Gründe/Grenzen:', ...report.reasons.map(reason => `- ${reason}`))
    }
    return lines.join('\n')
  }).join('\n\n')
}

export const knowledgeHandlers: ToolHandlerRegistry = {
  create_note(vault, args) {
    const result = vault.createNote(
      args.title as string,
      args.template as string,
      args.content as string | undefined,
      args.tags as string[] | undefined,
      args.folder as string | undefined,
    )

    return {
      content: [
        {
          type: 'text',
          text: `Note erstellt: ${result.path}`,
        },
      ],
    }
  },

  capture(vault, args) {
    const result = vault.capture(
      args.content as string,
      args.category as string | undefined,
    )

    return {
      content: [
        {
          type: 'text',
          text: [
            `Erfasst: **${result.title}**`,
            `Pfad: ${result.path}`,
            `Ordner: ${result.folder}`,
            `Tags: ${result.tags.join(', ')}`,
          ].join('\n'),
        },
      ],
    }
  },

  capture_v2(vault, args) {
    const result = vault.captureV2(
      args.content as string,
      {
        category: args.category as string | undefined,
        mode: args.mode as 'fast' | 'strict' | 'review' | undefined,
        dryRun: typeof args.dry_run === 'boolean' ? args.dry_run : undefined,
      },
    )

    const classification = result.classification.category
      ? `${result.classification.category}${result.classification.subcategory ? `/${result.classification.subcategory}` : ''} (${Math.round(result.classification.confidence)})`
      : 'keine'

    const header = result.dryRun
      ? 'Vorschau (Dry Run, nichts geschrieben)'
      : 'Erfasst'

    return {
      content: [
        {
          type: 'text',
          text: [
            `## ${header}: **${result.title}**`,
            `Pfad: ${result.path}`,
            `Ordner: ${result.folder}`,
            `Modus: ${result.mode}`,
            `Tags: ${result.tags.join(', ')}`,
            `Kunde: ${result.detectedClient ?? 'keiner'}`,
            `Technik-Klassifizierung: ${classification}`,
            `Grund: ${result.reason}`,
            result.reviewRequired ? `Review: empfohlen` : `Review: nicht erforderlich`,
          ].join('\n'),
        },
      ],
    }
  },

  ingest_source(vault, args) {
    const result = vault.ingestSource({
      sourcePath: args.source_path as string,
      title: typeof args.title === 'string' ? args.title : undefined,
      outputFolder: typeof args.output_folder === 'string' ? args.output_folder : undefined,
      dryRun: args.dry_run !== false,
      force: args.force === true,
      profile: typeof args.profile === 'string' ? args.profile as any : undefined,
    })

    const headings = result.headings.length > 0
      ? result.headings.slice(0, 8).map(heading => `- ${heading}`).join('\n')
      : '  (keine)'
    const keyPoints = result.keyPoints.length > 0
      ? result.keyPoints.slice(0, 6).map(point => `- ${point}`).join('\n')
      : '  (keine)'

    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Source-Ingest Vorschau' : '# Source ingestiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Skipped: ${result.skipped}`,
          `Grund: ${result.reason}`,
          `Quelle: \`${result.sourcePath}\``,
          `Ziel: \`${result.outputPath}\``,
          `Titel: ${result.title}`,
          `Profil: ${result.profile}`,
          `Hash: \`${result.hash.slice(0, 12)}...\``,
          '',
          '## Erkannte Headings',
          headings,
          '',
          '## Key Points',
          keyPoints,
        ].join('\n'),
      }],
    }
  },

  save_insight(vault, args) {
    return renderKnowledgeSave(vault.saveInsight({
      title: args.title as string,
      content: args.content as string,
      context: typeof args.context === 'string' ? args.context : undefined,
      source: typeof args.source === 'string' ? args.source : undefined,
      tags: strings(args.tags),
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      confidence: evidenceConfidence(args.confidence),
      checkedAt: typeof args.checked_at === 'string' ? args.checked_at : undefined,
      recheckAt: typeof args.recheck_at === 'string' ? args.recheck_at : undefined,
      expiresAt: typeof args.expires_at === 'string' ? args.expires_at : undefined,
      confirmedBy: strings(args.confirmed_by),
      contradictedBy: strings(args.contradicted_by),
      dryRun: args.dry_run !== false,
    }))
  },

  save_decision(vault, args) {
    return renderKnowledgeSave(vault.saveDecision({
      title: args.title as string,
      content: args.content as string,
      context: typeof args.context === 'string' ? args.context : undefined,
      source: typeof args.source === 'string' ? args.source : undefined,
      tags: strings(args.tags),
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      confidence: evidenceConfidence(args.confidence),
      checkedAt: typeof args.checked_at === 'string' ? args.checked_at : undefined,
      recheckAt: typeof args.recheck_at === 'string' ? args.recheck_at : undefined,
      expiresAt: typeof args.expires_at === 'string' ? args.expires_at : undefined,
      confirmedBy: strings(args.confirmed_by),
      contradictedBy: strings(args.contradicted_by),
      dryRun: args.dry_run !== false,
    }))
  },

  save_answer(vault, args) {
    return renderKnowledgeSave(vault.saveAnswer({
      title: args.title as string,
      content: args.content as string,
      context: typeof args.context === 'string' ? args.context : undefined,
      source: typeof args.source === 'string' ? args.source : undefined,
      tags: strings(args.tags),
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      confidence: evidenceConfidence(args.confidence),
      checkedAt: typeof args.checked_at === 'string' ? args.checked_at : undefined,
      recheckAt: typeof args.recheck_at === 'string' ? args.recheck_at : undefined,
      expiresAt: typeof args.expires_at === 'string' ? args.expires_at : undefined,
      confirmedBy: strings(args.confirmed_by),
      contradictedBy: strings(args.contradicted_by),
      dryRun: args.dry_run !== false,
    }))
  },

  update_evidence(vault, args) {
    const result = vault.updateEvidence({
      path: args.path as string,
      confidence: evidenceConfidence(args.confidence),
      source: typeof args.source === 'string' ? args.source : undefined,
      checkedAt: typeof args.checked_at === 'string' ? args.checked_at : undefined,
      recheckAt: typeof args.recheck_at === 'string' ? args.recheck_at : undefined,
      expiresAt: typeof args.expires_at === 'string' ? args.expires_at : undefined,
      confirmedBy: strings(args.confirmed_by),
      contradictedBy: strings(args.contradicted_by),
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Evidence Update Vorschau' : '# Evidence aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Felder: ${result.changedFields.join(', ') || '(keine Änderung)'}`,
          '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  evidence_report(vault) {
    const result = vault.evidenceReport()
    const lines = result.issues.slice(0, 40).map(issue =>
      `- **${issue.severity}** \`${issue.path}\`: ${issue.issue} → ${issue.suggestion}`,
    ).join('\n') || 'Keine Evidence-Issues.'
    return {
      content: [{
        type: 'text',
        text: [
          '# Evidence Report',
          '',
          `Candidates: ${result.totalCandidates}`,
          `Missing confidence: ${result.missingConfidence}`,
          `Missing source: ${result.missingSource}`,
          `Due rechecks: ${result.dueRechecks}`,
          `Contradicted: ${result.contradicted}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  extract_claims(vault, args) {
    const result = vault.extractClaims({
      path: args.path as string,
      maxClaims: typeof args.max_claims === 'number' ? args.max_claims : undefined,
      dryRun: args.dry_run !== false,
    })
    const lines = result.claims.map(claim => [
      `- ${claim.claim}`,
      `  Confidence: ${claim.confidence}`,
      claim.contradictionCandidates.length > 0 ? `  Widersprüche: ${claim.contradictionCandidates.join(', ')}` : '',
    ].filter(Boolean).join('\n')).join('\n') || 'Keine Claims erkannt.'
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Claim Extraction Vorschau' : '# Claims extrahiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Quelle: \`${result.source}\``,
          `Claims: ${result.claims.length}`,
          `Geschrieben: ${result.written.length}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  update_hot_cache(vault, args) {
    const result = vault.updateHotCache({
      query: typeof args.query === 'string' ? args.query : undefined,
      maxNotes: typeof args.max_notes === 'number' ? args.max_notes : undefined,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Hot Cache Vorschau' : '# Hot Cache aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Query: ${result.query || '(Vault-Aktivität)'}`,
          `Notizen: ${result.noteCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  read_hot_cache(vault) {
    const result = vault.readHotCache()
    return { content: [{ type: 'text', text: result.content }] }
  },

  build_knowledge_index(vault, args) {
    const result = vault.buildKnowledgeIndex({ dryRun: args.dry_run !== false })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Knowledge Index Vorschau' : '# Knowledge Index aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Notizen: ${result.noteCount}`,
          `Sektionen: ${result.sectionCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  flag_knowledge_gap(vault, args) {
    const result = vault.flagKnowledgeGap({
      question: args.question as string,
      context: typeof args.context === 'string' ? args.context : undefined,
      tags: strings(args.tags),
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Wissenslücke Vorschau' : '# Wissenslücke erfasst',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  flag_contradiction(vault, args) {
    const result = vault.flagContradiction({
      title: args.title as string,
      claimA: args.claim_a as string,
      claimB: args.claim_b as string,
      sources: strings(args.sources),
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Widerspruch Vorschau' : '# Widerspruch erfasst',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  list_open_questions(vault) {
    const questions = vault.listOpenQuestions()
    const lines = questions.length > 0
      ? questions.map(item => `- [${item.type}] \`${item.path}\` - ${item.title}`).join('\n')
      : 'Keine offenen Wissenslücken oder Widersprüche.'
    return { content: [{ type: 'text', text: lines }] }
  },

  resolve_gap(vault, args) {
    const result = vault.resolveGap({
      path: args.path as string,
      resolution: args.resolution as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Gap-Lösung Vorschau' : '# Gap gelöst',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  create_research_plan(vault, args) {
    const result = vault.createResearchPlan({
      topic: args.topic as string,
      question: typeof args.question === 'string' ? args.question : undefined,
      scope: typeof args.scope === 'string' ? args.scope : undefined,
      sources: strings(args.sources),
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Research Plan Vorschau' : '# Research Plan erstellt',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Kontextnotizen: ${result.contextCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  build_brain_dashboard(vault, args) {
    const result = vault.buildBrainDashboard({ dryRun: args.dry_run !== false })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Brain Dashboard Vorschau' : '# Brain Dashboard aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Review Items: ${result.reviewCount}`,
          `Offene Fragen: ${result.openQuestionCount}`,
          `Evidence Issues: ${result.evidenceIssueCount}`,
          `Research-Pläne: ${result.researchPlanCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  build_capture_review(vault, args) {
    const result = vault.buildCaptureReview({ dryRun: args.dry_run !== false })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Capture Review Vorschau' : '# Capture Review aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Captures: ${result.captureCount}`,
          `Promotionskandidaten: ${result.promotionCandidateCount}`,
          `Kundenzuordnung prüfen: ${result.uncertainClientCount}`,
          `Noisy Auto-Build: ${result.noisyAutoBuildCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  build_evidence_dashboard(vault, args) {
    const result = vault.buildEvidenceDashboard({ dryRun: args.dry_run !== false })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Evidence Dashboard Vorschau' : '# Evidence Dashboard aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Candidates: ${result.totalCandidates}`,
          `Issues: ${result.issueCount}`,
          `High Risk: ${result.highRiskCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  build_session_impact_report(vault, args) {
    const result = vault.buildSessionImpactReport({
      sourcePath: args.source_path as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Session Impact Report Vorschau' : '# Session Impact Report aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Quelle: \`${result.sourcePath}\``,
          `Pfad: \`${result.path}\``,
          `Intent: ${result.intent.intent} (${result.intent.confidence})`,
          `Geschrieben/Artefakte: ${result.createdCount}`,
          `Review nötig: ${result.reviewCount}`,
          `Skips: ${result.skippedCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  repair_generated_surfaces(vault, args) {
    const result = vault.repairGeneratedSurfaces({
      dryRun: args.dry_run !== false,
      adoptLegacy: args.adopt_legacy === true,
    })
    const lines = result.surfaces.map(surface => '- `' + surface.id + '`: `' + surface.path + '`').join('\n')
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Generated Surfaces Repair Vorschau' : '# Generated Surfaces repariert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Legacy-Übernahme: ${result.adoptLegacy}`,
          `Erkannte Legacy-Surfaces: ${result.recognizedLegacy.length > 0 ? result.recognizedLegacy.join(', ') : 'keine'}`,
          `Repariert: ${result.repaired}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  build_knowledge_inbox(vault, args) {
    const result = vault.buildKnowledgeInbox({ dryRun: args.dry_run !== false })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Knowledge Inbox Vorschau' : '# Knowledge Inbox aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Provisional Claims: ${result.provisionalClaimCount}`,
          `Kundenzuordnung prüfen: ${result.uncertainClientCount}`,
          `Runbook-Kandidaten: ${result.runbookCandidateCount}`,
          `Auto-Build Skips: ${result.skippedAutoBuildCount}`,
          `Impact Reports: ${result.impactReportCount}`,
          `Offene Actions: ${result.openItemCount}`,
          `Persistierte States: ${result.persistedStateCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  brain_apply_inbox_item(vault, args) {
    const result = vault.brainApplyInboxItem({
      itemId: args.item_id as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Knowledge Inbox Action Vorschau' : '# Knowledge Inbox Action angewendet',
          '',
          `Item: \`${result.item.id}\``,
          `Aktion: ${result.item.kind}`,
          `Target: \`${result.item.target}\``,
          `Dry-Run: ${result.dryRun}`,
          `Summary: ${result.summary}`,
          '',
          '## Ergebnis',
          '```json',
          JSON.stringify(result.result, null, 2),
          '```',
        ].join('\n'),
      }],
    }
  },

  brain_review_inbox_items(vault, args) {
    const result = vault.brainReviewInboxItems({
      itemIds: strings(args.item_ids) ?? [],
      status: args.status as 'open' | 'accepted' | 'rejected' | 'snoozed' | 'superseded',
      reason: args.reason as string | undefined,
      snoozedUntil: args.snoozed_until as string | undefined,
      dryRun: args.dry_run !== false,
    })
    const changes = result.changes.map(change => [
      `- \`${change.item.id}\`: ${change.previousStatus} -> ${change.nextStatus}`,
      change.snoozedUntil ? ` (bis ${change.snoozedUntil})` : '',
    ].join('')).join('\n')
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Knowledge Inbox Review Vorschau' : '# Knowledge Inbox Review gespeichert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Status: ${result.status}`,
          `Items: ${result.changes.length}`,
          `Summary: ${result.summary}`,
          '',
          changes,
        ].join('\n'),
      }],
    }
  },

  migrate_brain_metadata(vault, args) {
    const result = vault.migrateBrainMetadata({
      dryRun: args.dry_run !== false,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    })
    const lines = result.changed.slice(0, 40)
      .map(change => `- \`${change.path}\`: ${change.fields.join(', ')}`)
      .join('\n') || '- Keine Änderungen'
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Brain Metadata Migration Vorschau' : '# Brain Metadata Migration angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Gescannt: ${result.scanned}`,
          `Änderungen: ${result.changed.length}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  build_change_ledger(vault, args) {
    const result = vault.buildChangeLedger({
      dryRun: args.dry_run !== false,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Change Ledger Vorschau' : '# Change Ledger aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Einträge: ${result.entryCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  record_brain_feedback(vault, args) {
    const outcome = ['accepted', 'rejected', 'snoozed'].includes(String(args.outcome))
      ? args.outcome as 'accepted' | 'rejected' | 'snoozed'
      : 'snoozed'
    const result = vault.recordBrainFeedback({
      itemId: args.item_id as string,
      outcome,
      category: typeof args.category === 'string' ? args.category : undefined,
      reason: typeof args.reason === 'string' ? args.reason : undefined,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Brain Feedback Vorschau' : '# Brain Feedback gespeichert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Item: \`${result.entry.itemId}\``,
          `Outcome: ${result.entry.outcome}`,
          `Summary: accepted ${result.summary.accepted}, rejected ${result.summary.rejected}, snoozed ${result.summary.snoozed}`,
        ].join('\n'),
      }],
    }
  },

  brain_feedback_summary(vault) {
    const result = vault.brainFeedbackSummary()
    const categories = Object.entries(result.byCategory)
      .map(([category, counts]) => `- ${category}: accepted ${counts.accepted}, rejected ${counts.rejected}, snoozed ${counts.snoozed}`)
      .join('\n') || '- Keine Kategorien'
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Feedback Summary',
          '',
          `Total: ${result.total}`,
          `Accepted: ${result.accepted}`,
          `Rejected: ${result.rejected}`,
          `Snoozed: ${result.snoozed}`,
          '',
          categories,
        ].join('\n'),
      }],
    }
  },

  brain_calibration_review_batch(vault, args) {
    if (typeof args.reviewer !== 'string') {
      throw new Error('reviewer ist für den verblindeten MCP-Review erforderlich')
    }
    const result = vault.brainCalibrationReviewBatch({
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      reviewer: args.reviewer,
    })
    const items = result.items.map((item, index) => [
      `## ${index + 1}. ${item.reviewReference}`,
      '',
      item.statement,
      '',
      'Evidenz:',
      ...item.evidence.map(evidence =>
        `- \`${evidence.ref}\` · sha256 \`${evidence.hash}\`${evidence.excerpt ? ` · ${evidence.excerpt}` : ''}`),
      '',
      `Fehlende Labels: ${item.missingLabels.join(', ')}`,
      'record_calibration_judgement:',
      '```json',
      JSON.stringify(item.recordArgs, null, 2),
      '```',
    ].join('\n')).join('\n\n')
    const integrityErrors = result.integrity.errors.length > 0
      ? result.integrity.errors
        .map((error, index) => `- Integritätsfehler ${index + 1}: ${error.message}`)
        .join('\n')
      : '- keine'
    return {
      content: [{
        type: 'text',
        text: [
          '# Verblindeter Kalibrierungs-Review',
          '',
          `Protokoll: ${result.protocolVersion}`,
          `Reviewer: ${result.reviewer ?? '(globaler Labelstand)'}`,
          `Batch: ${result.items.length}; danach offen: ${result.remaining}`,
          '',
          '## Response Coverage',
          '',
          `Vollständig: ${result.coverage.completeUsefulSupported}/${result.coverage.sampledObservations}`,
          `Quote: ${
            result.coverage.overallRate === null
              ? 'n/a'
              : `${(result.coverage.overallRate * 100).toFixed(1)} %`
          }`,
          '',
          '## Integrität',
          '',
          `Captures gültig/ungültig: ${result.integrity.validCaptures}/${result.integrity.invalidCaptures}`,
          `Label-Dataset verfügbar: ${result.integrity.datasetAvailable}`,
          integrityErrors,
          '',
          ...result.instructions.map(instruction => `- ${instruction}`),
          '',
          items || 'Keine offenen verblindeten Beobachtungen.',
        ].join('\n'),
      }],
    }
  },

  record_calibration_judgement(vault, args) {
    const result = vault.recordCalibrationJudgement({
      reviewToken: args.review_token as string,
      useful: args.useful as boolean,
      supported: args.supported as boolean,
      reviewer: args.reviewer as string,
      recordedAt: args.recorded_at as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun
            ? '# Atomare Kalibrierungsbewertung – Vorschau'
            : '# Atomare Kalibrierungsbewertung gespeichert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Operation: ${result.operation}`,
          `useful: ${result.labels.useful}`,
          `supported: ${result.labels.supported}`,
          `Reviewer: ${result.reviewer}`,
          '',
          'Das vollständige Urteil ist nach dem Anwenden unveränderlich; die Antwort enthält keine Produktions- oder Modelldiagnosen.',
        ].join('\n'),
      }],
    }
  },

  record_calibration_label(vault, args) {
    const result = vault.recordCalibrationLabel({
      reviewToken: args.review_token as string,
      label: args.label as BrainCalibrationLabel,
      value: args.value as boolean,
      reviewer: args.reviewer as string,
      recordedAt: args.recorded_at as string,
      observedAt: typeof args.observed_at === 'string' ? args.observed_at : undefined,
      validityClass: args.validity_class as RecordCalibrationLabelOptions['validityClass'],
      clientId: typeof args.client_id === 'string' ? args.client_id : undefined,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Kalibrierungslabel Vorschau' : '# Kalibrierungslabel gespeichert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Operation: ${result.operation}`,
          `Label: ${result.entry.label}=${result.entry.value}`,
          `Reviewer: ${result.entry.reviewer}`,
          `Pfad: \`${result.path}\``,
          '',
          'Keine aggregierten Label- oder Modelldiagnosen werden an die Reviewer-Rolle zurückgegeben.',
        ].join('\n'),
      }],
    }
  },

  brain_calibration_summary(vault) {
    const result = vault.brainCalibrationSummary()
    const labels = Object.entries(result.byLabel)
      .map(([label, summary]) =>
        `- ${label}: true ${summary.true}, false ${summary.false}, n=${summary.labeled}, Jeffreys-Mittel ${summary.jeffreysPosteriorMean.toFixed(3)}`)
      .join('\n')
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Calibration Summary',
          '',
          `Einträge: ${result.totalEntries}`,
          `Eindeutige Targets: ${result.uniqueTargets}`,
          `Eindeutige Beobachtungen: ${result.uniqueObservations}`,
          `Semantische Fakten: ${result.uniqueFacts}`,
          '',
          labels,
          '',
          'Die Posterior-Mittel sind reine Datendiagnostik und ändern keine Automationsregeln.',
        ].join('\n'),
      }],
    }
  },

  brain_calibration_evaluate(vault, args) {
    const result = vault.evaluateBrainCalibration({
      label: args.label as 'useful' | 'supported' | 'all' | undefined,
      groupBy: args.group_by as 'session' | 'project' | undefined,
      bootstrapSamples: typeof args.bootstrap_samples === 'number'
        ? args.bootstrap_samples
        : undefined,
    })
    const reports = renderBrainCalibrationReports(result)
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Calibration Shadow Evaluation',
          '',
          `Version: ${result.evaluationVersion}`,
          `Run: \`${result.runId}\``,
          `Aktive Gewichte geändert: ${result.activeWeightsChanged}`,
          `Release-Entscheidung erlaubt: ${result.releaseDecisionAllowed}`,
          '',
          reports,
          result.stillValid
            ? `\n## still_valid\n\nStatus: ${result.stillValid.status}; ${result.stillValid.reason}`
            : '',
          '',
          'Methodische Grenzen:',
          ...result.limitations.map(limitation => `- ${limitation}`),
          '',
          'Die Ausgabe enthält ausschließlich aggregierte Metriken und ändert weder Modell, Policy noch Release-Status.',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  brain_calibration_register_campaign(vault, args) {
    const result = vault.registerBrainCalibrationCampaign({
      campaignId: args.campaign_id as string,
      reviewers: strings(args.reviewers) ?? [],
      groupBy: (args.group_by ?? 'project') as 'session' | 'project',
      bootstrapSamples: typeof args.bootstrap_samples === 'number'
        ? args.bootstrap_samples
        : undefined,
      expectedRegistrationRoot: typeof args.expected_registration_root === 'string'
        ? args.expected_registration_root
        : undefined,
      expectedRegisteredAt: typeof args.expected_registered_at === 'string'
        ? args.expected_registered_at
        : undefined,
      dryRun: args.dry_run !== false,
    })
    const campaign = result.artifact
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun
            ? '# Kampagnen-Registrierung – Vorschau'
            : '# Kampagne irreversibel registriert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Operation: ${result.operation}`,
          `Externer Anchor: ${result.externalAnchor}`,
          `Campaign: \`${campaign.campaignId}\``,
          `Registration-Root: \`${campaign.registrationRoot}\``,
          `Registrierungszeit: \`${campaign.registeredAt}\``,
          `Reviewer-Anzahl: ${campaign.reviewers.length}`,
          `Eingefrorene Targets: ${campaign.frame.targets.length}`,
          `Capture-Bundles: ${campaign.captureArchives.length}`,
          `Gruppierung: ${campaign.plan.groupBy}`,
          `Fester Cutoff: ${campaign.plan.cutoffAt ?? 'n/a'}`,
          `Bootstrap-Samples: ${campaign.plan.bootstrapSamples}`,
          `Gebundene Implementierungsdateien: ${campaign.plan.sourceBindings.length}`,
          `Node/V8: ${campaign.plan.runtime.node} / ${campaign.plan.runtime.v8}`,
          'Assurance: externe Append-only/WORM-Retention und vertrauenswürdiger Host sind Voraussetzungen; Reviewer-IDs sind prozessgebundene Pseudonyme, keine digitalen Signaturen.',
          '',
          result.dryRun
            ? 'Noch wurde nichts versiegelt. Prüfe Plan und Zählwerte und wiederhole mit dry_run=false, expected_registration_root und expected_registered_at exakt aus dieser Vorschau.'
            : 'Der Enrollment-Frame ist jetzt eingefroren. Reviewer erhalten ausschließlich das registrierte Blind-Review-Archiv.',
        ].join('\n'),
      }],
    }
  },

  brain_calibration_close_campaign(vault, args) {
    const result = vault.closeBrainCalibrationCampaign({
      dryRun: args.dry_run !== false,
    })
    const closure = result.artifact
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun
            ? '# Kampagnen-Closure – Vorschau'
            : '# Kampagnendaten irreversibel geschlossen',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Operation: ${result.operation}`,
          `Externer Anchor: ${result.externalAnchor}`,
          `Campaign: \`${closure.campaignId}\``,
          `Registration-Root: \`${closure.registrationRoot}\``,
          `Closure-Root: \`${closure.closureRoot}\``,
          `Eingefrorene Label-Einträge: ${closure.entries.length}`,
          '',
          result.dryRun
            ? 'Noch wurde keine Closure geschrieben. Eine unvollständige Reviewer-Matrix wird fail-closed abgewiesen.'
            : 'Die exakten Label-Ereignisse sind geschlossen. Es sind nur noch identische Review-Retries und die versiegelte Evaluation zulässig.',
        ].join('\n'),
      }],
    }
  },

  brain_calibration_evaluate_sealed(vault, args) {
    if (args.confirm !== true) {
      throw new Error('confirm muss für die irreversible versiegelte Evaluation true sein')
    }
    const result = vault.evaluateSealedBrainCalibrationCampaign({ confirm: true })
    const sealed = result.artifact
    const evaluation = sealed.evaluation
    return {
      content: [{
        type: 'text',
        text: [
          '# Versiegelte Brain-Calibration-Evaluation',
          '',
          `Operation: ${result.operation}`,
          `Externer Anchor: ${result.externalAnchor}`,
          `Campaign: \`${sealed.campaignId}\``,
          `Result-Root: \`${sealed.resultRoot}\``,
          `Version: ${evaluation.evaluationVersion}`,
          `Run: \`${evaluation.runId}\``,
          `Aktive Gewichte geändert: ${evaluation.activeWeightsChanged}`,
          `Release-Entscheidung erlaubt: ${evaluation.releaseDecisionAllowed}`,
          '',
          renderBrainCalibrationReports(evaluation),
          evaluation.stillValid
            ? `\n## still_valid\n\nStatus: ${evaluation.stillValid.status}; ${evaluation.stillValid.reason}`
            : '',
          '',
          'Methodische Grenzen:',
          ...evaluation.limitations.map(limitation => `- ${limitation}`),
          '- Die Receipt-Kette ist nur bei unabhängig erzwungener Append-only/WORM-Retention irreversibel.',
          '- Reviewer-IDs sind prozessgebundene Pseudonyme ohne kryptografische Personensignatur.',
          '- Source-/Runtime-Hashes prüfen Reproduzierbarkeit und Disk-Drift, attestieren aber keinen kompromittierten Hostprozess.',
          '',
          'Das Ergebnis wurde vor dieser Ausgabe lokal gespeichert und extern verkettet. Ein identischer Retry liefert exakt denselben Receipt.',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  build_memory_timeline(vault, args) {
    const result = vault.buildMemoryTimeline({
      client: args.client as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Memory Timeline Vorschau' : '# Memory Timeline aktualisiert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Client: ${result.client}`,
          `Pfad: \`${result.path}\``,
          `Events: ${result.eventCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  brain_schedule(vault, args) {
    const result = vault.proposeBrainSchedule({
      horizonDays: typeof args.horizon_days === 'number' ? args.horizon_days : undefined,
    })
    const lines = result.items.map(item => [
      `- **${item.priority}** \`${item.id}\` (${item.due})`,
      `  ${item.title}`,
      `  Grund: ${item.reason}`,
      `  Tool: ${item.suggestedTool}`,
    ].join('\n')).join('\n\n') || 'Keine geplanten Vorschläge.'
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Schedule',
          '',
          `Generated: ${result.generatedAt}`,
          `Horizon: ${result.horizonDays} Tage`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  brain_auto_build(vault, args) {
    if (!loadBrainPolicy().automation.duringSession.allowManualAutoBuildTool) {
      throw new Error('Manueller brain_auto_build-Aufruf ist laut Policy deaktiviert')
    }
    const result = vault.brainAutoBuild({
      sourcePath: typeof args.source_path === 'string' ? args.source_path : undefined,
      client: typeof args.client === 'string' ? args.client : undefined,
      maxClaims: typeof args.max_claims === 'number' ? args.max_claims : undefined,
      dryRun: typeof args.dry_run === 'boolean' ? args.dry_run : undefined,
    })
    const lines = result.steps.map(step =>
      `- \`${step.step}\`: ${step.skipped ? 'skipped' : step.applied ? 'applied' : 'preview'} - ${step.summary}`,
    ).join('\n') || '- Keine Schritte'
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Brain Auto-Build Vorschau' : '# Brain Auto-Build ausgeführt',
          '',
          `Mode: ${result.mode}`,
          `Dry-Run: ${result.dryRun}`,
          `Quelle: ${result.sourcePath ?? '(keine)'}`,
          `Client: ${result.client ?? '(keiner)'}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  archive_auto_build_run(vault, args) {
    const result = vault.archiveAutoBuildRun({
      sourcePath: args.source_path as string,
      dryRun: args.dry_run !== false,
    })
    const archived = result.archived.map(item => `- \`${item.from}\` -> \`${item.to}\``).join('\n') || '- Keine Artefakte'
    const skipped = result.skipped.map(item => `- \`${item.path}\`: ${item.reason}`).join('\n') || '- Keine Skips'
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Auto-Build Archiv Vorschau' : '# Auto-Build Artefakte archiviert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Quelle: \`${result.sourcePath}\``,
          `Archiv: \`${result.archiveFolder}\``,
          '',
          '## Archiviert',
          archived,
          '',
          '## Übersprungen',
          skipped,
        ].join('\n'),
      }],
    }
  },

  build_customer_snapshot(vault, args) {
    const result = vault.buildCustomerSnapshot({
      client: args.client as string,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Customer Snapshot Vorschau' : '# Customer Snapshot aktualisiert',
          '',
          `Client: ${result.client}`,
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          `Notizen: ${result.noteCount}`,
          `TODOs: ${result.todoCount}`,
          `Entscheidungen: ${result.decisionCount}`,
          `Risiken: ${result.riskCount}`,
          `Runbooks: ${result.runbookCount}`,
          `Offene Fragen: ${result.questionCount}`,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  brain_metrics(vault) {
    const metrics = vault.brainMetrics()
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Metrics',
          '',
          `Notes: ${metrics.notes}`,
          `Auto-Captures: ${metrics.autoCaptures}`,
          `Auto-promoted: ${metrics.autoPromoted}`,
          `Claims: ${metrics.claims}`,
          `Evidence candidates: ${metrics.evidenceCandidates}`,
          `Evidence issues: ${metrics.evidenceIssues}`,
          `Open questions: ${metrics.openQuestions}`,
          `Contradictions: ${metrics.contradictions}`,
          `Feedback: accepted ${metrics.feedback.accepted}, rejected ${metrics.feedback.rejected}, snoozed ${metrics.feedback.snoozed}`,
          `Auto-build processed sources: ${metrics.autoBuild.processedSources}`,
          `Auto-build archived sources: ${metrics.autoBuild.archivedSources}`,
          `Auto-build usefulness score: ${metrics.autoBuild.usefulnessScore.toFixed(2)}`,
          `Auto-build learned categories: ${metrics.autoBuild.learnedCategories}`,
        ].join('\n'),
      }],
    }
  },

  brain_health_check(vault, args) {
    const result = vault.brainHealthCheck({
      checkHooks: typeof args.check_hooks === 'boolean' ? args.check_hooks : undefined,
    })
    const lines = result.checks.map(check =>
      `- **${check.status}** \`${check.id}\`: ${check.message}`,
    ).join('\n')
    const next = result.nextActions.length > 0
      ? result.nextActions.map(action => `- ${action}`).join('\n')
      : '- Keine unmittelbaren Aktionen'
    return {
      content: [{
        type: 'text',
        text: [
          '# Brain Health Check',
          '',
          `Status: ${result.status}`,
          `Vault: \`${result.vaultPath}\``,
          `Checks: ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`,
          '',
          '## Checks',
          lines,
          '',
          '## Nächste Aktionen',
          next,
        ].join('\n'),
      }],
    }
  },

  brain_run_background(vault, args) {
    const result = vault.runBackgroundBrain({
      dryRun: args.dry_run !== false,
      jobs: strings(args.jobs),
      maxRuntimeMs: typeof args.max_runtime_ms === 'number' ? args.max_runtime_ms : undefined,
      maxJobRuntimeMs: typeof args.max_job_runtime_ms === 'number' ? args.max_job_runtime_ms : undefined,
      lockPath: typeof args.lock_path === 'string' ? args.lock_path : undefined,
      settingsPath: typeof args.settings_path === 'string' ? args.settings_path : undefined,
      client: typeof args.client === 'string' ? args.client : undefined,
      sourcePath: typeof args.source_path === 'string' ? args.source_path : undefined,
      runAutoBuild: args.run_auto_build === true,
      maxAutoBuildSources: typeof args.max_auto_build_sources === 'number' ? args.max_auto_build_sources : undefined,
    })
    const jobs = result.jobs.map(job => `- **${job.status}** \`${job.id}\`: ${job.summary}`).join('\n')
    const next = result.nextActions.length > 0
      ? result.nextActions.map(action => `- ${action}`).join('\n')
      : '- Keine unmittelbaren Aktionen'
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Background Run Vorschau' : '# Background Run ausgeführt',
          '',
          `Status: ${result.status}`,
          `Dry-Run: ${result.dryRun}`,
          `Dauer: ${result.durationMs} ms`,
          `Report: \`${result.reportPath}\``,
          `JSON: \`${result.jsonPath}\``,
          '',
          '## Jobs',
          jobs || '- Keine Jobs',
          '',
          '## Nächste Aktionen',
          next,
          '',
          result.content,
        ].join('\n'),
      }],
    }
  },

  brain_checkpoint(vault, args) {
    const result = vault.brainCheckpoint({
      title: typeof args.title === 'string' ? args.title : undefined,
      summary: args.summary as string,
      client: typeof args.client === 'string' ? args.client : undefined,
      sourcePath: typeof args.source_path === 'string' ? args.source_path : undefined,
      runAutoBuild: args.run_auto_build === true,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Brain Checkpoint Vorschau' : '# Brain Checkpoint gespeichert',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Pfad: \`${result.path}\``,
          result.autoBuild ? `Auto-Build: ${JSON.stringify(result.autoBuild, null, 2)}` : '',
          '',
          result.content,
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  daily_note(vault, args) {
    const result = vault.dailyNote(args.append as string | undefined)

    const action = result.created ? 'Erstellt' : args.append ? 'Ergänzt' : 'Geladen'
    return {
      content: [
        {
          type: 'text',
          text: `Daily Note ${action}: ${result.path}\n\n${result.content}`,
        },
      ],
    }
  },

  generate_runbook(vault, args) {
    const result = vault.generateRunbook(args.topic as string, {
      outputFolder: args.folder as string | undefined,
      dryRun: args.dry_run !== false,
    })

    return {
      content: [
        {
          type: 'text',
          text: [
            result.dryRun ? '# Runbook Vorschau' : '# Runbook erstellt',
            '',
            `Pfad: **${result.path}**`,
            `Dry-Run: ${result.dryRun}`,
            `Quellen: ${result.sourceCount} Notizen`,
            `Schritte: ${result.stepCount}`,
            `Bekannte Probleme: ${result.fixCount}`,
            '',
            result.dryRun ? result.content : '',
          ].filter(Boolean).join('\n'),
        },
      ],
    }
  },

  extract_troubleshooting_pattern(vault, args) {
    const result = vault.extractTroubleshootingPattern(args.path as string)
    return {
      content: [{
        type: 'text',
        text: result.patternMarkdown,
      }],
    }
  },

  promote_capture_to_runbook(vault, args) {
    const result = vault.promoteCaptureToRunbook({
      path: args.path as string,
      outputFolder: typeof args.folder === 'string' ? args.folder : undefined,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Runbook Promotion Vorschau' : '# Runbook Promotion angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Quelle: \`${result.source}\``,
          `Ziel: \`${result.path}\``,
          `Schritte: ${result.stepCount}`,
          `Fixes: ${result.fixCount}`,
          '',
          result.dryRun ? '## Vorschau' : '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  generate_postmortem(vault, args) {
    const result = vault.generatePostmortem({
      path: args.path as string,
      outputFolder: typeof args.folder === 'string' ? args.folder : undefined,
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Postmortem Vorschau' : '# Postmortem erstellt',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Quelle: \`${result.source}\``,
          `Ziel: \`${result.path}\``,
          '',
          result.dryRun ? '## Vorschau' : '',
          result.dryRun ? result.content : '',
        ].filter(Boolean).join('\n'),
      }],
    }
  },

  build_customer_context(vault, args) {
    return renderCustomerDashboard(vault, args.client as string, args)
  },

  build_project_dashboard(vault, args) {
    if (args.dry_run === false) assertCanWriteTool('build_project_dashboard')
    return renderCustomerDashboard(vault, args.project as string, args)
  },

  organize_referenz(vault, args) {
    const dryRun = args.dry_run !== false
    const result = vault.organizeReferenz(dryRun)

    const movedText = result.moved.length > 0
      ? result.moved.map(m => `- \`${m.from}\` → \`${m.to}\` [${m.category}] (${m.reason})`).join('\n')
      : '  (keine)'

    const skippedText = result.skipped.length > 0
      ? result.skipped.map(s => `- \`${s.path}\`: ${s.reason}`).join('\n')
      : '  (keine)'

    const header = dryRun
      ? `## Vorschau (Dry Run — noch nichts verschoben)\n`
      : `## Verschoben\n`

    return {
      content: [{
        type: 'text',
        text: [
          header,
          `**${result.moved.length}** Notizen ${dryRun ? 'würden verschoben' : 'verschoben'}:`,
          movedText,
          ``,
          `**${result.skipped.length}** übersprungen:`,
          skippedText,
        ].join('\n'),
      }],
    }
  },

  list_suggestions() {
    const all = listSuggestions()
    if (all.technik.length === 0 && all.clients.length === 0) {
      return { content: [{ type: 'text', text: 'Keine Vorschläge. Der Harvester hat noch keine Kandidaten geloggt.' }] }
    }

    const sections: string[] = ['# Pending Suggestions']
    if (all.clients.length > 0) {
      const lines = all.clients.map(s =>
        `- **${s.candidate}** (${s.count}× gesehen, zuletzt ${s.lastSeen.slice(0, 10)})\n` +
        `  Pfade: ${s.contexts.slice(0, 3).join(', ')}`,
      ).join('\n\n')
      sections.push(`\n## Kunden (${all.clients.length})\n\n${lines}`)
    }
    if (all.technik.length > 0) {
      const lines = all.technik.map(s =>
        `- **${s.candidate}** unter _${s.parent}_ (${s.count}× gesehen, zuletzt ${s.lastSeen.slice(0, 10)})\n` +
        `  Kontext: ${s.contexts.slice(0, 3).join(' | ')}`,
      ).join('\n\n')
      sections.push(`\n## Technik-Unterkategorien (${all.technik.length})\n\n${lines}`)
    }
    sections.push(`\n---\n**Übernehmen mit:** \`promote_suggestion\` — type, candidate (+ parent für technik).`)

    return { content: [{ type: 'text', text: sections.join('\n') }] }
  },

  promote_suggestion(vault, args) {
    const type = args.type as string
    const candidate = args.candidate as string
    const canonical = args.canonical as string | undefined
    const keywords = (args.keywords as string[] | undefined) ?? []
    const dryRun = args.dry_run !== false

    if (type === 'technik') {
      const parent = args.parent as string
      if (!parent) {
        return { content: [{ type: 'text', text: 'Fehler: parent muss angegeben sein für type=technik' }], isError: true }
      }
      const result = promoteTechnikSuggestion(parent, candidate, canonical, keywords, [], { dryRun })
      const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
      if (!dryRun) {
        appendActionLog(vault.vaultPath, {
          tool: 'promote_suggestion',
          mode: 'apply',
          targets: [result.path],
          summary: `Technik-Suggestion übernommen: ${result.category}/${result.subcategory}`,
          meta: { type, candidate, canonical: result.subcategory, existed: result.existed },
        })
      }
      return {
        content: [{
          type: 'text',
          text: `${dryRun ? 'Vorschau: ' : ''}Technik-Unterkategorie **${result.category}/${result.subcategory}** ${dryRun ? 'würde übernommen' : 'übernommen'}${existedNote}.\n\nDry-Run: ${dryRun}\nKonfiguration: ${result.path}\n\nTipp: Lauf \`organize_referenz\` als separaten Dry-Run, um bestehende Notes zu prüfen.`,
        }],
      }
    } else if (type === 'client') {
      const result = promoteClientSuggestion(candidate, canonical, keywords, { dryRun })
      const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
      if (!dryRun) {
        appendActionLog(vault.vaultPath, {
          tool: 'promote_suggestion',
          mode: 'apply',
          targets: [result.path],
          summary: `Client-Suggestion übernommen: ${result.name}`,
          meta: { type, candidate, canonical: result.name, existed: result.existed },
        })
      }
      return {
        content: [{
          type: 'text',
          text: `${dryRun ? 'Vorschau: ' : ''}Kunde **${result.name}** ${dryRun ? 'würde übernommen' : 'übernommen'}${existedNote}.\n\nDry-Run: ${dryRun}\nKonfiguration: ${result.path}\n\nNach Anwendung werden passende Captures ab der nächsten Session nach \`Kunden/${result.name}/\` einsortiert.`,
        }],
      }
    } else {
      return { content: [{ type: 'text', text: `Unbekannter type: ${type}. Erlaubt: technik, client` }], isError: true }
    }
  },
}

function renderCustomerDashboard(vault: Parameters<ToolHandlerRegistry[string]>[0], client: string, args: Record<string, unknown>) {
  const dryRun = args.dry_run !== false
  const result = vault.buildCustomerDashboard(client, { dryRun })
  const header = dryRun
    ? `# Customer-Dashboard Vorschau: ${result.client}`
    : `# Customer-Dashboard erstellt: ${result.client}`
  const preview = result.content.length > 2500
    ? `${result.content.slice(0, 2500)}\n\n...`
    : result.content

  return {
    content: [{
      type: 'text' as const,
      text: [
        header,
        ``,
        `Pfad: **${result.path}**`,
        `Notizen: ${result.noteCount}`,
        `Offene TODOs: ${result.todoCount}`,
        `Runbooks: ${result.runbookCount}`,
        `Auto-Captures: ${result.captureCount}`,
        `Issues: ${result.issueCount}`,
        ``,
        dryRun ? `## Vorschau` : `Details: Dashboard wurde geschrieben und indexiert.`,
        dryRun ? preview : '',
      ].filter(Boolean).join('\n'),
    }],
  }
}
