import { listSuggestions, promoteClientSuggestion, promoteTechnikSuggestion } from '../suggestions.ts'
import type { SaveKnowledgeResult } from '../vault.ts'
import { strings, type ToolHandlerRegistry } from './types.ts'

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
      dryRun: args.dry_run !== false,
    }))
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
    const result = vault.generateRunbook(
      args.topic as string,
      args.folder as string | undefined,
    )

    return {
      content: [
        {
          type: 'text',
          text: [
            `Runbook erstellt: **${result.path}**`,
            `Quellen: ${result.sourceCount} Notizen`,
            `Schritte: ${result.stepCount}`,
            `Bekannte Probleme: ${result.fixCount}`,
          ].join('\n'),
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
