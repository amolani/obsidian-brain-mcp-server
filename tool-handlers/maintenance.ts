import type { LintIssue } from '../vault.ts'
import type { ToolHandlerRegistry } from './types.ts'
import { confidence, strings } from './types.ts'

export const maintenanceHandlers: ToolHandlerRegistry = {
  run_vault_maintenance(vault) {
    const report = vault.runMaintenance()
    const text = [
      `# Vault-Maintenance durchgelaufen`,
      ``,
      `Report: **${report.reportPath}**`,
      ``,
      `| Bereich | Anzahl | Auto-fixbar |`,
      `|---------|--------|-------------|`,
      `| Duplikate (high / med / low) | ${report.duplicates.high} / ${report.duplicates.medium} / ${report.duplicates.low} | — |`,
      `| Kaputte Links | ${report.brokenLinks.total} | ${report.brokenLinks.autoFixable} |`,
      `| Frontmatter-Issues | ${report.lintIssues.total} | ${report.lintIssues.autoFixable} |`,
      `| Fehlende MOCs | ${report.mocs.missing} | alle |`,
      `| Qualität Ø | ${report.quality.averageScore} | — |`,
      `| Qualität (poor/fair/good/excellent) | ${report.quality.poor} / ${report.quality.fair} / ${report.quality.good} / ${report.quality.excellent} | — |`,
      `| Stale Notes | ${report.staleNotes} | — |`,
      `| Verwaiste Notes | ${report.orphanNotes} | — |`,
      ``,
      `Details: siehe ${report.reportPath} in Obsidian.`,
    ].join('\n')
    return { content: [{ type: 'text', text }] }
  },

  run_safe_maintenance(vault, args) {
    const allowedSteps = new Set(['frontmatter', 'broken_links', 'link_suggestions', 'lifecycle', 'mocs', 'semantic_index'])
    const steps = Array.isArray(args.steps)
      ? args.steps.filter((s): s is 'frontmatter' | 'broken_links' | 'link_suggestions' | 'lifecycle' | 'mocs' | 'semantic_index' =>
        typeof s === 'string' && allowedSteps.has(s),
      )
      : undefined
    const result = vault.runSafeMaintenance({
      dryRun: args.dry_run !== false,
      steps,
      minLinkConfidence: typeof args.min_link_confidence === 'number' ? args.min_link_confidence : undefined,
      minLifecycleConfidence: confidence(args.min_lifecycle_confidence),
      mocMinNotes: typeof args.moc_min_notes === 'number' ? args.moc_min_notes : undefined,
    })
    const lines = result.steps.map(step =>
      `- \`${step.step}\`: ${step.changed} Änderung(en), ${step.skipped} übersprungen — ${step.summary}`,
    ).join('\n')

    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Safe Maintenance Vorschau' : '# Safe Maintenance angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Total changed: ${result.totalChanged}`,
          `Total skipped: ${result.totalSkipped}`,
          '',
          lines,
        ].join('\n'),
      }],
    }
  },

  score_note_quality(vault, args) {
    const result = vault.scoreNoteQuality(args.path as string)
    if (!result) {
      return { content: [{ type: 'text', text: `Note nicht gefunden: ${args.path}` }], isError: true }
    }

    const dimensions = Object.entries(result.dimensions)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, score]) => `- ${name}: ${score}`)
      .join('\n')
    const issues = result.issues.length > 0
      ? result.issues.slice(0, 12).map(i => `- [${i.severity}] ${i.dimension}: ${i.message} → ${i.suggestion}`).join('\n')
      : 'Keine relevanten Issues.'

    return {
      content: [{
        type: 'text',
        text: [
          `# Qualität: ${result.title}`,
          ``,
          `Pfad: \`${result.path}\``,
          `Score: **${result.score}/100** (${result.grade})`,
          ``,
          `## Dimensionen`,
          dimensions,
          ``,
          `## Issues`,
          issues,
        ].join('\n'),
      }],
    }
  },

  list_low_quality_notes(vault, args) {
    const maxScore = typeof args.max_score === 'number' ? args.max_score : 69
    const results = vault.listLowQualityNotes(maxScore)
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `Keine Notes mit Score <= ${maxScore} gefunden.` }] }
    }

    const lines = results.slice(0, 30).map(r => {
      const topIssue = r.issues[0] ? ` — ${r.issues[0].dimension}: ${r.issues[0].message}` : ''
      return `- **${r.score}** (${r.grade}) \`${r.path}\`${topIssue}`
    })

    return {
      content: [{
        type: 'text',
        text: [
          `# Low-Quality Notes`,
          ``,
          `${results.length} Notes mit Score <= ${maxScore}.`,
          ``,
          lines.join('\n'),
        ].join('\n'),
      }],
    }
  },

  suggest_lifecycle_updates(vault, args) {
    const suggestions = vault.suggestLifecycleUpdates({
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      maxResults: typeof args.max_results === 'number' ? args.max_results : undefined,
      includeGenerated: args.include_generated === true,
    })
    if (suggestions.length === 0) {
      return { content: [{ type: 'text', text: 'Keine Lifecycle-Vorschläge gefunden.' }] }
    }

    const lines = suggestions.slice(0, 50).map(s => [
      `- **${s.confidence}** \`${s.path}\`: ${s.currentStatus ?? '(kein status)'} → ${s.recommendedStatus}`,
      `  Aktion: ${s.action}; Alter: ${s.daysSinceModified} Tage; Qualität: ${s.qualityScore ?? 'n/a'}`,
      `  Gründe: ${s.reasons.join('; ')}`,
      s.blockedBy.length > 0 ? `  Blockiert: ${s.blockedBy.join(', ')}` : '',
    ].filter(Boolean).join('\n'))

    return {
      content: [{
        type: 'text',
        text: [
          '# Lifecycle-Vorschläge',
          '',
          `${suggestions.length} Vorschlag/Vorschläge gefunden.`,
          '',
          lines.join('\n\n'),
        ].join('\n'),
      }],
    }
  },

  apply_lifecycle_updates(vault, args) {
    const result = vault.applyLifecycleUpdates({
      dryRun: args.dry_run !== false,
      paths: strings(args.paths),
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      minConfidence: confidence(args.min_confidence),
      recommendedStatus: typeof args.recommended_status === 'string' ? args.recommended_status : undefined,
      maxResults: typeof args.max_results === 'number' ? args.max_results : undefined,
    })
    const updated = result.updated.length > 0
      ? result.updated.map(u => `- \`${u.path}\`: ${u.beforeStatus ?? '(kein status)'} → ${u.afterStatus} (${u.confidence})`).join('\n')
      : '  (keine)'
    const skipped = result.skipped.length > 0
      ? result.skipped.map(s => `- \`${s.path}\`: ${s.reason}`).join('\n')
      : '  (keine)'

    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Lifecycle-Updates Vorschau' : '# Lifecycle-Updates angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          '',
          '## Updates',
          updated,
          '',
          '## Übersprungen',
          skipped,
        ].join('\n'),
      }],
    }
  },

  generate_mocs(vault, args) {
    const dryRun = args.dry_run === true
    const minNotes = typeof args.min_notes === 'number' ? args.min_notes : 2
    const results = vault.generateMocs(dryRun, minNotes)

    const byAction = {
      created: results.filter(r => r.action === 'created'),
      updated: results.filter(r => r.action === 'updated'),
      skipped: results.filter(r => r.action === 'skipped'),
    }

    const renderGroup = (label: string, items: typeof results) => {
      if (items.length === 0) return ''
      const lines = items.map(r => {
        const reason = r.reason ? ` — ${r.reason}` : ''
        return `- \`${r.path}\` (${r.noteCount} Notiz${r.noteCount !== 1 ? 'en' : ''}${r.subfolders.length ? `, ${r.subfolders.length} Unterkategorien` : ''})${reason}`
      })
      return `### ${label} (${items.length})\n${lines.join('\n')}`
    }

    const header = dryRun
      ? `## Vorschau (Dry Run — nichts geschrieben)`
      : `## MOCs generiert`

    return {
      content: [{
        type: 'text',
        text: [
          header,
          ``,
          renderGroup('Erstellt', byAction.created),
          renderGroup('Aktualisiert', byAction.updated),
          renderGroup('Übersprungen', byAction.skipped),
        ].filter(Boolean).join('\n\n'),
      }],
    }
  },

  lint_frontmatter(vault) {
    const issues = vault.lintFrontmatter()
    if (issues.length === 0) {
      return { content: [{ type: 'text', text: 'Frontmatter ist sauber. ✓' }] }
    }

    const bySeverity = {
      error: issues.filter(i => i.severity === 'error'),
      warning: issues.filter(i => i.severity === 'warning'),
      info: issues.filter(i => i.severity === 'info'),
    }

    const renderGroup = (label: string, icon: string, items: LintIssue[]) => {
      if (items.length === 0) return ''
      const lines = items.slice(0, 30).map(i =>
        `- **${i.path}** [${i.field}]: ${i.issue}\n  → ${i.suggestion}${i.autoFixable ? ' *(auto-fixbar)*' : ''}`,
      )
      const extra = items.length > 30 ? `\n*...und ${items.length - 30} weitere*` : ''
      return `## ${icon} ${label} (${items.length})\n\n${lines.join('\n\n')}${extra}`
    }

    const autoFixCount = issues.filter(i => i.autoFixable).length
    const sections = [
      `# Frontmatter-Lint`,
      `${issues.length} Issues gefunden, ${autoFixCount} davon auto-fixbar.`,
      renderGroup('Errors', '🔴', bySeverity.error),
      renderGroup('Warnings', '🟡', bySeverity.warning),
      renderGroup('Info', '🔵', bySeverity.info),
    ].filter(Boolean).join('\n\n')

    return { content: [{ type: 'text', text: sections }] }
  },

  fix_frontmatter(vault, args) {
    const dryRun = args.dry_run !== false
    const result = vault.fixFrontmatter(dryRun)

    const fixedText = result.fixed.length > 0
      ? result.fixed.map(f => `- **${f.path}**\n  ${f.changes.join('\n  ')}`).join('\n\n')
      : '  (nichts zu tun)'

    const header = dryRun
      ? `## Vorschau (Dry Run)\n\n**Nichts geändert.**`
      : `## Angewendet\n\n**${result.fixed.length}** Notizen korrigiert.`

    return {
      content: [{
        type: 'text',
        text: [header, ``, `### Fixes (${result.fixed.length})`, fixedText].join('\n'),
      }],
    }
  },

  find_duplicates(vault, args) {
    const minScore = typeof args.min_score === 'number' ? args.min_score : 40
    const candidates = vault.findDuplicates(minScore)

    if (candidates.length === 0) {
      return { content: [{ type: 'text', text: `Keine Duplikate gefunden (min_score=${minScore}).` }] }
    }

    const byConfidence = {
      high: candidates.filter(c => c.confidence === 'high'),
      medium: candidates.filter(c => c.confidence === 'medium'),
      low: candidates.filter(c => c.confidence === 'low'),
    }

    const renderGroup = (label: string, icon: string, items: typeof candidates) => {
      if (items.length === 0) return ''
      const lines = items.map(c =>
        `- **${c.titleA}** vs **${c.titleB}** (Score ${c.score}, ${c.suggestion})\n` +
        `  \`${c.noteA}\` ↔ \`${c.noteB}\`\n` +
        `  Gründe: ${c.reasons.join(', ')}`
      )
      return `## ${icon} ${label} (${items.length})\n\n${lines.join('\n\n')}`
    }

    const sections = [
      `# Duplikat-Analyse`,
      ``,
      `${candidates.length} Kandidaten gefunden. **Nichts wurde geändert** — nur Vorschläge.`,
      renderGroup('Hohe Confidence — merge empfohlen', '🔴', byConfidence.high),
      renderGroup('Mittlere Confidence — manuell prüfen', '🟡', byConfidence.medium),
      renderGroup('Niedrige Confidence — evtl. verlinken', '🟢', byConfidence.low),
    ].filter(Boolean).join('\n\n')

    return { content: [{ type: 'text', text: sections }] }
  },

  merge_duplicates(vault, args) {
    const dryRun = args.dry_run !== false
    const result = vault.mergeDuplicates({
      noteA: args.note_a as string | undefined,
      noteB: args.note_b as string | undefined,
      autoHighConfidence: args.auto_high_confidence === true,
      minScore: typeof args.min_score === 'number' ? args.min_score : undefined,
      dryRun,
      force: args.force === true,
    })

    const planText = result.plans.length > 0
      ? result.plans.map(plan => [
        `- \`${plan.noteA}\` ↔ \`${plan.noteB}\``,
        `  Ziel: \`${plan.target}\``,
        `  Archiv: \`${plan.archive}\``,
        `  Confidence: ${plan.confidence}, Score: ${plan.score}`,
        `  Anwendbar: ${plan.canApply ? 'ja' : 'nein'}`,
        plan.warnings.length > 0 ? `  Warnungen: ${plan.warnings.join('; ')}` : '',
      ].filter(Boolean).join('\n')).join('\n\n')
      : '  (keine)'

    const appliedText = result.applied.length > 0
      ? result.applied.map(a => `- \`${a.target}\`, archiviert: \`${a.archived}\``).join('\n')
      : '  (keine)'

    const skippedText = result.skipped.length > 0
      ? result.skipped.map(s => `- \`${s.noteA}\` ↔ \`${s.noteB}\`: ${s.reason}`).join('\n')
      : '  (keine)'

    return {
      content: [{
        type: 'text',
        text: [
          dryRun ? '# Merge-Duplikate Vorschau' : '# Merge-Duplikate angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          '',
          '## Pläne',
          planText,
          '',
          '## Angewendet',
          appliedText,
          '',
          '## Übersprungen',
          skippedText,
        ].join('\n'),
      }],
    }
  },
}
