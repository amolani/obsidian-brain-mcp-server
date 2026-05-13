import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('claim extractor noise filtering', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/HUG/VPN Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture'],
        quelle: 'knowledge-harvester',
        kunde: 'HUG',
      },
      title: 'VPN Capture',
      body: [
        'Sobald gestartet, prüfe ich Log, `tun0` und ein Ping ins Kundennetz `192.168.1.0/24`.',
        '`sudo` braucht ein Passwort, ich kann das nicht interaktiv eingeben.',
        'Alternativ als Daemon mit lesbarem Log: erst `sudo rm -f /tmp/hug-vpn.log`.',
        'Die Route 192.168.1.0/24 ist ueber tun0 erreichbar.',
        'Synology01 ist unter 192.168.1.23 per DSM 5001 erreichbar.',
      ].join('\n\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('filters assistant instructions but keeps durable findings', () => {
    const result = vault.extractClaims({
      path: 'Kunden/HUG/VPN Capture.md',
      maxClaims: 10,
      dryRun: true,
    })

    const claims = result.claims.map(claim => claim.claim).join('\n')
    assert.doesNotMatch(claims, /Sobald gestartet/)
    assert.doesNotMatch(claims, /sudo/)
    assert.doesNotMatch(claims, /Alternativ als Daemon/)
    assert.match(claims, /Synology01 ist unter 192\.168\.1\.23/)
    assert.match(claims, /Route 192\.168\.1\.0\/24 ist ueber tun0 erreichbar/)
  })
})
