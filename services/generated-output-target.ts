import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type GeneratedOutputKind = 'demo-vault' | 'large-vault-benchmark'

const MARKER_FILE = '.obsidian-brain-generated-output.json'
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function markerPath(outPath: string): string {
  return resolve(outPath, MARKER_FILE)
}

function hasOwnedMarker(outPath: string, kind: GeneratedOutputKind): boolean {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(outPath), 'utf-8')) as { owner?: unknown; kind?: unknown }
    return parsed.owner === 'obsidian-brain' && parsed.kind === kind
  } catch {
    return false
  }
}

function assertNotBroadTarget(outPath: string): void {
  const resolved = resolve(outPath)
  const forbidden = new Set([
    parse(resolved).root,
    resolve(homedir()),
    resolve(tmpdir()),
    resolve(process.cwd()),
    resolve(PROJECT_ROOT),
  ])
  if (forbidden.has(resolved)) {
    throw new Error(`Unsicheres generiertes Ausgabeziel abgelehnt: ${resolved}`)
  }
}

/**
 * Prevents --force from recursively deleting an arbitrary user directory.
 * Only a directory previously marked by the same generator may be replaced.
 */
export function prepareGeneratedOutputTarget(outPath: string, force: boolean, kind: GeneratedOutputKind): void {
  if (!outPath?.trim()) throw new Error('outPath ist erforderlich')
  assertNotBroadTarget(outPath)
  if (!existsSync(outPath)) return
  const entries = readdirSync(outPath)
  if (entries.length === 0) return
  if (!force) {
    throw new Error(`${outPath} existiert bereits und ist nicht leer. Nutze --force nur für ein zuvor vom selben Generator erstelltes Ziel.`)
  }
  if (!hasOwnedMarker(outPath, kind)) {
    throw new Error(`${outPath} ist nicht als ${kind}-Ausgabe markiert; --force löscht keine fremden Verzeichnisse`)
  }
  rmSync(outPath, { recursive: true, force: true })
}

export function markGeneratedOutput(outPath: string, kind: GeneratedOutputKind): void {
  writeFileSync(markerPath(outPath), `${JSON.stringify({
    owner: 'obsidian-brain',
    kind,
    schemaVersion: 1,
  }, null, 2)}\n`, 'utf-8')
}
