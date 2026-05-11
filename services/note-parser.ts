import { basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { NoteEntry } from '../vault.ts'

export function parseFrontmatter(raw: string): Record<string, any> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  try {
    return parseYaml(match[1]) ?? {}
  } catch {
    return {}
  }
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

export function extractTitle(content: string, fullPath: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  if (match) return match[1].trim()
  return basename(fullPath, '.md')
}

export function extractTags(frontmatter: Record<string, any>, content: string): string[] {
  const tags = new Set<string>()

  if (Array.isArray(frontmatter.tags)) {
    for (const tag of frontmatter.tags) {
      if (typeof tag === 'string') tags.add(tag.toLowerCase())
    }
  }

  const inlineTags = content.matchAll(/(^|\s)#([a-zA-ZäöüÄÖÜß][\w/äöüÄÖÜß-]*)/g)
  for (const match of inlineTags) {
    tags.add(match[2].toLowerCase())
  }

  return [...tags]
}

export function extractLinks(content: string): string[] {
  const links: string[] = []
  const matches = content.matchAll(/\[\[([^\]]+?)\]\]/g)
  for (const match of matches) {
    let raw = match[1]
    const pipeIdx = raw.search(/\\?\|/)
    if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx)
    const target = raw.trim()
    if (target && !target.startsWith('!')) links.push(target)
  }
  return links
}

export function extractTodos(content: string): { text: string; done: boolean; line: number }[] {
  const todos: { text: string; done: boolean; line: number }[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^[\s]*- \[([ xX])\]\s+(.+)/)
    if (!match) continue
    todos.push({
      text: match[2].trim(),
      done: match[1] !== ' ',
      line: i + 1,
    })
  }
  return todos
}

export function parseNoteEntry(fullPath: string, relativePath: string, raw: string, mtimeMs: number): NoteEntry {
  const frontmatter = parseFrontmatter(raw)
  const content = stripFrontmatter(raw)
  const title = extractTitle(content, fullPath)
  const tags = extractTags(frontmatter, content)
  const outgoingLinks = extractLinks(content)
  const todos = extractTodos(content)

  return {
    path: fullPath,
    relativePath,
    title,
    frontmatter,
    tags,
    outgoingLinks,
    todos,
    lastModified: mtimeMs,
    content,
  }
}
