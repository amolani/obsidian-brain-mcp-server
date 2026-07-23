import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_DEFINITIONS,
  isToolAllowedInMode,
  parseCalibrationReviewerId,
  parseMcpToolMode,
  toolDefinitionsForMode,
} from '../server-tools.ts'
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

  test('calibration-review mode exposes and permits only the blind review tools', () => {
    const mode = parseMcpToolMode('calibration-review')
    const definitions = toolDefinitionsForMode(mode)
    assert.deepEqual(
      definitions.map(definition => definition.name),
      ['brain_calibration_review_batch', 'record_calibration_judgement'],
    )
    for (const definition of definitions) {
      assert.equal(
        'reviewer' in definition.inputSchema.properties,
        false,
        `${definition.name} must not expose caller-selectable reviewer identity`,
      )
      assert.equal(
        ('required' in definition.inputSchema
          ? (definition.inputSchema.required as readonly string[])
            .includes('reviewer')
          : false),
        false,
      )
    }
    const judgement = definitions.find(definition =>
      definition.name === 'record_calibration_judgement')
    assert.ok(judgement)
    assert.equal('recorded_at' in judgement.inputSchema.properties, false)
    assert.equal(
      (judgement.inputSchema.required as readonly string[]).includes('recorded_at'),
      false,
    )
    assert.equal(isToolAllowedInMode(mode, 'brain_calibration_review_batch'), true)
    assert.equal(isToolAllowedInMode(mode, 'record_calibration_judgement'), true)
    assert.equal(isToolAllowedInMode(mode, 'record_calibration_label'), false)
    assert.equal(isToolAllowedInMode(mode, 'vault_search'), false)
    assert.equal(isToolAllowedInMode(mode, 'get_note_context'), false)
    assert.equal(isToolAllowedInMode(mode, 'brain_calibration_evaluate'), false)
    assert.equal(
      isToolAllowedInMode(mode, 'brain_calibration_register_campaign'),
      false,
    )
    assert.equal(
      isToolAllowedInMode(mode, 'brain_calibration_close_campaign'),
      false,
    )
    assert.equal(
      isToolAllowedInMode(mode, 'brain_calibration_evaluate_sealed'),
      false,
    )
    assert.throws(() => parseMcpToolMode('unsafe-review'), /muss "default" oder/)
  })

  test('default mode hides and denies the two reviewer-only tools', () => {
    const mode = parseMcpToolMode(undefined)
    const names = toolDefinitionsForMode(mode).map(definition => definition.name)
    assert.equal(names.includes('brain_calibration_review_batch'), false)
    assert.equal(names.includes('record_calibration_judgement'), false)
    assert.equal(isToolAllowedInMode(mode, 'brain_calibration_review_batch'), false)
    assert.equal(isToolAllowedInMode(mode, 'record_calibration_judgement'), false)
    assert.equal(isToolAllowedInMode(mode, 'vault_search'), true)
    assert.equal(isToolAllowedInMode(mode, 'brain_calibration_evaluate'), true)
  })

  test('calibration reviewer identity is a required normalized opaque id', () => {
    assert.equal(parseCalibrationReviewerId(' reviewer-01 '), 'reviewer-01')
    assert.equal(parseCalibrationReviewerId('Ärztin.01'), 'Ärztin.01')
    assert.throws(
      () => parseCalibrationReviewerId(undefined),
      /calibration-review erforderlich/,
    )
    assert.throws(() => parseCalibrationReviewerId(''), /keine gültige opake/)
    assert.throws(() => parseCalibrationReviewerId('alice smith'), /keine gültige opake/)
    assert.throws(() => parseCalibrationReviewerId('alice\nsmith'), /keine gültige opake/)
    assert.throws(() => parseCalibrationReviewerId(`a${'b'.repeat(64)}`), /keine gültige opake/)
  })
})
