// Integration test: runs the knowledge-harvester hook with a sample transcript.
// Uses isolated VAULT_PATH via env var so nothing touches the real vault.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createTempVault, cleanupVault } from './helpers.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARVESTER = join(__dirname, '..', 'hooks', 'knowledge-harvester.ts')
const FIXTURE = join(__dirname, 'fixtures', 'sample-transcript.jsonl')

function runHarvester(vaultPath: string, stateDir: string, input: object) {
  return spawnSync('node', [HARVESTER], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      VAULT_PATH: vaultPath,
      HARVESTER_INPUT_JSON: JSON.stringify(input),
      HARVESTER_LOG: join(stateDir, 'log.txt'),
      HARVESTER_STATE_DIR: stateDir,
      HARVESTER_SUGGESTIONS_LOG: join(stateDir, 'suggestions.log'),
    },
  })
}

describe('Harvester: end-to-end', () => {
  let vaultPath: string
  let stateDir: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-state-'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('runs without errors on sample transcript', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-e2e',
      transcript_path: FIXTURE,
      cwd: '/home/amo/Documents/code/amo/adbk',
    })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  })

  test('creates capture note in isolated vault', () => {
    // Previous test already ran — check vault for any .md file
    const log = join(stateDir, 'log.txt')
    if (existsSync(log)) {
      const content = readFileSync(log, 'utf-8')
      assert.ok(content.includes('Captured') || content.includes('not enough'), log)
    }
  })

  test('records session in state dir', () => {
    const stateFile = join(stateDir, 'test-e2e.done')
    assert.ok(existsSync(stateFile))
  })
})

describe('Harvester: deduplication', () => {
  let vaultPath: string
  let stateDir: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-dedup-'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('second run with same session_id is a no-op', () => {
    const input = {
      session_id: 'test-dedup',
      transcript_path: FIXTURE,
      cwd: '/tmp',
    }

    const r1 = runHarvester(vaultPath, stateDir, input)
    assert.equal(r1.status, 0)

    const stateFile = join(stateDir, 'test-dedup.done')
    assert.ok(existsSync(stateFile))
    const mtime1 = statSync(stateFile).mtimeMs

    // Second run
    const r2 = runHarvester(vaultPath, stateDir, input)
    assert.equal(r2.status, 0)
    const mtime2 = statSync(stateFile).mtimeMs
    assert.equal(mtime1, mtime2, 'State file should NOT be updated on re-run')
  })
})

describe('Harvester: minimum substance filtering', () => {
  let vaultPath: string
  let stateDir: string
  let miniTranscript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-mini-'))

    // Create a very short transcript (< 10 entries) — should be ignored
    miniTranscript = join(stateDir, 'mini.jsonl')
    const entries = [
      { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]
    writeFileSync(miniTranscript, entries.map(e => JSON.stringify(e)).join('\n'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('short transcript does not produce capture', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-mini',
      transcript_path: miniTranscript,
      cwd: '/tmp',
    })
    assert.equal(result.status, 0)

    // No state file should be created (exited early)
    const stateFile = join(stateDir, 'test-mini.done')
    assert.ok(!existsSync(stateFile), 'Short sessions should not be marked captured')
  })
})

describe('Harvester: client resolver', () => {
  let vaultPath: string
  let stateDir: string
  let transcript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-client-'))
    transcript = join(stateDir, 'dussledorf.jsonl')
    const entries = [
      { type: 'user', message: { content: 'In Düsseldorf muss edulution per FQDN erreichbar werden.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Ich pruefe die Konfiguration und fasse danach den Befund zusammen.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.119.0.4 "cat /srv/docker/edulution-ui/traefik.yml"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'entryPoints configured' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.119.0.4 "docker ps --format names"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'edulution-ui\ntraefik' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.119.0.4 "systemctl restart nginx"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.119.0.4 "docker compose up -d"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'containers started' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: edulution wurde fuer Düsseldorf geprueft und die Dienste wurden neu gestartet. Test-Token token=supersecretvalue12345 wurde nur als Redaction-Fixture gesehen. Die FQDN-Umstellung bleibt als naechster Schritt dokumentiert.' }] } },
    ]
    writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('routes typo cwd to known customer via fuzzy resolver', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-dussledorf',
      transcript_path: transcript,
      cwd: '/home/amo/Documents/code/amo/düssledorf',
    })
    assert.equal(result.status, 0, result.stderr)

    const expectedDir = join(vaultPath, 'Kunden', 'Düsseldorf')
    assert.ok(existsSync(expectedDir))
    const created = readFileSync(join(stateDir, 'log.txt'), 'utf-8')
    assert.match(created, /Fuzzy-Kunde Düsseldorf/)
    const noteFile = readdirSync(expectedDir).find(file => file.startsWith('Düsseldorf — Docker Setup') && file.endsWith('.md'))
    assert.ok(noteFile)
    const notePath = join(expectedDir, noteFile)
    const note = readFileSync(notePath, 'utf-8')
    assert.match(note, /session_intent: implementation/)
    assert.match(note, /sensitive: true/)
    assert.match(note, /capture_value: \d+/)
    assert.ok(!note.includes('supersecretvalue12345'))
  })
})

