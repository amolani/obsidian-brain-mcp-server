import { existsSync } from 'node:fs'
import { join, normalize, relative, sep } from 'node:path'

export function sanitizePathSegment(segment: string): string {
  return segment.replace(/[/\\:*?"<>|]/g, '-').trim()
}

export function assertSafeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/') || normalized.includes('/../')) {
    throw new Error(`Unsicherer Vault-Pfad: ${relativePath}`)
  }
  return normalized
}

export function vaultJoin(vaultPath: string, relativePath: string): string {
  const safeRel = assertSafeRelativePath(relativePath)
  const fullPath = join(vaultPath, safeRel)
  const rel = relative(vaultPath, fullPath)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error(`Pfad verlässt Vault: ${relativePath}`)
  }
  return fullPath
}

export function uniqueRelativePath(vaultPath: string, folder: string, fileName: string): string {
  const safeFolder = assertSafeRelativePath(folder)
  const ext = fileName.endsWith('.md') ? '.md' : ''
  const stem = sanitizePathSegment(ext ? fileName.slice(0, -3) : fileName)
  let candidate = `${safeFolder}/${stem}${ext || '.md'}`
  let counter = 2
  while (existsSync(vaultJoin(vaultPath, candidate))) {
    candidate = `${safeFolder}/${stem} (${counter})${ext || '.md'}`
    counter++
  }
  return candidate
}
