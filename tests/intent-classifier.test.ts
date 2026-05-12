import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyIntent } from '../services/intent-classifier.ts'

describe('intent classifier', () => {
  test('detects implementation from mutating commands', () => {
    const result = classifyIntent([
      '## Durchgeführte Befehle',
      '',
      '1. `systemctl restart nginx`',
      '2. `docker compose up -d`',
      '',
      '## Zusammenfassung',
      '',
      'Der Dienst wurde konfiguriert und neu gestartet.',
    ].join('\n'), ['prozedur'])

    assert.equal(result.intent, 'implementation')
    assert.ok(result.score >= 4)
  })

  test('detects research when commands are read-only', () => {
    const result = classifyIntent([
      '## Zusammenfassung',
      '',
      'Recherche-Zusammenfassung: DNS und Traefik wurden geprueft.',
      '',
      '## Durchgeführte Befehle',
      '',
      '1. `dig NS example.org @1.1.1.1`',
      '2. `cat /srv/docker/edulution-ui/traefik.yml`',
      '3. `docker ps --format names`',
    ].join('\n'))

    assert.equal(result.intent, 'research')
    assert.ok(result.reasons.some(reason => /read-only|Recherche/.test(reason)))
  })
})