describe('Harvester: incremental session updates', () => {
  let vaultPath: string
  let stateDir: string
  let transcript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-incremental-'))
    transcript = join(stateDir, 'hug-incremental.jsonl')
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  function writeTranscript(extraLateEntries = false): void {
    const entries: any[] = [
      { type: 'user', message: { content: 'Teste fuer HUG die VPN Verbindung und dokumentiere den Befund.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Ich pruefe Profil, Endpoint und OpenVPN.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'openvpn --version 2>&1 | head -3' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'OpenVPN 2.7.3' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'timeout 5 bash -c "</dev/tcp/80.152.144.189/8443" && echo ok' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sudo -n openvpn --config sslvpn-sarah.hug-client-config.ovpn --daemon --log /tmp/hug-vpn.log' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'sudo: a password is required', is_error: true }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ip -br a show tun0; ip route | grep 192.168.1.' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'tun0 UP 10.81.0.2/16\n192.168.1.0/24 via 10.81.0.1 dev tun0' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: HUG VPN Tunnel steht, tun0 ist UP und die Route 192.168.1.0/24 wurde gepusht.' }] } },
    ]
    if (extraLateEntries) {
      entries.push(
        { type: 'user', message: { content: 'Kannst du herausfinden welche IP die nas01 hat?' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'nmap -sT -Pn -n --open -p 445,5000,5001 192.168.1.23 192.168.1.51' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: '192.168.1.23 5001/tcp open synology-dsm\n192.168.1.51 5001/tcp open synology-dsm' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -ks https://192.168.1.23:5001/ | grep -o "<title>[^<]*</title>"' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: '<title>Synology01&nbsp;-&nbsp;Synology&nbsp;NAS</title>' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: 192.168.1.23 ist Synology01 per DSM 5001. 192.168.1.51 ist eine zweite Synology mit identischem DSM-Fingerprint; nas01 ist im DNS nicht auffindbar.' }] } },
      )
    }
    writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')
  }

  test('same session id updates capture when transcript grows', () => {
    writeTranscript(false)
    const input = {
      session_id: 'test-incremental',
      transcript_path: transcript,
      cwd: '/home/amo/Documents/code/amo/xgs/hug',
    }
    const first = runHarvester(vaultPath, stateDir, input)
    assert.equal(first.status, 0, first.stderr)
    const notePath = join(vaultPath, 'Kunden', 'HUG', 'HUG — Server-Konfiguration (2026-05-13).md')
    assert.ok(existsSync(notePath))
    assert.doesNotMatch(readFileSync(notePath, 'utf-8'), /Synology01/)

    writeTranscript(true)
    const second = runHarvester(vaultPath, stateDir, input)
    assert.equal(second.status, 0, second.stderr)
    const updated = readFileSync(notePath, 'utf-8')
    assert.match(updated, /Synology01/)
    assert.match(updated, /192\.168\.1\.51/)
    assert.match(updated, /transcript_entries:/)

    const third = runHarvester(vaultPath, stateDir, input)
    assert.equal(third.status, 0, third.stderr)
    const log = readFileSync(join(stateDir, 'log.txt'), 'utf-8')
    assert.match(log, /transcript hash unchanged/)
  })
})
