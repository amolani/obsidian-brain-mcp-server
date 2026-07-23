export function isArchivedPath(path: string): boolean {
  return path.replace(/\\/g, '/').toLowerCase().startsWith('archiv/')
}

export function isActivePath(path: string): boolean {
  return !isArchivedPath(path)
}

export function isActiveNote(note: { relativePath: string }): boolean {
  return isActivePath(note.relativePath)
}

export function isAutoCaptureNote(note: {
  relativePath: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
}): boolean {
  const frontmatterTags = Array.isArray(note.frontmatter?.tags)
    ? note.frontmatter.tags.map(String)
    : typeof note.frontmatter?.tags === 'string'
      ? [note.frontmatter.tags]
      : []
  return note.frontmatter?.quelle === 'knowledge-harvester'
    || note.frontmatter?.source_stage === 'stop_capture'
    || frontmatterTags.includes('auto-capture')
    || /(^|\/)Captures\//.test(note.relativePath.replace(/\\/g, '/'))
}

export function isGeneratedCustomerSurfacePath(path: string): boolean {
  return /\/_(dashboard|snapshot|timeline)\.md$/i.test(path.replace(/\\/g, '/'))
}

export function isGeneratedCustomerSurface(note: { relativePath: string; frontmatter?: Record<string, unknown> }): boolean {
  const source = String(note.frontmatter?.quelle ?? '')
  return isGeneratedCustomerSurfacePath(note.relativePath)
    || ['customer-dashboard', 'customer-snapshot', 'memory-timeline'].includes(source)
}
