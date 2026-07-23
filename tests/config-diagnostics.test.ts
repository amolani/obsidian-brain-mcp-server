import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseConfigFiles, loadClients, reloadConfig } from '../config.ts'

const originalClientsPath = process.env.CLIENTS_PATH
const roots: string[] = []

afterEach(() => {
  if (originalClientsPath === undefined) delete process.env.CLIENTS_PATH
  else process.env.CLIENTS_PATH = originalClientsPath
  reloadConfig()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('configuration diagnostics', () => {
  test('accepts the checked-in configuration files', () => {
    const diagnostics = diagnoseConfigFiles()

    assert.equal(diagnostics.length, 4)
    assert.equal(diagnostics.every(item => item.valid), true)
  })

  test('reports malformed override files instead of silently treating them as empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-config-invalid-'))
    roots.push(root)
    const clientsPath = join(root, 'clients.json')
    writeFileSync(clientsPath, '{ invalid json', 'utf-8')
    process.env.CLIENTS_PATH = clientsPath

    const clients = diagnoseConfigFiles().find(item => item.id === 'clients')

    assert.equal(clients?.valid, false)
    assert.match(clients?.errors.join(' ') ?? '', /ungültiges JSON/)
    assert.equal(clients?.path, clientsPath)
  })

  test('rejects path-like client names and keeps them out of runtime routing', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-config-unsafe-client-'))
    roots.push(root)
    const clientsPath = join(root, 'clients.json')
    writeFileSync(clientsPath, `${JSON.stringify({ '../outside': ['outside'] })}\n`, 'utf-8')
    process.env.CLIENTS_PATH = clientsPath
    reloadConfig()

    const clients = diagnoseConfigFiles().find(item => item.id === 'clients')
    assert.equal(clients?.valid, false)
    assert.match(clients?.errors.join(' ') ?? '', /sicherer einzelner Ordnername/)
    assert.deepEqual(loadClients(), {})
  })
})
