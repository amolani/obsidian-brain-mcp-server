import { existsSync, readFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteJsonSync } from './atomic-file.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type BrainFeedbackOutcome = 'accepted' | 'rejected' | 'snoozed'

export interface BrainFeedbackEntry {
  itemId: string
  outcome: BrainFeedbackOutcome
  category?: string
  reason?: string
  updatedAt: string
}

export interface RecordBrainFeedbackOptions {
  itemId: string
  outcome: BrainFeedbackOutcome
  category?: string
  reason?: string
  dryRun?: boolean
}

export interface BrainFeedbackResult {
  dryRun: boolean
  path: string
  entry: BrainFeedbackEntry
  summary: BrainFeedbackSummary
}

export interface BrainFeedbackSummary {
  total: number
  accepted: number
  rejected: number
  snoozed: number
  byCategory: Record<string, { accepted: number; rejected: number; snoozed: number }>
}

export const BRAIN_FEEDBACK_PATH = '.brain-feedback.json'
const AUTO_BUILD_PREFIX = 'auto_build:'

function now(): string {
  return new Date().toISOString()
}

export function readBrainFeedbackEntries(vault: Vault): BrainFeedbackEntry[] {
  const path = vaultJoin(vault.vaultPath, BRAIN_FEEDBACK_PATH)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BrainFeedbackEntry[]
    if (!Array.isArray(parsed)) throw new Error('Array erforderlich')
    for (const [index, entry] of parsed.entries()) {
      if (!entry || typeof entry !== 'object') throw new Error(`Eintrag ${index} muss ein Objekt sein`)
      if (typeof entry.itemId !== 'string' || !entry.itemId.trim()) throw new Error(`Eintrag ${index}: itemId fehlt`)
      if (!['accepted', 'rejected', 'snoozed'].includes(entry.outcome)) throw new Error(`Eintrag ${index}: outcome ungültig`)
      if (typeof entry.updatedAt !== 'string' || !entry.updatedAt) throw new Error(`Eintrag ${index}: updatedAt fehlt`)
      if (entry.category !== undefined && typeof entry.category !== 'string') throw new Error(`Eintrag ${index}: category ungültig`)
      if (entry.reason !== undefined && typeof entry.reason !== 'string') throw new Error(`Eintrag ${index}: reason ungültig`)
    }
    return parsed
  } catch (error) {
    throw new Error(`Brain-Feedback ist beschädigt (${BRAIN_FEEDBACK_PATH}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function summarize(entries: BrainFeedbackEntry[]): BrainFeedbackSummary {
  const byCategory: BrainFeedbackSummary['byCategory'] = {}
  for (const entry of entries) {
    const category = entry.category ?? 'unknown'
    byCategory[category] ??= { accepted: 0, rejected: 0, snoozed: 0 }
    byCategory[category][entry.outcome]++
  }
  return {
    total: entries.length,
    accepted: entries.filter(entry => entry.outcome === 'accepted').length,
    rejected: entries.filter(entry => entry.outcome === 'rejected').length,
    snoozed: entries.filter(entry => entry.outcome === 'snoozed').length,
    byCategory,
  }
}

export function autoBuildFeedbackCategory(action: string): string {
  return `${AUTO_BUILD_PREFIX}${action}`
}

export interface RecordAutoBuildFeedbackOptions {
  sourcePath: string
  categories: string[]
  outcome: BrainFeedbackOutcome
  reason?: string
  dryRun?: boolean
}

export interface BrainAutoBuildLearningCategory {
  category: string
  accepted: number
  rejected: number
  snoozed: number
  archived: number
  total: number
  usefulnessScore: number
  strict: boolean
  blocked: boolean
}

export interface BrainAutoBuildLearning {
  usefulnessScore: number
  categories: Record<string, BrainAutoBuildLearningCategory>
}

export function brainAutoBuildLearning(vault: Vault): BrainAutoBuildLearning {
  const entries = readBrainFeedbackEntries(vault)
  const categories: BrainAutoBuildLearning['categories'] = {}
  for (const entry of entries) {
    const category = entry.category ?? 'unknown'
    if (!category.startsWith(AUTO_BUILD_PREFIX)) continue
    categories[category] ??= {
      category,
      accepted: 0,
      rejected: 0,
      snoozed: 0,
      archived: 0,
      total: 0,
      usefulnessScore: 1,
      strict: false,
      blocked: false,
    }
    categories[category][entry.outcome]++
    categories[category].total++
    if (entry.reason?.startsWith('archived:')) categories[category].archived++
  }

  let accepted = 0
  let rejected = 0
  for (const item of Object.values(categories)) {
    accepted += item.accepted
    rejected += item.rejected
    item.usefulnessScore = item.accepted + item.rejected === 0
      ? 1
      : item.accepted / (item.accepted + item.rejected)
    item.strict = item.rejected >= 2 && item.rejected > item.accepted
    item.blocked = item.rejected >= 3 && item.accepted === 0
  }

  return {
    usefulnessScore: accepted + rejected === 0 ? 1 : accepted / (accepted + rejected),
    categories,
  }
}

export function recordAutoBuildFeedback(vault: Vault, options: RecordAutoBuildFeedbackOptions): BrainFeedbackResult[] {
  const categories = [...new Set(options.categories)].filter(Boolean).sort()
  return categories.map(category => recordBrainFeedback(vault, {
    itemId: `${AUTO_BUILD_PREFIX}${options.sourcePath}:${category}`.replace(/[^a-zA-Z0-9._:/-]+/g, '_').slice(0, 220),
    outcome: options.outcome,
    category,
    reason: options.reason,
    dryRun: options.dryRun,
  }))
}

export function recordBrainFeedback(vault: Vault, options: RecordBrainFeedbackOptions): BrainFeedbackResult {
  const dryRun = options.dryRun ?? true
  if (!options.itemId?.trim()) throw new Error('item_id ist erforderlich')
  if (!['accepted', 'rejected', 'snoozed'].includes(options.outcome)) throw new Error(`Ungültiges outcome: ${options.outcome}`)
  const entries = readBrainFeedbackEntries(vault)
  const entry: BrainFeedbackEntry = {
    itemId: options.itemId,
    outcome: options.outcome,
    category: options.category,
    reason: options.reason,
    updatedAt: now(),
  }
  const next = [...entries.filter(existing => existing.itemId !== entry.itemId), entry]

  if (!dryRun) {
    assertCanWriteTool('record_brain_feedback', [BRAIN_FEEDBACK_PATH])
    atomicWriteJsonSync(vaultJoin(vault.vaultPath, BRAIN_FEEDBACK_PATH), next)
    appendActionLog(vault.vaultPath, {
      tool: 'record_brain_feedback',
      mode: 'apply',
      targets: [BRAIN_FEEDBACK_PATH],
      summary: `Brain feedback gespeichert: ${entry.itemId} -> ${entry.outcome}`,
      meta: { entry },
    })
  }

  return { dryRun, path: BRAIN_FEEDBACK_PATH, entry, summary: summarize(next) }
}

export function brainFeedbackSummary(vault: Vault): BrainFeedbackSummary {
  return summarize(readBrainFeedbackEntries(vault))
}
