import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Replace a file without exposing a partially written target. The temporary
 * file lives beside the target so the final rename stays on the same
 * filesystem and is atomic.
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o666)
    writeFileSync(descriptor, content, 'utf-8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error
  }
}

export function atomicWriteJsonSync(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
