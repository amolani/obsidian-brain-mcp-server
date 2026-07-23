import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath, assertSingleLineText, sanitizePathSegment, vaultJoin } from './vault-paths.ts'

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
${buildFrontmatter({ projekt: title, status: 'aktiv', tags, datum: today() })}---

# ${title}

## Übersicht

## Zugangsdaten

## Notizen
`,

  referenz: (title, tags) =>
    `---
${buildFrontmatter({ status: 'aktiv', tags, datum: today() })}---

# ${title}

## Beschreibung

## Befehle

## Links
`,

  troubleshooting: (title, tags) =>
    `---
${buildFrontmatter({ status: 'aktiv', tags: ['troubleshooting', ...tags], datum: today() })}---

# ${title}

## Problem

## Ursache

## Lösung

## Prävention
`,

  learning: (title, tags) =>
    `---
${buildFrontmatter({ status: 'aktiv', tags: ['learning', ...tags], datum: today() })}---

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

  const title = assertSingleLineText(options.title, 'title')
  let noteContent = templateFn(title, options.tags ?? [])
  if (options.content) {
    noteContent = noteContent.trimEnd() + '\n\n' + options.content + '\n'
  }
  return noteContent
}

export function fileNameForTemplate(title: string, template: string): string {
  if (template === 'daily') return `${today()}.md`
  const stem = sanitizePathSegment(assertSingleLineText(title, 'title'))
  if (!stem) throw new Error('title ergibt keinen gültigen Dateinamen')
  return `${stem}.md`
}

export function createNote(ctx: NoteCreatorContext, options: CreateNoteOptions): CreateNoteResult {
  const title = assertSingleLineText(options.title, 'title')
  const noteContent = buildNoteFromTemplate({ ...options, title })
  const defaultFolder = targetFolderForTemplate(sanitizePathSegment(title), options.template)
  const targetFolder = options.folder === undefined ? assertSafeRelativePath(defaultFolder) : assertSafeRelativePath(options.folder)
  const fileName = fileNameForTemplate(title, options.template)
  const relativePath = assertSafeRelativePath(`${targetFolder}/${fileName}`)
  const fullDir = vaultJoin(ctx.vaultPath, targetFolder)
  const fullPath = vaultJoin(ctx.vaultPath, relativePath)
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
