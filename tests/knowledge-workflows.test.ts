import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('manual knowledge workflows', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Netzwerk/DHCP.md',
      frontmatter: { status: 'aktiv', tags: ['dhcp', 'netzwerk'] },
      title: 'DHCP',
      body: 'DHCP laeuft fuer Schule A auf der Firewall.\n\n- [ ] Scope pruefen\n',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('save_insight defaults to dry-run and apply writes indexed note', () => {
    const preview = vault.saveInsight({
      title: 'DHCP bleibt Firewall-Aufgabe',
      content: 'Linuxmuster soll DHCP nur weiterleiten.',
    })

    assert.equal(preview.dryRun, true)
    assert.equal(preview.path, 'Knowledge/Insights/DHCP bleibt Firewall-Aufgabe.md')
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.saveInsight({
      title: 'DHCP bleibt Firewall-Aufgabe',
      content: 'Linuxmuster soll DHCP nur weiterleiten.',
      tags: ['DHCP'],
      dryRun: false,
    })

    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
    assert.ok(vault.getNoteContext(applied.path))
    assert.match(readFileSync(join(vaultPath, applied.path), 'utf-8'), /manual-save/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"save_insight"/)
  })

  test('hot cache is manual and dry-run-first', () => {
    const preview = vault.updateHotCache({ query: 'dhcp', dryRun: true })

    assert.equal(preview.dryRun, true)
    assert.equal(preview.path, 'Knowledge/hot.md')
    assert.ok(preview.content.includes('nicht automatisch in Sessions injiziert'))
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'hot.md')))

    const applied = vault.updateHotCache({ query: 'dhcp', dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'hot.md')))
    assert.match(vault.readHotCache().content, /Hot Cache/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"update_hot_cache"/)
  })

  test('knowledge index summarizes vault and writes only on apply', () => {
    const preview = vault.buildKnowledgeIndex()
    assert.equal(preview.dryRun, true)
    assert.ok(preview.content.includes('## Bereiche'))
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'index.md')))

    const applied = vault.buildKnowledgeIndex({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
    assert.ok(vault.getNoteContext(applied.path))
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"build_knowledge_index"/)
  })

  test('knowledge gaps and contradictions can be listed and resolved', () => {
    const gap = vault.flagKnowledgeGap({
      question: 'Welche DHCP Rolle hat linuxmuster?',
      context: 'Unklar zwischen Kundennotiz und Referenz.',
      dryRun: false,
    })
    const contradiction = vault.flagContradiction({
      title: 'DHCP Zuständigkeit',
      claimA: 'DHCP laeuft auf linuxmuster.',
      claimB: 'DHCP laeuft auf der Firewall.',
      sources: ['Technik/Netzwerk/DHCP.md'],
      dryRun: false,
    })

    const open = vault.listOpenQuestions()
    assert.equal(open.length, 2)
    assert.ok(open.some(item => item.path === gap.path && item.type === 'gap'))
    assert.ok(open.some(item => item.path === contradiction.path && item.type === 'contradiction'))

    const preview = vault.resolveGap({
      path: gap.path,
      resolution: 'Firewall ist zuständig; linuxmuster forwarded nur.',
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.match(preview.content, /status: resolved/)

    vault.resolveGap({
      path: gap.path,
      resolution: 'Firewall ist zuständig; linuxmuster forwarded nur.',
      dryRun: false,
    })
    assert.equal(vault.listOpenQuestions().length, 1)
    assert.match(readFileSync(join(vaultPath, gap.path), 'utf-8'), /## Lösung/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"resolve_gap"/)
  })

  test('knowledge gaps are idempotent for the same open question', () => {
    const first = vault.flagKnowledgeGap({
      question: 'Welche DHCP Rolle hat linuxmuster?',
      context: 'Erster Auto-Build-Lauf.',
      dryRun: false,
    })
    const second = vault.flagKnowledgeGap({
      question: 'Welche DHCP Rolle hat linuxmuster?',
      context: 'Aktualisierte Capture mit derselben offenen Frage.',
      dryRun: false,
    })

    assert.equal(second.skipped, true)
    assert.equal(second.path, first.path)
    assert.equal(vault.listOpenQuestions().filter(item => item.type === 'gap').length, 1)
  })

  test('research plan uses local context and writes only on apply', () => {
    const preview = vault.createResearchPlan({
      topic: 'DHCP Zuständigkeit',
      question: 'Wo soll DHCP fuer Schulen laufen?',
      sources: ['.raw/vendor/dhcp.md'],
    })

    assert.equal(preview.dryRun, true)
    assert.ok(preview.content.includes('Bekannter Vault-Kontext'))
    assert.ok(preview.contextCount >= 1)
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.createResearchPlan({
      topic: 'DHCP Zuständigkeit',
      question: 'Wo soll DHCP fuer Schulen laufen?',
      dryRun: false,
    })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
    assert.ok(vault.getNoteContext(applied.path))
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"create_research_plan"/)
  })
})
