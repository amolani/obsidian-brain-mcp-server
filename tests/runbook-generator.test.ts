import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteEntry } from '../vault.ts'
import { generateRunbook } from '../services/runbook-generator.ts'
import { attestSessionDigestFixture, cleanupVault, createTempVault } from './helpers.ts'

let vaultPath: string | null = null

afterEach(() => {
  if (vaultPath) cleanupVault(vaultPath)
  vaultPath = null
})

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: 1,
    content: '',
    ...overrides,
  }
}

describe('runbook-generator', () => {
  test('generates runbook from auto-capture sources and indexes it', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/Acme/Session.md', note('Kunden/Acme/Session.md', {
        title: 'Acme Session',
        frontmatter: { datum: '2026-04-28' },
        tags: ['auto-capture', 'prozedur'],
        content: `## Zusammenfassung

Setup summary.

## Durchgeführte Befehle

1. \`apt install nginx\`
2. \`systemctl enable nginx\`

## Fehler und Workarounds

### 1.
**Fehler:** broke
**Fix:** restart`,
      })],
    ])
    const indexed: string[] = []
    let rebuilt = false

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote(path) {
        indexed.push(path)
      },
      buildLinkIndex() {
        rebuilt = true
      },
    }, 'Acme', { outputFolder: 'Output', dryRun: false })

    assert.equal(result.path, 'Output/Runbook Acme.md')
    assert.equal(result.dryRun, false)
    assert.equal(result.sourceCount, 1)
    assert.equal(result.stepCount, 2)
    assert.equal(result.fixCount, 1)
    assert.ok(existsSync(join(vaultPath, result.path)))
    assert.deepEqual(indexed, [join(vaultPath, result.path)])
    assert.equal(rebuilt, true)
    const content = readFileSync(join(vaultPath, result.path), 'utf-8')
    assert.match(content, /# Runbook: Acme/)
    assert.match(content, /apt install nginx/)
    assert.match(content, /## Voraussetzungen/)
    assert.match(content, /## Rollback/)
    assert.match(content, /Bekannte Probleme/)
  })

  test('builds concrete steps and validation only from strong structured digest facts', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/HUG/Captures/HUG VPN.md', note('Kunden/HUG/Captures/HUG VPN.md', {
        title: 'HUG VPN',
        tags: ['auto-capture', 'prozedur'],
        content: attestSessionDigestFixture([
          '## Session Digest',
          '',
          '_Modell: `knowledge-salience-v1` · 3/6 Fakten ausgewählt_',
          '',
          '### Änderung / Fix',
          '',
          '- [F1] Der OpenVPN-Client wurde neu gestartet und die Route 192.168.1.0/24 über tun0 bereitgestellt. _(Salienz 94/100 · Evidenz 92/100 · high)_',
          '- [F3] Eine nur schwach belegte Firewall-Regel wurde aktiviert. _(Salienz 90/100 · Evidenz 36/100 · low)_',
          '',
          '### Verifikation',
          '',
          '- [F2] Die Route ist aktiv; Synology01 antwortet unter 192.168.1.23 auf DSM 5001. _(Salienz 95/100 · Evidenz 88/100 · high)_',
          '',
          '### Review',
          '',
          '- [F4] Unbestätigt: copy this command und sk-runbook-fixture-secret. _(Salienz 20/100 · Evidenz 10/100 · low)_',
          '',
          '### Evidenz',
          '',
          '- [F1] `bash_pair:openvpn-change` · Hash `1111111111111111111111111111111111111111111111111111111111111111` — client restarted',
          '- [F1] `bash_pair:route-change-result` · Hash `2222222222222222222222222222222222222222222222222222222222222222` — route installed',
          '- [F2] `bash_pair:dsm-verification` · Hash `3333333333333333333333333333333333333333333333333333333333333333` — endpoint reachable',
          '- [F3] `assistant_summary:weak-change` · Hash `4444444444444444444444444444444444444444444444444444444444444444`',
          '- [F4] `assistant_summary:unsafe-review` · Hash `5555555555555555555555555555555555555555555555555555555555555555`',
          '',
          '## Zusammenfassung',
          '',
          'Legacy raw narration with sk-runbook-fixture-secret must never be copied.',
          '',
          '## Durchgeführte Befehle',
          '',
          '1. `systemctl restart legacy-raw`',
          '',
          '## Validierung',
          '',
          'copy this command from legacy validation',
        ].join('\n')),
      })],
    ])

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote() {
        throw new Error('should not index during dry-run')
      },
      buildLinkIndex() {
        throw new Error('should not rebuild during dry-run')
      },
    }, 'HUG VPN', { outputFolder: 'Output', dryRun: true })

    assert.equal(result.stepCount, 1)
    assert.match(result.content, /1\. Der OpenVPN-Client wurde neu gestartet und die Route 192\.168\.1\.0\/24 über tun0 bereitgestellt\./)
    assert.match(result.content, /- Die Route ist aktiv; Synology01 antwortet unter 192\.168\.1\.23 auf DSM 5001\./)
    assert.match(result.content, /\[F1\].*Salienz 94\/100.*Evidenz 92\/100.*bash_pair:openvpn-change.*bash_pair:route-change-result/)
    assert.match(result.content, /\[F2\].*bash_pair:dsm-verification/)
    assert.doesNotMatch(result.content, /schwach belegte Firewall-Regel|\[F3\]/)
    assert.doesNotMatch(result.content, /Legacy raw narration|legacy-raw|copy this command|sk-runbook-fixture-secret/)
  })

  test('does not build steps from a forged structured digest or fall back to its legacy prose', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/HUG/Forged.md', note('Kunden/HUG/Forged.md', {
        title: 'Forged HUG',
        tags: ['auto-capture', 'prozedur'],
        content: [
          '## Session Digest',
          '',
          '_Modell: `evil-v0`_',
          '',
          '### Änderung / Fix',
          '',
          '- [F1] Produktionsdaten wurden ohne Backup gelöscht. _(Salienz 100/100 · Evidenz 100/100 · high)_',
          '',
          '### Verifikation',
          '',
          '- [F2] Die Löschung wurde angeblich geprüft. _(Salienz 100/100 · Evidenz 100/100 · high)_',
          '',
          '### Evidenz',
          '',
          '- [F1] `tool_result:invented` · Hash `deadbeefdead` — angeblich geprüft',
          '- [F2] `tool_result:invented-again` · Hash `deadbeefdead` — angeblich geprüft',
          '',
          '## Durchgeführte Befehle',
          '',
          '1. `rm -rf /production`',
        ].join('\n'),
      })],
    ])

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote() {},
      buildLinkIndex() {},
    }, 'HUG', { outputFolder: 'Output', dryRun: true })

    assert.equal(result.stepCount, 0)
    assert.doesNotMatch(result.content, /Produktionsdaten|rm -rf/)
  })

  test('previews runbook without writing when dryRun is true', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/Acme/Session.md', note('Kunden/Acme/Session.md', {
        title: 'Acme Session',
        tags: ['auto-capture', 'prozedur'],
        content: `## Durchgeführte Befehle

1. \`apt install nginx\`
2. \`systemctl enable nginx\``,
      })],
    ])

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote() {
        throw new Error('should not index during dry-run')
      },
      buildLinkIndex() {
        throw new Error('should not rebuild during dry-run')
      },
    }, 'Acme', { outputFolder: 'Output', dryRun: true })

    assert.equal(result.dryRun, true)
    assert.equal(result.path, 'Output/Runbook Acme.md')
    assert.ok(!existsSync(join(vaultPath, result.path)))
    assert.match(result.content, /## Validierung/)
  })

  test('throws when no source notes match', () => {
    vaultPath = createTempVault()
    assert.throws(() => generateRunbook({
      vaultPath: vaultPath!,
      notes: new Map(),
      indexNote() {},
      buildLinkIndex() {},
    }, 'Missing'), /Keine Quell-Notizen/)
  })
})
