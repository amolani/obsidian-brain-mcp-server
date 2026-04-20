// Test helpers: temporary vaults, note creation, cleanup

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function createTempVault(): string {
  const path = mkdtempSync(join(tmpdir(), 'obsidian-test-'))
  return path
}

export function cleanupVault(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
}

export interface TestNote {
  path: string          // relative to vault root
  frontmatter?: Record<string, any>
  body?: string
  title?: string        // if set, adds "# Title" at start of body
}

export function writeNote(vaultPath: string, note: TestNote): string {
  const fullPath = join(vaultPath, note.path)
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })

  let content = ''
  if (note.frontmatter) {
    content += '---\n'
    for (const [key, val] of Object.entries(note.frontmatter)) {
      if (Array.isArray(val)) {
        content += `${key}:\n`
        for (const v of val) content += `  - ${v}\n`
      } else {
        content += `${key}: ${val}\n`
      }
    }
    content += '---\n\n'
  }
  if (note.title) content += `# ${note.title}\n\n`
  if (note.body) content += note.body

  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}
