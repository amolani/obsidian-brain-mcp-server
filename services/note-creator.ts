import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'

export interface CreateNoteOptions {
  title: string
  template: string
  content?: string
  tags?: string[]
  folder?: string
}

export interface CreateNoteResult {
  path: string
}

export interface NoteCreatorContext {
  vaultPath: string
  indexNote(fullPath: string, mtimeMs: number): void
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

const TEMPLATES: Record<string, (title: string, tags: string[]) => string> = {
  kunde: (title, tags) =>
    `---
projekt: ${title}
status: aktiv
tags:
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Übersicht

## Zugangsdaten

## Notizen
`,

  referenz: (title, tags) =>
    `---
status: aktiv
tags:
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Beschreibung

## Befehle

## Links
`,

  troubleshooting: (title, tags) =>
    `---
status: aktiv
tags:
  - troubleshooting
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Problem

## Ursache

## Lösung

## Prävention
`,

  learning: (title, tags) =>
    `---
status: aktiv
tags:
  - learning
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Was

## Warum

## Wie

## Quellen
`,

  daily: () =>
    `---
tags:
  - daily
datum: ${today()}
---

# ${today()}

## Aufgaben

- [ ]

## Notizen

## Gelernt
`,
}

export function targetFolderForTemplate(title: string, template: string, folder?: string): string {
  if (folder) return folder

  switch (template) {
    case 'kunde':
      return `Kunden/${title}`
    case 'referenz':
    case 'learning':
    case 'troubleshooting':
      return 'Referenz'
    case 'daily':
      return 'Daily'
    default:
      return 'Inbox'
  }
}

export function buildNoteFromTemplate(options: CreateNoteOptions): string {
  const templateFn = TEMPLATES[options.template]
  if (!templateFn) throw new Error(`Unknown template: ${options.template}`)

  let noteContent = templateFn(options.title, options.tags ?? [])
  if (options.content) {
    noteContent = noteContent.trimEnd() + '\n\n' + options.content + '\n'
  }
  return noteContent
}

export function fileNameForTemplate(title: string, template: string): string {
  return template === 'daily' ? `${today()}.md` : `${title}.md`
}

export function createNote(ctx: NoteCreatorContext, options: CreateNoteOptions): CreateNoteResult {
  const noteContent = buildNoteFromTemplate(options)
  const targetFolder = targetFolderForTemplate(options.title, options.template, options.folder)
  const fileName = fileNameForTemplate(options.title, options.template)
  const fullDir = join(ctx.vaultPath, targetFolder)
  const fullPath = join(fullDir, fileName)
  const relativePath = relative(ctx.vaultPath, fullPath)
  assertCanWriteTool('create_note', [relativePath])

  mkdirSync(fullDir, { recursive: true })
  writeFileSync(fullPath, noteContent, 'utf-8')

  const stat = statSync(fullPath)
  ctx.indexNote(fullPath, stat.mtimeMs)

  appendActionLog(ctx.vaultPath, {
    tool: 'create_note',
    mode: 'apply',
    targets: [relativePath],
    summary: `Neue Notiz aus Template "${options.template}"`,
    meta: { template: options.template, title: options.title },
  })

  return { path: relativePath }
}
