import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_DEFINITIONS } from '../server-tools.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import { TOOL_HANDLER_NAMES } from '../tool-handlers.ts'

describe('MCP tool registry contract', () => {
  test('definitions, handlers, and policy stay in lockstep', () => {
    const definitionNames = TOOL_DEFINITIONS.map(definition => definition.name)
    assert.equal(new Set(definitionNames).size, definitionNames.length, 'tool definitions must be unique')
    assert.deepEqual([...definitionNames].sort(), [...TOOL_HANDLER_NAMES])

    const policyNames = Object.keys(loadBrainPolicy().tools)
    const definitionNameSet = new Set<string>(definitionNames)
    assert.deepEqual(
      definitionNames.filter(name => !policyNames.includes(name)),
      [],
      'every exposed MCP tool needs an explicit policy entry',
    )
    assert.deepEqual(
      policyNames.filter(name => !definitionNameSet.has(name)).sort(),
      ['auto_capture', 'create_daily_note'],
      'only the two hook-internal writers may exist outside the MCP registry',
    )
  })
})
