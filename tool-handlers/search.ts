import type { ToolHandlerRegistry } from './types.ts'
import { strings } from './types.ts'

export const searchHandlers: ToolHandlerRegistry = {
  vault_search(vault, args) {
    const results = vault.search({
      query: args.query as string | undefined,
      tags: args.tags as string[] | undefined,
      folder: args.folder as string | undefined,
      status: args.status as string | undefined,
    })

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'Keine Treffer gefunden.' }] }
    }

    const text = results
      .map((r) => {
        const meta = [
          r.status ? `status: ${r.status}` : null,
          r.projekt ? `projekt: ${r.projekt}` : null,
          r.datum ? `datum: ${r.datum}` : null,
          r.tags.length > 0 ? `tags: ${r.tags.join(', ')}` : null,
          r.matchCount > 0 ? `relevanz: ${r.matchCount}` : null,
        ]
          .filter(Boolean)
          .join(' | ')
        return `**${r.title}** (${r.path})\n  ${meta}`
      })
      .join('\n\n')

    return {
      content: [{ type: 'text', text: `${results.length} Treffer:\n\n${text}` }],
    }
  },

  semantic_search(vault, args) {
    const results = vault.semanticSearch({
      query: args.query as string,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      tags: strings(args.tags),
      minScore: typeof args.min_score === 'number' ? args.min_score : undefined,
      includeArchived: args.include_archived === true,
    })

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'Keine semantischen Treffer gefunden.' }] }
    }

    const text = results.map(r => [
      `- **${r.score}** (${r.confidence}) \`${r.path}\` — ${r.title}`,
      `  Gründe: ${r.reasons.join(', ')}`,
      `  Treffer: ${r.matchedTerms.join(', ')}`,
      r.snippet ? `  Kontext: ${r.snippet}` : '',
    ].filter(Boolean).join('\n')).join('\n\n')

    return {
      content: [{
        type: 'text',
        text: `# Semantic Search\n\n${results.length} Treffer:\n\n${text}`,
      }],
    }
  },

  semantic_index_status(vault) {
    const status = vault.semanticIndexStatus()
    const stale = status.staleNotes.slice(0, 20).map(path => `- stale: \`${path}\``).join('\n')
    const missing = status.missingNotes.slice(0, 20).map(path => `- missing: \`${path}\``).join('\n')
    const extra = status.extraNotes.slice(0, 20).map(path => `- extra: \`${path}\``).join('\n')
    const details = [stale, missing, extra].filter(Boolean).join('\n') || 'Keine Abweichungen.'

    return {
      content: [{
        type: 'text',
        text: [
          '# Semantic Index Status',
          '',
          `Exists: ${status.exists}`,
          `Path: \`${status.path}\``,
          `Provider: ${status.provider}`,
          `Version: ${status.version}`,
          `Built at: ${status.builtAt ?? 'n/a'}`,
          `Notes: ${status.freshNotes}/${status.totalNotes} fresh, ${status.indexedNotes} indexed`,
          '',
          '## Drift',
          details,
        ].join('\n'),
      }],
    }
  },

  rebuild_semantic_index(vault, args) {
    const result = vault.rebuildSemanticIndex({
      dryRun: args.dry_run !== false,
    })
    return {
      content: [{
        type: 'text',
        text: [
          result.dryRun ? '# Semantic Index Rebuild Vorschau' : '# Semantic Index neu aufgebaut',
          '',
          `Dry-Run: ${result.dryRun}`,
          `Path: \`${result.path}\``,
          `Provider: ${result.provider}`,
          `Version: ${result.version}`,
          `Indexed Notes: ${result.indexedNotes}/${result.totalNotes}`,
          `Would write: ${result.wouldWrite}`,
        ].join('\n'),
      }],
    }
  },

  build_context_pack(vault, args) {
    const pack = vault.buildContextPack({
      query: args.query as string,
      maxNotes: typeof args.max_notes === 'number' ? args.max_notes : undefined,
      includeLinked: typeof args.include_linked === 'boolean' ? args.include_linked : undefined,
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      tags: strings(args.tags),
    })

    const renderNote = (note: typeof pack.primary[number]) => [
      `- **${note.title}** — \`${note.path}\` (${note.role}, Score ${note.score})`,
      `  Grund: ${note.reason}`,
      `  Tags: ${note.tags.join(', ') || 'keine'}`,
      `  Snippet: ${note.snippet}`,
      note.openTodos.length > 0 ? `  Offene TODOs: ${note.openTodos.map(t => `Z${t.line}: ${t.text}`).join(' | ')}` : '',
      note.outgoingLinks.length > 0 ? `  Links: ${note.outgoingLinks.slice(0, 5).map(p => `[[${p.replace(/\.md$/, '')}]]`).join(', ')}` : '',
    ].filter(Boolean).join('\n')

    const primary = pack.primary.length > 0 ? pack.primary.map(renderNote).join('\n\n') : '  (keine)'
    const linked = pack.linked.length > 0 ? pack.linked.map(renderNote).join('\n\n') : '  (keine)'
    const todos = pack.openTodos.length > 0
      ? pack.openTodos.map(t => `- \`${t.path}\` Z${t.line}: ${t.text}`).join('\n')
      : '  (keine)'
    const actions = pack.suggestedNextActions.map(a => `- ${a}`).join('\n')

    return {
      content: [{
        type: 'text',
        text: [
          `# Context Pack: ${pack.query}`,
          '',
          `Provider: ${pack.provider}`,
          `Citations: ${pack.citations.map(c => `\`${c}\``).join(', ') || '(keine)'}`,
          '',
          '## Primäre Treffer',
          primary,
          '',
          '## Verlinkter Kontext',
          linked,
          '',
          '## Offene TODOs',
          todos,
          '',
          '## Nächste Schritte',
          actions,
        ].join('\n'),
      }],
    }
  },

  recall_context(vault, args) {
    const pack = vault.recallContext({
      query: args.query as string,
      maxNotes: typeof args.max_notes === 'number' ? args.max_notes : undefined,
      includeLinked: typeof args.include_linked === 'boolean' ? args.include_linked : undefined,
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      tags: strings(args.tags),
    })

    const renderNote = (note: typeof pack.primary[number]) => [
      `- **${note.title}** — \`${note.path}\` (${note.role}, Score ${note.score})`,
      `  Warum erinnert: ${note.reason}`,
      `  Snippet: ${note.snippet}`,
      note.openTodos.length > 0 ? `  Offene TODOs: ${note.openTodos.map(t => `Z${t.line}: ${t.text}`).join(' | ')}` : '',
    ].filter(Boolean).join('\n')

    const primary = pack.primary.length > 0 ? pack.primary.map(renderNote).join('\n\n') : '  (keine)'
    const linked = pack.linked.length > 0 ? pack.linked.map(renderNote).join('\n\n') : '  (keine)'
    const todos = pack.openTodos.length > 0
      ? pack.openTodos.map(t => `- \`${t.path}\` Z${t.line}: ${t.text}`).join('\n')
      : '  (keine)'

    return {
      content: [{
        type: 'text',
        text: [
          `# Recall Context: ${pack.query}`,
          '',
          'Modus: manuell, read-only, nicht gespeichert.',
          `Citations: ${pack.citations.map(c => `\`${c}\``).join(', ') || '(keine)'}`,
          '',
          '## Erinnerte Notizen',
          primary,
          '',
          '## Angrenzender Kontext',
          linked,
          '',
          '## Offene TODOs',
          todos,
          '',
          '## Nächste Schritte',
          pack.suggestedNextActions.map(action => `- ${action}`).join('\n'),
        ].join('\n'),
      }],
    }
  },

  get_note_context(vault, args) {
    const path = args.path as string
    const ctx = vault.getNoteContext(path)

    if (!ctx) {
      return {
        content: [{ type: 'text', text: `Note nicht gefunden: ${path}` }],
        isError: true,
      }
    }

    const sections = [
      `## Frontmatter\n${JSON.stringify(ctx.frontmatter, null, 2)}`,
      `## Content\n${ctx.content}`,
      ctx.backlinks.length > 0
        ? `## Backlinks (${ctx.backlinks.length})\n${ctx.backlinks.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
        : '## Backlinks\nKeine.',
      ctx.outgoingLinks.length > 0
        ? `## Ausgehende Links (${ctx.outgoingLinks.length})\n${ctx.outgoingLinks.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
        : '## Ausgehende Links\nKeine.',
      ctx.relatedByTags.length > 0
        ? `## Verwandte Notizen (${ctx.relatedByTags.length})\n${ctx.relatedByTags.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
        : '## Verwandte Notizen\nKeine.',
    ]

    return { content: [{ type: 'text', text: sections.join('\n\n') }] }
  },
}
