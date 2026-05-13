import { listSuggestions, promoteClientSuggestion, promoteTechnikSuggestion } from '../suggestions.ts'
import type { SaveKnowledgeResult } from '../vault.ts'
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
      lockPath: typeof args.lock_path === 'string' ? args.lock_path : undefined,
      settingsPath: typeof args.settings_path === 'string' ? args.settings_path : undefined,
      client: typeof args.client === 'string' ? args.client : undefined,
      sourcePath: typeof args.source_path === 'string' ? args.source_path : undefined,
      runAutoBuild: args.run_auto_build === true,
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
    return renderCustomerDashboard(vault, args.project as string, args)
  },

  organize_referenz(vault, args) {
    const dryRun = args.dry_run === true
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

  promote_suggestion(_vault, args) {
    const type = args.type as string
    const candidate = args.candidate as string
    const canonical = args.canonical as string | undefined
    const keywords = (args.keywords as string[] | undefined) ?? []

    if (type === 'technik') {
      const parent = args.parent as string
      if (!parent) {
        return { content: [{ type: 'text', text: 'Fehler: parent muss angegeben sein für type=technik' }], isError: true }
      }
      const result = promoteTechnikSuggestion(parent, candidate, canonical, keywords)
      const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
      return {
        content: [{
          type: 'text',
          text: `Technik-Unterkategorie **${result.category}/${result.subcategory}** übernommen${existedNote}.\n\nKonfiguration: ${result.path}\n\nTipp: Lauf \`organize_referenz\` um bestehende Notes jetzt sofort in die neue Unterkategorie zu sortieren.`,
        }],
      }
    } else if (type === 'client') {
      const result = promoteClientSuggestion(candidate, canonical, keywords)
      const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
      return {
        content: [{
          type: 'text',
          text: `Kunde **${result.name}** übernommen${existedNote}.\n\nKonfiguration: ${result.path}\n\nAb der nächsten Session werden Captures mit diesem Namen nach \`Kunden/${result.name}/\` einsortiert.`,
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
