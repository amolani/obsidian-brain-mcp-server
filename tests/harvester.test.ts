// Integration test: runs the knowledge-harvester hook with a sample transcript.
// Uses isolated VAULT_PATH via env var so nothing touches the real vault.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Vault } from '../vault.ts'
import { parseFrontmatter } from '../services/note-parser.ts'
import {
  CALIBRATION_CAPTURE_SCHEMA,
  parseCalibrationCaptureBundle,
} from '../services/calibration-capture.ts'
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

interface CaptureState {
  capturePath?: string
  bashCount: number
  transcriptHash: string
  calibrationSampleSeed?: string
}

function readCapturedSession(vaultPath: string, stateDir: string, sessionId: string): {
  state: CaptureState
  relativePath: string
  content: string
} {
  const stateFile = join(stateDir, `${sessionId}.json`)
  assert.ok(existsSync(stateFile), `Missing capture state for ${sessionId}`)
  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as CaptureState
  assert.ok(state.capturePath, `Session ${sessionId} has no capture path`)
  return {
    state,
    relativePath: state.capturePath,
    content: readFileSync(join(vaultPath, state.capturePath), 'utf-8'),
  }
}

function assertTypedDigest(content: string): void {
  assert.match(content, /abstraction_mode: typed_knowledge_atoms/)
  assert.match(content, /importance_model: knowledge-salience-v\d+/)
  assert.match(content, /importance_score: \d+/)
  assert.match(content, /evidence_score: \d+/)
  assert.match(content, /## Session Digest/)
  assert.match(content, /- \[F\d+\] /, 'Digest should contain at least one typed fact')
  assert.match(content, /Salienz \d+\/100 · Evidenz \d+\/100/)
  assert.match(content, /### Evidenz/)
  assert.doesNotMatch(content, /^## Zusammenfassung$/m)
  const frontmatter = parseFrontmatter(content)
  assert.ok(Array.isArray(frontmatter.knowledge_fact_ids))
  assert.ok(Array.isArray(frontmatter.calibration_fact_map))
  assert.ok(Array.isArray(frontmatter.calibration_snapshot_fingerprints))
  assert.ok(Array.isArray(frontmatter.calibration_snapshot_payloads))
  assert.ok(Array.isArray(frontmatter.calibration_review_map))
  assert.ok(Array.isArray(frontmatter.calibration_review_payloads))
  assert.match(String(frontmatter.calibration_sample_seed), /^cs-[a-f0-9]{32}$/)
  assert.equal(frontmatter.knowledge_fact_ids.length, Number(frontmatter.knowledge_fact_count))
  assert.equal(frontmatter.calibration_capture_schema, CALIBRATION_CAPTURE_SCHEMA)
  const bundle = parseCalibrationCaptureBundle(frontmatter)
  assert.deepEqual(bundle.selectedFactIds, frontmatter.knowledge_fact_ids)
  assert.ok(bundle.facts.length >= bundle.selectedFactIds.length)
  assert.equal(frontmatter.calibration_fact_map.length, bundle.facts.length)
  assert.equal(frontmatter.calibration_snapshot_payloads.length, bundle.facts.length)
  assert.equal(frontmatter.calibration_review_map.length, bundle.facts.length)
  assert.equal(frontmatter.calibration_review_payloads.length, bundle.facts.length)
  for (const [index, factId] of bundle.selectedFactIds.entries()) {
    assert.equal(bundle.facts[index]?.reference, `F${index + 1}`)
    assert.equal(bundle.facts[index]?.factId, factId)
  }
  assert.doesNotMatch(content, /^## Kalibrierungsstichprobe$/m)
  for (const fact of bundle.facts.filter(item => item.reference.startsWith('C'))) {
    assert.doesNotMatch(content, new RegExp(`^- \\[${fact.reference}\\] `, 'm'))
    assert.ok(fact.review.statement.length > 0)
    assert.ok(fact.review.evidence.length > 0)
  }
  for (const raw of frontmatter.calibration_snapshot_payloads) {
    const payload = JSON.parse(String(raw)) as Record<string, unknown>
    assert.match(String(payload.factId), /^ks-[a-f0-9]{20}$/)
    assert.equal(typeof payload.generatedAt, 'string')
    assert.equal(typeof payload.evaluationSample, 'boolean')
    assert.equal(typeof payload.samplingProbability, 'number')
    assert.equal(Object.hasOwn(payload, 'statement'), false)
    assert.equal(Object.hasOwn(payload, 'excerpt'), false)
  }
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

  test('contains hostile session ids in the state dir and quotes them in frontmatter', () => {
    const sessionId = '../escaped\nclaim_status: confirmed'
    const escapedLegacyPath = join(dirname(stateDir), 'escaped\nclaim_status: confirmed.done')
    const result = runHarvester(vaultPath, stateDir, {
      session_id: sessionId,
      transcript_path: FIXTURE,
      cwd: '/home/amo/Documents/code/amo/adbk',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.ok(!existsSync(escapedLegacyPath))
    const stateFile = readdirSync(stateDir).find(name => /^session-[a-f0-9]{24}\.json$/.test(name))
    assert.ok(stateFile)
    const state = JSON.parse(readFileSync(join(stateDir, stateFile), 'utf-8')) as { capturePath: string }
    const capture = readFileSync(join(vaultPath, state.capturePath), 'utf-8')
    const frontmatter = parseFrontmatter(capture)
    const expectedSessionId = `session-${
      createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
    }`
    assert.equal(frontmatter.session_id, expectedSessionId)
    assert.equal(frontmatter.claim_status, undefined)
    assert.doesNotMatch(capture, /escaped\nclaim_status/)
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

describe('Harvester: short high-value session', () => {
  let vaultPath: string
  let stateDir: string
  let decisionTranscript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-short-decision-'))
    decisionTranscript = join(stateDir, 'decision.jsonl')
    const entries = [
      { type: 'user', message: { content: 'Wir müssen die Aufbewahrung der Backups verbindlich festlegen.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Entscheidung: Tägliche Backups werden 30 Tage aufbewahrt; Monatsarchive bleiben 12 Monate. Damit ist die Wiederherstellungsanforderung abgedeckt.' }] } },
    ]
    writeFileSync(decisionTranscript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('captures an explicit important decision without Bash as a typed fact', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-short-decision',
      transcript_path: decisionTranscript,
      cwd: '/tmp',
    })
    assert.equal(result.status, 0, result.stderr)

    const capture = readCapturedSession(vaultPath, stateDir, 'test-short-decision')
    const frontmatter = parseFrontmatter(capture.content)
    assert.equal(capture.state.bashCount, 0)
    assert.equal(frontmatter.transcript_bash_commands, 0)
    assert.equal(frontmatter.abstraction_mode, 'typed_knowledge_atoms')
    assert.equal(frontmatter.importance_model, 'knowledge-salience-v1')
    assert.ok(Number(frontmatter.importance_score) >= 45)
    assert.ok(Number(frontmatter.evidence_score) >= 45)
    assertTypedDigest(capture.content)
    assert.match(capture.content, /### Entscheidung\n\n- \[F\d+\] /)
    assert.doesNotMatch(capture.content, /^## Durchgef.hrte Befehle$/m)
    assert.doesNotMatch(capture.content, /Zusammenfassung:\s*T.gliche Backups/)
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

  test('keeps a fuzzy customer match neutral and marks it for review', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-dussledorf',
      transcript_path: transcript,
      cwd: '/home/amo/Documents/code/amo/düssledorf',
    })
    assert.equal(result.status, 0, result.stderr)

    const capture = readCapturedSession(vaultPath, stateDir, 'test-dussledorf')
    assert.ok(!capture.relativePath.startsWith('Kunden/'), 'Fuzzy matches must not route into a customer folder')
    const created = readFileSync(join(stateDir, 'log.txt'), 'utf-8')
    assert.match(created, /Fuzzy-Kunde Düsseldorf/)
    const frontmatter = parseFrontmatter(capture.content)
    assert.equal(frontmatter.kunde, undefined)
    assert.equal(frontmatter.client_match_method, 'fuzzy_cwd')
    assert.equal(frontmatter.client_match_alias, 'düsseldorf')
    assert.equal(frontmatter.sensitive, true, 'A secret found only in source text must still mark the capture sensitive')
    assert.ok(Number(frontmatter.redactions) >= 1)
    assertTypedDigest(capture.content)
    assert.match(capture.content, /### Review\n\n(?:- \[F\d+\][^\n]*\n)*- Kundenzuordnung pr.fen:/)
    assert.ok(!capture.content.includes('supersecretvalue12345'))
  })
})

describe('Harvester: unknown customer review signal', () => {
  let vaultPath: string
  let stateDir: string
  let transcript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-unknown-client-'))
    transcript = join(stateDir, 'abt-ulrich.jsonl')
    const entries = [
      { type: 'user', message: { content: 'In der Abt-Ulrich-Schule funktioniert die linuxmuster Schulkonsole nicht.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Ich pruefe linuxmuster-webui, Ajenti und systemd.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.196.33.10 "systemctl status linuxmuster-webui --no-pager -l | head -40"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: "Active: inactive (dead)\nCan't open PID file /run/ajenti.pid: Operation not permitted" }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.196.33.10 "tail -100 /var/log/ajenti/ajenti.log"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: "KeyError: 'socket'" }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.196.33.10 "sed -i s/^  mode: unix/  mode: tcp/ /etc/ajenti/config.yml && systemctl restart linuxmuster-webui"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.196.33.10 "ss -tlnp | grep :443 && systemctl is-active linuxmuster-webui"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'LISTEN 0.0.0.0:443\nactive' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: linuxmuster-webui.service ist active running und lauscht auf 0.0.0.0:443. Root Cause war eine widerspruechliche Ajenti-Konfiguration: bind.mode unix ohne bind.socket, obwohl TCP/SSL konfiguriert war.' }] } },
    ]
    writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('stores unknown cwd candidate in capture metadata and Knowledge Inbox', async () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-abt-ulrich-unknown-client',
      transcript_path: transcript,
      cwd: '/home/amo/Documents/code/amo/Abt-Ulrich-Schule',
    })
    assert.equal(result.status, 0, result.stderr)

    const suggestions = readFileSync(join(stateDir, 'suggestions.log'), 'utf-8')
    assert.match(suggestions, /abt-ulrich-schule/)

    const linuxmusterDir = join(vaultPath, 'Technik', 'Linuxmuster')
    const captureFile = readdirSync(linuxmusterDir).find(file => file.endsWith('.md'))
    assert.ok(captureFile)
    const capturePath = join(linuxmusterDir, captureFile)
    assert.ok(existsSync(capturePath))
    const capture = readFileSync(capturePath, 'utf-8')
    assert.match(capture, /client_match_method: unknown_cwd/)
    assert.match(capture, /client_match_candidate: abt-ulrich-schule/)
    assertTypedDigest(capture)
    assert.match(capture, /### Root Cause\n\n- \[F\d+\] /)
    assert.match(capture, /### Verifikation\n\n(?:- \[F\d+\] [^\n]+\n?)+/)
    assert.match(capture, /Kunden-\/Projektkandidat aus CWD prüfen: `abt-ulrich-schule`/)

    const vault = new Vault(vaultPath)
    await vault.init()
    try {
      const inbox = vault.buildKnowledgeInbox({ dryRun: true })
      assert.equal(inbox.uncertainClientCount, 1)
      assert.match(inbox.content, /unknown_cwd\/low/)
      assert.match(inbox.content, /abt-ulrich-schule/)
      assert.match(inbox.content, /review_client_alias/)
    } finally {
      vault.shutdown()
    }
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
    const hugDir = join(vaultPath, 'Kunden', 'HUG')
    const noteFile = readdirSync(hugDir).find(file => file.startsWith('HUG — Server-Konfiguration') && file.endsWith('.md'))
    assert.ok(noteFile)
    const notePath = join(hugDir, noteFile)
    assert.ok(existsSync(notePath))
    const firstContent = readFileSync(notePath, 'utf-8')
    const firstFrontmatter = parseFrontmatter(firstContent)
    assert.doesNotMatch(firstContent, /Synology01/)
    assert.match(String(firstFrontmatter.calibration_sample_seed), /^cs-[a-f0-9]{32}$/)

    writeTranscript(true)
    const second = runHarvester(vaultPath, stateDir, input)
    assert.equal(second.status, 0, second.stderr)
    const updated = readFileSync(notePath, 'utf-8')
    assert.match(updated, /Synology01/)
    assert.match(updated, /192\.168\.1\.51/)
    assert.match(updated, /transcript_entries:/)
    const updatedFrontmatter = parseFrontmatter(updated)
    assert.equal(
      updatedFrontmatter.calibration_sample_seed,
      firstFrontmatter.calibration_sample_seed,
      'Incremental updates must retain the original random sampling seed',
    )

    const third = runHarvester(vaultPath, stateDir, input)
    assert.equal(third.status, 0, third.stderr)
    const log = readFileSync(join(stateDir, 'log.txt'), 'utf-8')
    assert.match(log, /transcript hash unchanged/)
  })
})

describe('Harvester: capture hygiene', () => {
  let vaultPath: string
  let stateDir: string
  let transcript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-hygiene-'))
    transcript = join(stateDir, 'adbk-hygiene.jsonl')
    const entries = [
      { type: 'user', message: { content: 'Ich bereite bei ADBK den edulution Satellite vor und installiere Docker.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Ich pruefe zuerst Realm, Proxy und Satellite-VM.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.20.16.2 "samba-tool domain info 127.0.0.1 | head -20"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'Realm: ADBK.LOCAL' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.20.16.4 "apt install -y docker-ce docker-ce-cli containerd.io"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'installed' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.20.16.4 "systemctl enable --now docker"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'active' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.20.16.4 "cat > .env << EOF\\nNETWORKBOX_JWT_SECRET=$(openssl rand -hex 40)\\nEOF"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'env written' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ssh root@10.20.16.4 "docker compose pull"' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'pulled' }] } },
      { type: 'user', message: { content: '<task-notification><task-id>abc</task-id><tool-use-id>toolu_test</tool-use-id></task-notification>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Pull durch — alle 4 Images sind lokal.' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: WebUI Login wurde getestet. Passwort: `VHS-Offenbach2026!`. ISO-Testlink war https://software.download.prss.microsoft.com/dbazure/Win11_25H2_German_x64.iso?t=download-token&P1=1778913019&P4=signature.' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Zusammenfassung: ADBK Satellite ist vorbereitet. Realm ist ADBK.LOCAL, Docker ist aktiv, Compose-Images sind lokal, und proxy.adbk.local zeigt auf 10.20.16.5.' }] } },
    ]
    writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('filters internal task notifications and verbose secret commands', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-adbk-hygiene',
      transcript_path: transcript,
      cwd: '/home/amo/Documents/code/amo/adbk',
    })
    assert.equal(result.status, 0, result.stderr)

    const dir = join(vaultPath, 'Kunden', 'ADBK')
    const noteFile = readdirSync(dir).find(file => file.endsWith('.md'))
    assert.ok(noteFile)
    const note = readFileSync(join(dir, noteFile), 'utf-8')
    const frontmatter = parseFrontmatter(note)
    assert.equal(frontmatter.kunde, 'ADBK')
    assert.equal(frontmatter.sensitive, true)
    assert.ok(Number(frontmatter.redactions) >= 2)
    assert.ok(Array.isArray(frontmatter.redaction_types))
    assert.ok(frontmatter.redaction_types.includes('credential_label'))
    assert.ok(frontmatter.redaction_types.includes('signed_download_url'))
    assertTypedDigest(note)
    assert.match(note, /### Ergebnis\n\n- \[F\d+\] /)
    assert.doesNotMatch(note, /task-notification/)
    assert.doesNotMatch(note, /toolu_test/)
    assert.doesNotMatch(note, /NETWORKBOX_JWT_SECRET/)
    assert.doesNotMatch(note, /VHS-Offenbach2026!/)
    assert.doesNotMatch(note, /download-token/)
    assert.doesNotMatch(note, /P4=signature/)
    assert.doesNotMatch(note, /Pull durch/)
    assert.doesNotMatch(note, /Zusammenfassung:\s*ADBK Satellite/)
    const actionLog = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, any>)
      .findLast(entry => entry.tool === 'auto_capture')
    assert.ok(actionLog)
    assert.equal(
      Object.hasOwn(actionLog.meta.salience, 'calibrationCandidates'),
      false,
      'The full calibration candidate universe must never be duplicated into the action log',
    )
    assert.equal(Object.hasOwn(actionLog.meta.salience, 'facts'), false)
  })
})

describe('Harvester: safe title surfaces', () => {
  test('redacts a secret from path, capture, harvester log, action log, and daily link', () => {
    const secret = 'supersecretvalue12345'
    const vaultPath = createTempVault()
    const stateDir = mkdtempSync(join(tmpdir(), 'harvester-title-secret-'))
    try {
      const datum = new Date().toISOString().split('T')[0]
      const dailyPath = join(vaultPath, 'Daily', `${datum}.md`)
      mkdirSync(dirname(dailyPath), { recursive: true })
      writeFileSync(dailyPath, `# ${datum}\n`, 'utf-8')

      const transcript = join(stateDir, 'secret-title.jsonl')
      const entries = [
        { type: 'user', message: { content: `password=${secret} Halte nur die Entscheidung zur Backup-Aufbewahrung fest.` } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Entscheidung: Tägliche Backups bleiben 30 Tage erhalten; Monatsarchive bleiben 12 Monate erhalten.' }] } },
      ]
      writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')

      const result = runHarvester(vaultPath, stateDir, {
        session_id: 'test-secret-title-surfaces',
        transcript_path: transcript,
        cwd: '/tmp',
      })
      assert.equal(result.status, 0, result.stderr)

      const capture = readCapturedSession(vaultPath, stateDir, 'test-secret-title-surfaces')
      const harvesterLog = readFileSync(join(stateDir, 'log.txt'), 'utf-8')
      const actionLogPath = join(vaultPath, '.action-log.jsonl')
      assert.ok(existsSync(actionLogPath), 'Expected the capture and daily-link action log')
      const actionLog = readFileSync(actionLogPath, 'utf-8')
      const daily = readFileSync(dailyPath, 'utf-8')

      const surfaces = {
        path: capture.relativePath,
        capture: capture.content,
        harvesterLog,
        actionLog,
        daily,
      }
      for (const [surface, value] of Object.entries(surfaces)) {
        assert.ok(!value.includes(secret), `${surface} leaked the title secret`)
      }
      assert.match(capture.relativePath, /REDACTED_SECRET/, 'The safe title should be used for the capture path')
    } finally {
      cleanupVault(vaultPath)
      cleanupVault(stateDir)
    }
  })
})

describe('Harvester: evidence-bound Technik routing', () => {
  test('routes from selected facts instead of an unselected Docker summary and tool tag', () => {
    const vaultPath = createTempVault()
    const stateDir = mkdtempSync(join(tmpdir(), 'harvester-routing-evidence-'))
    try {
      const transcript = join(stateDir, 'network-decision.jsonl')
      const entries = [
        { type: 'user', message: { content: 'Halte nur die Entscheidung zum VLAN-Routing und DNS fest.' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Entscheidung: VLAN 42 nutzt zentrales Routing und internes DNS für die Verwaltungsclients.' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Ergebnis: Der nur zur Diagnose verwendete Docker-Container war aktiv; dieser Nebenbefund ist fachlich ohne Bedeutung.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'docker ps --format names' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'temporary-diagnostic-container' }] } },
      ]
      writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')

      const result = runHarvester(vaultPath, stateDir, {
        session_id: 'test-evidence-bound-routing',
        transcript_path: transcript,
        cwd: '/tmp',
      })
      assert.equal(result.status, 0, result.stderr)

      const capture = readCapturedSession(vaultPath, stateDir, 'test-evidence-bound-routing')
      assert.match(capture.relativePath, /^Technik\/Netzwerk\//)
      assert.doesNotMatch(capture.relativePath, /^Technik\/Docker\//)
      const frontmatter = parseFrontmatter(capture.content)
      assert.ok(!Array.isArray(frontmatter.tags) || !frontmatter.tags.includes('docker'))
    } finally {
      cleanupVault(vaultPath)
      cleanupVault(stateDir)
    }
  })

  test('keeps an uncategorized selected decision neutral despite an incidental Docker command', () => {
    const vaultPath = createTempVault()
    const stateDir = mkdtempSync(join(tmpdir(), 'harvester-routing-neutral-'))
    try {
      const transcript = join(stateDir, 'neutral-decision.jsonl')
      const entries = [
        { type: 'user', message: { content: 'Halte nur diese Entscheidung für den Betrieb fest.' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Entscheidung: Das Wartungsfenster bleibt sonntags um 03:00 UTC.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'docker ps' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'unrelated-container' }] } },
      ]
      writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n'), 'utf-8')

      const result = runHarvester(vaultPath, stateDir, {
        session_id: 'test-neutral-routing',
        transcript_path: transcript,
        cwd: '/tmp',
      })
      assert.equal(result.status, 0, result.stderr)

      const capture = readCapturedSession(vaultPath, stateDir, 'test-neutral-routing')
      assert.match(capture.relativePath, /^Referenz\//)
      assert.doesNotMatch(capture.relativePath, /^Technik\/Docker\//)
    } finally {
      cleanupVault(vaultPath)
      cleanupVault(stateDir)
    }
  })
})
