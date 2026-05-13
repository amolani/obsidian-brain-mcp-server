export function isArchivedPath(path: string): boolean {
  return path.replace(/\\/g, '/').toLowerCase().startsWith('archiv/')
}

export function isActivePath(path: string): boolean {
  return !isArchivedPath(path)
}

export function isActiveNote(note: { relativePath: string }): boolean {
  return isActivePath(note.relativePath)
}

export function isGeneratedCustomerSurfacePath(path: string): boolean {
  return /\/_(dashboard|snapshot|timeline)\.md$/i.test(path.replace(/\\/g, '/'))
}

export function isGeneratedCustomerSurface(note: { relativePath: string; frontmatter?: Record<string, unknown> }): boolean {
  const source = String(note.frontmatter?.quelle ?? '')
  return isGeneratedCustomerSurfacePath(note.relativePath)
    || ['customer-dashboard', 'customer-snapshot', 'memory-timeline'].includes(source)
}
