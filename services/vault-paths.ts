import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export function sanitizePathSegment(segment: string): string {
  const cleaned = segment
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned === '.' || cleaned === '..' ? '' : cleaned
}

/** Normalize a user-facing value that is required to stay on one Markdown/YAML line. */
export function assertSingleLineText(value: string, field = 'Wert'): string {
  const normalized = value.normalize('NFC')
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} darf keine Steuerzeichen oder Zeilenumbrüche enthalten`)
  }
  const trimmed = normalized.trim()
  if (!trimmed) throw new Error(`${field} darf nicht leer sein`)
  return trimmed
}

/** Validate a value that becomes exactly one directory component. */
export function assertSafePathSegment(value: string, field = 'Pfadsegment'): string {
  const normalized = assertSingleLineText(value, field)
  const safe = sanitizePathSegment(normalized)
  if (!safe || safe !== normalized) throw new Error(`Ungültiges ${field}: ${value}`)
  return safe
}

export function assertSafeRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim() || /[\u0000-\u001f\u007f]/.test(relativePath)) {
    throw new Error(`Unsicherer Vault-Pfad: ${relativePath}`)
  }
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized === '..'
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.includes('/../')
  ) {
    throw new Error(`Unsicherer Vault-Pfad: ${relativePath}`)
  }
  return normalized
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function existingAncestor(path: string, root: string): string {
  let current = path
  while (true) {
    try {
      lstatSync(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (current === root) return root
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

export function vaultJoin(vaultPath: string, relativePath: string): string {
  const safeRel = assertSafeRelativePath(relativePath)
  const lexicalRoot = resolve(vaultPath)
  const realRoot = realpathSync(lexicalRoot)
  const fullPath = resolve(lexicalRoot, safeRel)
  if (!isInside(lexicalRoot, fullPath)) {
    throw new Error(`Pfad verlässt Vault: ${relativePath}`)
  }
  const ancestor = existingAncestor(fullPath, lexicalRoot)
  let realAncestor: string
  try {
    realAncestor = realpathSync(ancestor)
  } catch {
    throw new Error(`Vault-Pfad enthält einen ungültigen Symlink: ${relativePath}`)
  }
  if (!isInside(realRoot, realAncestor)) throw new Error(`Vault-Pfad verlässt über Symlink den Vault: ${relativePath}`)
  return fullPath
}

export function uniqueRelativePath(vaultPath: string, folder: string, fileName: string): string {
  const safeFolder = assertSafeRelativePath(folder)
  const ext = fileName.endsWith('.md') ? '.md' : ''
  const stem = sanitizePathSegment(ext ? fileName.slice(0, -3) : fileName)
  if (!stem) throw new Error(`Ungültiger Dateiname: ${fileName}`)
  let candidate = `${safeFolder}/${stem}${ext || '.md'}`
  let counter = 2
  while (existsSync(vaultJoin(vaultPath, candidate))) {
    candidate = `${safeFolder}/${stem} (${counter})${ext || '.md'}`
    counter++
  }
  return candidate
}
