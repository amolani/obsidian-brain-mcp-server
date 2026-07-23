import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'

export interface DailyNoteResult {
  path: string
  created: boolean
  content: string
}

export interface DailyNoteContext {
  vaultPath: string
  createNote(title: string, template: string, content?: string): { path: string }
  indexNote(fullPath: string, mtimeMs: number): void
  buildLinkIndex(): void
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

export function dailyNote(ctx: DailyNoteContext, append?: string): DailyNoteResult {
  const dateStr = today()
  const relativePath = `Daily/${dateStr}.md`
  const fullPath = join(ctx.vaultPath, relativePath)

  let existing: string | null = null
  try {
    existing = readFileSync(fullPath, 'utf-8')
  } catch {}

  if (existing !== null) {
    if (!append) return { path: relativePath, created: false, content: existing }

    const updated = existing.trimEnd() + '\n\n' + append + '\n'
    assertCanWriteTool('daily_note', [relativePath])
    writeFileSync(fullPath, updated, 'utf-8')
    const stat = statSync(fullPath)
    ctx.indexNote(fullPath, stat.mtimeMs)
    ctx.buildLinkIndex()
    appendActionLog(ctx.vaultPath, {
      tool: 'daily_note',
      mode: 'apply',
      targets: [relativePath],
      summary: `Eintrag an Daily Note angehängt (${append.length} Zeichen)`,
    })
    return { path: relativePath, created: false, content: updated }
  }

  assertCanWriteTool('daily_note', [relativePath])
  const result = ctx.createNote(dateStr, 'daily', append)
  const content = readFileSync(join(ctx.vaultPath, result.path), 'utf-8')
  return { path: result.path, created: true, content }
}
