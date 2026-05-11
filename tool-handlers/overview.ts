import type { ToolHandlerRegistry } from './types.ts'

export const overviewHandlers: ToolHandlerRegistry = {
  vault_overview(vault) {
    const stats = vault.getOverview()

    const folderList = Object.entries(stats.notesByFolder)
      .sort((a, b) => b[1] - a[1])
      .map(([f, c]) => `  ${f}: ${c}`)
      .join('\n')

    const tagList = Object.entries(stats.allTags)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `  #${t}: ${c}`)
      .join('\n')

    const recentList = stats.recentlyModified
      .map((r) => `  ${r.date} — ${r.title} (${r.path})`)
      .join('\n')

    const orphanList = stats.orphanNotes
      .map((o) => `  - ${o.title} (${o.path})`)
      .join('\n')

    const text = [
      `# Vault-Übersicht`,
      ``,
      `**Notizen gesamt:** ${stats.totalNotes}`,
      `**Offene TODOs:** ${stats.openTodoCount}`,
      ``,
      `## Nach Ordner`,
      folderList,
      ``,
      `## Tags`,
      tagList,
      ``,
      `## Zuletzt bearbeitet`,
      recentList,
      ``,
      `## Verwaiste Notizen (keine eingehenden Links)`,
      orphanList || '  Keine.',
      ``,
      `## Stale Notizen (status: aktiv, > 180 Tage nicht bearbeitet)`,
      stats.staleNotes.length > 0
        ? stats.staleNotes.map(s => `  - ${s.title} (${s.path}) — ${s.daysAgo} Tage alt`).join('\n')
        : '  Keine.',
    ].join('\n')

    return { content: [{ type: 'text', text }] }
  },

  todo_list(vault, args) {
    const items = vault.getTodoList(args.folder as string | undefined)

    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'Keine offenen TODOs gefunden.' }] }
    }

    const text = items
      .map((item) => {
        const todos = item.todos
          .map((t) => `  - [ ] ${t.text} (Zeile ${t.line})`)
          .join('\n')
        return `**${item.title}** (${item.file})\n${todos}`
      })
      .join('\n\n')

    const totalCount = items.reduce((sum, i) => sum + i.todos.length, 0)
    return {
      content: [
        {
          type: 'text',
          text: `${totalCount} offene TODOs in ${items.length} Dateien:\n\n${text}`,
        },
      ],
    }
  },

  weekly_review(vault) {
    const review = vault.weeklyReview()

    const modified = review.modifiedNotes
      .map((n) => `  ${n.date} — ${n.title} (${n.path})`)
      .join('\n')

    const newNotes = review.newNotes
      .map((n) => `  ${n.date} — ${n.title} (${n.path})`)
      .join('\n')

    const projects = review.activeProjects
      .map((p) => `  ${p.projekt}: ${p.noteCount} Notizen`)
      .join('\n')

    const text = [
      `# Wochenrückblick (${review.period})`,
      ``,
      `## Bearbeitete Notizen (${review.modifiedNotes.length})`,
      modified || '  Keine.',
      ``,
      `## Neue Notizen (${review.newNotes.length})`,
      newNotes || '  Keine.',
      ``,
      `## TODOs`,
      `  Offen: ${review.openTodos}`,
      `  Erledigt: ${review.completedTodos}`,
      ``,
      `## Aktive Projekte`,
      projects || '  Keine.',
    ].join('\n')

    return { content: [{ type: 'text', text }] }
  },
}
