// Tests for technik-categories.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyNote, loadCategories } from '../technik-categories.ts'

describe('Categories: loading', () => {
  test('loads categories from JSON', () => {
    const cats = loadCategories()
    assert.ok(cats.length > 0)
    const names = cats.map(c => c.name)
    assert.ok(names.includes('Docker'))
    assert.ok(names.includes('Linuxmuster'))
    assert.ok(names.includes('Proxmox'))
  })

  test('each category has required fields', () => {
    const cats = loadCategories()
    for (const cat of cats) {
      assert.ok(typeof cat.name === 'string')
      assert.ok(Array.isArray(cat.keywords))
      assert.ok(Array.isArray(cat.filenameHints))
      assert.ok(typeof cat.priority === 'number')
      assert.ok(typeof cat.subcategories === 'object')
    }
  })
})

describe('Categories: main classification', () => {
  test('Docker note classifies as Docker', () => {
    const result = classifyNote(
      'Docker Setup Guide',
      'docker compose up with nginx and traefik',
      ['docker', 'container'],
    )
    assert.equal(result.category, 'Docker')
  })

  test('Linuxmuster note classifies as Linuxmuster', () => {
    const result = classifyNote(
      'linuxmuster Installation',
      'sophomorix-check and linuxmuster-setup',
      ['linuxmuster'],
    )
    assert.equal(result.category, 'Linuxmuster')
  })

  test('GPO note classifies as Windows', () => {
    const result = classifyNote(
      'GPO Konfigurationen',
      'Group policies for windows domain',
      ['windows', 'gpo'],
    )
    assert.equal(result.category, 'Windows')
  })

  test('no match returns null category', () => {
    const result = classifyNote('Random Thought', 'Short body', [])
    assert.equal(result.category, null)
  })

  test('filename match dominates when only one category has title match', () => {
    // Title has "linuxmuster" (only Linuxmuster matches filename)
    // Tags say firewall - Netzwerk has no filename match
    // → Linuxmuster wins despite Netzwerk tag
    const result = classifyNote(
      'linuxmuster Konfiguration',
      'configuring the server setup',
      ['firewall'],
    )
    assert.equal(result.category, 'Linuxmuster')
  })
})

describe('Categories: subcategory classification', () => {
  test('Linbo note gets Linbo subcategory', () => {
    const result = classifyNote(
      'LINBO rsync Befehl',
      'rsync linbo/start.conf with patchclass for client',
      ['linuxmuster', 'linbo'],
    )
    assert.equal(result.category, 'Linuxmuster')
    assert.equal(result.subcategory, 'Linbo')
  })

  test('GPO note gets GPO subcategory', () => {
    const result = classifyNote(
      'GPO Konfigurationen',
      'group policy setup for windows',
      ['windows', 'gpo'],
    )
    assert.equal(result.category, 'Windows')
    assert.equal(result.subcategory, 'GPO')
  })

  test('ESXi Migration gets Migration subcategory', () => {
    const result = classifyNote(
      'ESXi zu Proxmox Migration',
      'vm migration from esxi to proxmox using v2v',
      ['proxmox', 'migration'],
    )
    assert.equal(result.category, 'Proxmox')
    assert.equal(result.subcategory, 'Migration')
  })

  test('hierarchical tag (parent/sub) detection', () => {
    const result = classifyNote(
      'Test Note',
      'Some content',
      ['linuxmuster/sophomorix'],
    )
    assert.equal(result.category, 'Linuxmuster')
    assert.equal(result.subcategory, 'Sophomorix')
  })

  test('main category without matching sub returns null subcategory', () => {
    const result = classifyNote(
      'Docker general note',
      'Generic docker stuff without specific subtopic',
      ['docker'],
    )
    assert.equal(result.category, 'Docker')
    // No specific sub like Traefik/Compose/Satellite mentioned
    assert.equal(result.subcategory, null)
  })
})

describe('Categories: topic candidate extraction', () => {
  test('extracts hyphenated compound names', () => {
    const result = classifyNote(
      'New Thing Setup',
      'Working with my-awesome-product and another-cool-tool. ' +
      'my-awesome-product has features. my-awesome-product is great. ' +
      'another-cool-tool works well. another-cool-tool is fast. another-cool-tool rocks.',
      ['docker'],
    )
    // Should suggest at least one of them (count >= 3 each)
    assert.ok(result.topicCandidates.length > 0)
  })

  test('filters out noise patterns', () => {
    const result = classifyNote(
      'Disk Setup',
      'disk-1 disk-1 disk-1 add-json add-json add-json',
      ['proxmox'],
    )
    // disk-N and add-* should be filtered
    for (const cand of result.topicCandidates) {
      assert.ok(!cand.match(/^disk-\d/))
      assert.ok(!cand.startsWith('add-'))
    }
  })

  test('does not suggest already-known keywords', () => {
    const result = classifyNote(
      'Test',
      'docker-compose docker-compose docker-compose',
      ['docker'],
    )
    // compose is already known as Docker subcategory
    assert.ok(!result.topicCandidates.includes('docker-compose'))
  })
})
