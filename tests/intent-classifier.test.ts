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

  test('detects a short command-free architecture decision as planning', () => {
    const result = classifyIntent(
      'Entscheidung: Wir legen Blue-Green als Migrationsverfahren und Sonntag 22:00 Uhr als Wartungsfenster fest.',
    )

    assert.equal(result.intent, 'planning')
    assert.ok(result.score >= 4)
  })

  test('detects meeting notes without requiring shell activity', () => {
    const result = classifyIntent(
      'Besprechungsprotokoll: Teilnehmer haben die Agenda und den Termin für die Abnahme abgestimmt.',
    )

    assert.equal(result.intent, 'meeting')
    assert.ok(result.score >= 5)
  })
})
