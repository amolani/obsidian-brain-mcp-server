// Test helpers: temporary vaults, note creation, cleanup

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KNOWLEDGE_SALIENCE_MODEL } from '../services/knowledge-salience.ts'
import { parseSessionDigestFacts } from '../services/session-digest-facts.ts'
import { renderSessionDigestAttestation, sessionDigestIntegrity } from '../services/session-digest-integrity.ts'

export function createTempVault(): string {
  const path = mkdtempSync(join(tmpdir(), 'obsidian-test-'))
  return path
}

export function cleanupVault(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
}

/** Builds realistic, deterministic integrity metadata for trusted test inputs. */
export function attestSessionDigestFixture(markdown: string): string {
  let content = markdown.replace(/\n*_Digest-Integrität:.*_\n*/gim, '\n\n')
  if (!/^_Modell:/m.test(content)) {
    content = content.replace(
      /^(## Session Digest\s*)$/m,
      `$1\n\n_Modell: \`${KNOWLEDGE_SALIENCE_MODEL.version}\` · Test-Fixture_`,
    )
  }
  content = content.replace(
    /(`([^`]+)`\s*[·|]\s*Hash\s+`)([a-f0-9]{12,64})(`)/gi,
    (_match, before: string, ref: string, shortHash: string, after: string) => {
      const fullHash = createHash('sha256').update(`fixture\0${ref}\0${shortHash}`).digest('hex')
      return `${before}${fullHash}${after}`
    },
  )
  const parsed = parseSessionDigestFacts(content)
  if (!parsed.modelVersion) throw new Error('Test-Digest hat keine Modellversion')
  const attestation = renderSessionDigestAttestation(sessionDigestIntegrity(parsed.modelVersion, parsed.facts))
  const attested = content.replace(MODEL_FIXTURE_LINE, `$&\n\n${attestation}`)
  const verified = parseSessionDigestFacts(attested)
  if (verified.integrityStatus !== 'verified') {
    throw new Error(`Test-Digest ist nicht attestierbar: ${verified.integrityReason}`)
  }
  return attested
}

const MODEL_FIXTURE_LINE = /^_Modell:\s*`[^`]+`(?:\s+·.*)?_[ \t]*$/m

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
