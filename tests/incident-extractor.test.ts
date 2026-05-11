import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('incident extractor', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Captures/Traefik Incident.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'troubleshooting', 'docker'],
        datum: '2026-05-10',
      },
      title: 'Traefik Incident',
      body: [
        '## Fehler',
        '',
        '- error: router failed tls challenge',
        '- problem: service returned 502',
        '',
        '## Durchgeführte Schritte',
        '',
        '1. docker compose ps',
        '2. journalctl -u docker',
        '',
        '```bash',
        'docker compose logs traefik',
        'systemctl restart docker',
        '```',
        '',
        '## Lösung',
        '',
        '- fix: renewed ACME storage permissions',
        '- workaround: restarted traefik container',
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('extract_troubleshooting_pattern finds symptoms, fixes, and commands', () => {
    const result = vault.extractTroubleshootingPattern('Traefik Incident')

    assert.equal(result.source, 'Captures/Traefik Incident.md')
    assert.ok(result.errors.some(error => error.includes('router failed')))
    assert.ok(result.fixes.some(fix => fix.includes('ACME storage')))
    assert.ok(result.commands.includes('docker compose logs traefik'))
    assert.match(result.patternMarkdown, /Troubleshooting Pattern: Traefik Incident/)
  })

  test('promote_capture_to_runbook dry-run previews without writing', () => {
    const result = vault.promoteCaptureToRunbook({
      path: 'Captures/Traefik Incident.md',
      dryRun: true,
    })

    assert.equal(result.dryRun, true)
    assert.ok(result.stepCount >= 3)
    assert.ok(result.fixCount >= 2)
    assert.match(result.content, /# Runbook: Traefik Incident/)
    assert.ok(!existsSync(join(vaultPath, 'Runbooks/Runbook Traefik Incident.md')))
  })

  test('promote_capture_to_runbook apply writes and logs', () => {
    const result = vault.promoteCaptureToRunbook({
      path: 'Captures/Traefik Incident.md',
      dryRun: false,
    })

    assert.equal(result.dryRun, false)
    assert.ok(existsSync(join(vaultPath, result.path)))
    assert.match(readFileSync(join(vaultPath, result.path), 'utf-8'), /promoted-capture/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"promote_capture_to_runbook"/)
  })

  test('generate_postmortem writes draft only on apply', () => {
    const preview = vault.generatePostmortem({
      path: 'Captures/Traefik Incident.md',
      dryRun: true,
    })

    assert.equal(preview.dryRun, true)
    assert.match(preview.content, /# Postmortem: Traefik Incident/)
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.generatePostmortem({
      path: 'Captures/Traefik Incident.md',
      dryRun: false,
    })
    assert.ok(existsSync(join(vaultPath, applied.path)))
    assert.match(readFileSync(join(vaultPath, applied.path), 'utf-8'), /status: entwurf/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"generate_postmortem"/)
  })
})
