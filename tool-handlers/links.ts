import type { ToolHandlerRegistry } from './types.ts'
import { strings } from './types.ts'

export const linkHandlers: ToolHandlerRegistry = {
  suggest_links(vault) {
    const suggestions = vault.suggestLinks()

    if (suggestions.length === 0) {
      return { content: [{ type: 'text', text: 'Keine unverlinkten Erwähnungen gefunden.' }] }
    }

    const text = suggestions
      .slice(0, 30)
      .map((s) => `**${s.source}** erwähnt "${s.mention}" → könnte auf [[${s.target}]] (${s.targetTitle}) verlinken`)
      .join('\n')

    return {
      content: [
        { type: 'text', text: `${suggestions.length} unverlinkte Erwähnungen:\n\n${text}` },
      ],
    }
  },

  suggest_links_v2(vault, args) {
    const suggestions = vault.suggestLinksV2({
      minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
      maxPerNote: typeof args.max_per_note === 'number' ? args.max_per_note : undefined,
      maxTotal: typeof args.max_total === 'number' ? args.max_total : undefined,
    })

    if (suggestions.length === 0) {
      return { content: [{ type: 'text', text: 'Keine Link-Vorschläge gefunden.' }] }
    }

    const text = suggestions
      .slice(0, 50)
      .map((s) => [
        `- **${Math.round(s.confidence * 100)}%** \`${s.source}\``,
        `  erwähnt "${s.mention}" → [[${s.target.replace(/\.md$/, '')}|${s.targetTitle}]]`,
        `  Gründe: ${s.reasons.join(', ')}`,
        s.snippet ? `  Kontext: ...${s.snippet}...` : '',
      ].filter(Boolean).join('\n'))
      .join('\n\n')

    return {
      content: [
        { type: 'text', text: `${suggestions.length} Link-Vorschläge:\n\n${text}` },
      ],
    }
  },

  apply_link_suggestions(vault, args) {
    const result = vault.applyLinkSuggestions({
      dryRun: args.dry_run !== false,
      minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
      maxPerNote: typeof args.max_per_note === 'number' ? args.max_per_note : undefined,
      maxTotal: typeof args.max_total === 'number' ? args.max_total : undefined,
      sources: strings(args.sources),
    })

    const linked = result.linked.length > 0
      ? result.linked.map(item => `- \`${item.source}\`: ${item.mention} → ${item.replacement} (${Math.round(item.confidence * 100)}%)`).join('\n')
      : '  (keine)'
    const skipped = result.skipped.length > 0
      ? result.skipped.map(item => `- \`${item.source}\` → \`${item.target}\` (${item.mention}): ${item.reason}`).join('\n')
      : '  (keine)'

    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Link-Vorschläge Vorschau' : '# Link-Vorschläge angewendet',
          '',
          `Dry-Run: ${result.dryRun}`,
          '',
          '## Verlinkt',
          linked,
          '',
          '## Übersprungen',
          skipped,
        ].join('\n'),
      }],
    }
  },

  find_broken_links(vault) {
    const broken = vault.findBrokenLinks()
    if (broken.length === 0) {
      return { content: [{ type: 'text', text: 'Keine kaputten Links gefunden. ✓' }] }
    }

    const lines = broken.slice(0, 50).map(b => {
      const candidatesText = b.candidates.length === 0
        ? '  (keine Kandidaten)'
        : b.candidates.map(c => `  - [${c.confidence}] ${c.path} — ${c.reason}`).join('\n')
      return `- **${b.source}** → \`[[${b.target}]]\` (nicht gefunden)\n${candidatesText}`
    }).join('\n\n')

    const summary = `# Kaputte Links\n\n${broken.length} kaputte Links gefunden.\n\n${lines}`
    return { content: [{ type: 'text', text: summary }] }
  },

  fix_broken_links(vault, args) {
    const dryRun = args.dry_run !== false
    const result = vault.fixBrokenLinks(dryRun)

    const fixedText = result.fixed.length > 0
      ? result.fixed.map(f => `- \`${f.source}\`: ${f.oldLink} → ${f.newLink}`).join('\n')
      : '  (keine)'
    const skippedText = result.skipped.length > 0
      ? result.skipped.map(s => `- \`${s.source}\`: ${s.oldLink} — ${s.reason}`).join('\n')
      : '  (keine)'

    const header = dryRun
      ? `## Vorschau (Dry Run)\n\n**Nichts geändert.**`
      : `## Angewendet\n\n**${result.fixed.length}** Links repariert.`

    return {
      content: [{
        type: 'text',
        text: [
          header,
          ``,
          `### Auto-Fix (${result.fixed.length})`,
          fixedText,
          ``,
          `### Übersprungen (${result.skipped.length})`,
          skippedText,
        ].join('\n'),
      }],
    }
  },
}
