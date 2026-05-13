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

  test('filters conversational ADBK satellite status chatter but keeps durable facts', () => {
    writeNote(vaultPath, {
      path: 'Kunden/Düsseldorf/ADBK Satellite Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture'],
        quelle: 'knowledge-harvester',
        kunde: 'Düsseldorf',
      },
      title: 'ADBK Satellite Capture',
      body: [
        'ich arbeite heute in einer linuxmuster umgebung in der edulution installiert ist.',
        'Compose-Syntax + Env sind sauber resolved.',
        'Eine Sache stimmt nicht: Docker ist auf der VM NICHT installiert.',
        'Pull durch — alle 4 Images sind lokal.',
        'Damit ist die Vorbereitung komplett. Heute Abend nach dem edulution-ui-Update geht es weiter.',
        'Der Realm ist ADBK.LOCAL.',
        'Der KDC ist die Linuxmuster-Adresse 10.20.16.2.',
        'proxy.adbk.local ist auf 10.20.16.5 gesetzt.',
        'Docker service ist aktiv und Compose ist installiert.',
      ].join('\n\n'),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    return vault.init().then(() => {
      const result = vault.extractClaims({
        path: 'Kunden/Düsseldorf/ADBK Satellite Capture.md',
        maxClaims: 10,
        dryRun: true,
      })

      const claims = result.claims.map(claim => claim.claim).join('\n')
      assert.doesNotMatch(claims, /ich arbeite heute/)
      assert.doesNotMatch(claims, /Compose-Syntax/)
      assert.doesNotMatch(claims, /Eine Sache stimmt nicht/)
      assert.doesNotMatch(claims, /Pull durch/)
      assert.doesNotMatch(claims, /Vorbereitung komplett/)
      assert.match(claims, /Realm ist ADBK\.LOCAL/)
      assert.match(claims, /KDC ist die Linuxmuster-Adresse 10\.20\.16\.2/)
      assert.match(claims, /proxy\.adbk\.local ist auf 10\.20\.16\.5/)
      assert.match(claims, /Docker service ist aktiv/)
    })
  })

  test('does not write duplicate claims when auto-build processes an updated source again', () => {
    writeNote(vaultPath, {
      path: 'Kunden/Düsseldorf/ADBK Dedup Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture'],
        quelle: 'knowledge-harvester',
        kunde: 'Düsseldorf',
      },
      title: 'ADBK Dedup Capture',
      body: 'Der Realm ist ADBK.LOCAL.',
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    return vault.init().then(() => {
      const first = vault.extractClaims({
        path: 'Kunden/Düsseldorf/ADBK Dedup Capture.md',
        maxClaims: 5,
        dryRun: false,
      })
      const second = vault.extractClaims({
        path: 'Kunden/Düsseldorf/ADBK Dedup Capture.md',
        maxClaims: 5,
        dryRun: false,
      })

      assert.equal(first.written.length, 1)
      assert.equal(second.written.length, 0)
    })
  })
})
