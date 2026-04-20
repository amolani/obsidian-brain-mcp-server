// Tests for suggestions.ts (list + promote)

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Suggestions: parsing and promoting', () => {
  let tmpDir: string
  let categoriesPath: string
  let clientsPath: string
  let technikLog: string
  let clientLog: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sugg-'))
    categoriesPath = join(tmpDir, 'technik-categories.json')
    clientsPath = join(tmpDir, 'clients.json')
    technikLog = join(tmpDir, 'technik-suggestions.log')
    clientLog = join(tmpDir, 'client-suggestions.log')

    // Seed minimal valid configs
    writeFileSync(categoriesPath, JSON.stringify({
      Docker: {
        keywords: ['docker'],
        filenameHints: ['docker'],
        priority: 8,
        subcategories: {
          Traefik: { keywords: ['traefik'], filenameHints: ['traefik'] },
        },
      },
    }, null, 2))

    writeFileSync(clientsPath, JSON.stringify({
      Existing: ['existing-one'],
    }, null, 2))

    // Set env for this run
    process.env.TECHNIK_CATEGORIES_PATH = categoriesPath
    process.env.CLIENTS_PATH = clientsPath
    process.env.TECHNIK_SUGGESTIONS_LOG = technikLog
    process.env.HARVESTER_SUGGESTIONS_LOG = clientLog
  })

  after(() => {
    delete process.env.TECHNIK_CATEGORIES_PATH
    delete process.env.CLIENTS_PATH
    delete process.env.TECHNIK_SUGGESTIONS_LOG
    delete process.env.HARVESTER_SUGGESTIONS_LOG
  })

  test('listSuggestions returns empty when no logs exist', async () => {
    // Fresh import per test to avoid module cache
    const { listSuggestions } = await import('../suggestions.ts')
    const result = listSuggestions()
    assert.equal(result.technik.length, 0)
    assert.equal(result.clients.length, 0)
  })

  test('parses and aggregates technik suggestions', async () => {
    writeFileSync(technikLog, [
      '2026-04-20T08:00:00.000Z VORSCHLAG Unterkategorie: "edulution-satellite" unter Docker',
      '  Pfad: Technik/Docker/Edulution-satellite/',
      '  Kontext: ADBK Setup',
      '  → Hinzufügen',
      '',
      '2026-04-20T09:00:00.000Z VORSCHLAG Unterkategorie: "edulution-satellite" unter Docker',
      '  Pfad: Technik/Docker/Edulution-satellite/',
      '  Kontext: Merian Setup',
      '  → Hinzufügen',
      '',
    ].join('\n'))

    const { listSuggestions } = await import('../suggestions.ts')
    const result = listSuggestions()
    assert.equal(result.technik.length, 1)
    assert.equal(result.technik[0].candidate, 'edulution-satellite')
    assert.equal(result.technik[0].parent, 'Docker')
    assert.equal(result.technik[0].count, 2)
  })

  test('parses client suggestions', async () => {
    writeFileSync(clientLog, [
      '2026-04-20T08:00:00.000Z VORSCHLAG: "new-client" als Kunde registrieren? (Pfad: /some/path)',
      '  → Hinzufügen',
      '',
    ].join('\n'))

    const { listSuggestions } = await import('../suggestions.ts')
    const result = listSuggestions()
    assert.equal(result.clients.length, 1)
    assert.equal(result.clients[0].candidate, 'new-client')
  })

  test('promoteTechnikSuggestion adds new subcategory', async () => {
    const { promoteTechnikSuggestion } = await import("../suggestions.ts")
    const result = promoteTechnikSuggestion('Docker', 'edulution-satellite')
    assert.equal(result.category, 'Docker')
    assert.equal(result.existed, false)

    const data = JSON.parse(readFileSync(categoriesPath, 'utf-8'))
    assert.ok(data.Docker.subcategories['Edulution-Satellite'])
    assert.ok(data.Docker.subcategories['Edulution-Satellite'].keywords.includes('edulution-satellite'))
  })

  test('promoteTechnikSuggestion throws for unknown parent', async () => {
    const { promoteTechnikSuggestion } = await import("../suggestions.ts")
    assert.throws(() => promoteTechnikSuggestion('NonExistent', 'whatever'), /existiert nicht/)
  })

  test('promoteClientSuggestion adds new client', async () => {
    const { promoteClientSuggestion } = await import("../suggestions.ts")
    const result = promoteClientSuggestion('new-client')
    assert.equal(result.existed, false)
    assert.equal(result.name, 'New-Client')

    const data = JSON.parse(readFileSync(clientsPath, 'utf-8'))
    assert.ok(data['New-Client'])
    assert.ok(data['New-Client'].includes('new-client'))
  })

  test('promoteClientSuggestion with canonical name', async () => {
    const { promoteClientSuggestion } = await import("../suggestions.ts")
    promoteClientSuggestion('adbk', 'ADBK', ['albert-dürer', 'ad-bk'])

    const data = JSON.parse(readFileSync(clientsPath, 'utf-8'))
    assert.ok(data.ADBK)
    assert.ok(data.ADBK.includes('adbk'))
    assert.ok(data.ADBK.includes('albert-dürer'))
  })

  test('promote removes matching entries from log', async () => {
    writeFileSync(technikLog, [
      '2026-04-20T08:00:00.000Z VORSCHLAG Unterkategorie: "foo" unter Docker',
      '  Pfad: Technik/Docker/Foo/',
      '  Kontext: X',
      '  → Hinzufügen',
      '',
      '2026-04-20T09:00:00.000Z VORSCHLAG Unterkategorie: "bar" unter Docker',
      '  Pfad: Technik/Docker/Bar/',
      '  Kontext: Y',
      '  → Hinzufügen',
      '',
    ].join('\n'))

    const { promoteTechnikSuggestion } = await import("../suggestions.ts")
    promoteTechnikSuggestion('Docker', 'foo')

    const remaining = readFileSync(technikLog, 'utf-8')
    assert.ok(!remaining.includes('"foo"'), 'foo should be removed from log')
    assert.ok(remaining.includes('"bar"'), 'bar should remain in log')
  })
})
