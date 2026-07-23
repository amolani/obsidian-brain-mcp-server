import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSafeMaintenanceOptions, RunSafeMaintenanceResult, SafeMaintenanceStep, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'

export type ReviewItemStatus = 'accepted' | 'rejected' | 'snoozed'

export interface ReviewQueueEntry {
  itemId: string
  status: ReviewItemStatus
  reason?: string
  snoozedUntil?: string
  updatedAt: string
}

export interface ReviewQueueActionOptions {
  itemId: string
  reason?: string
  snoozedUntil?: string
  dryRun?: boolean
}

export interface ReviewQueueActionResult {
  dryRun: boolean
  entry: ReviewQueueEntry
  statePath: string
}

export interface ApplyAllSafeFixesOptions extends RunSafeMaintenanceOptions {
  steps?: SafeMaintenanceStep[]
}

const STATE_FILE = '.review-queue-actions.json'

function now(): string {
  return new Date().toISOString()
}

function statePath(vault: Vault): string {
  return join(vault.vaultPath, STATE_FILE)
}

export function readReviewQueueState(vault: Vault): Record<string, ReviewQueueEntry> {
  try {
    const path = statePath(vault)
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ReviewQueueEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function isReviewQueueItemOpen(
  state: Record<string, ReviewQueueEntry>,
  itemId: string,
  at: number = Date.now(),
): boolean {
  const entry = state[itemId]
  if (!entry) return true
  if (entry.status !== 'snoozed') return false
  const until = entry.snoozedUntil ? Date.parse(entry.snoozedUntil) : Number.NaN
  return !Number.isFinite(until) || until <= at
}

function writeState(vault: Vault, state: Record<string, ReviewQueueEntry>): void {
  const path = statePath(vault)
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error
  }
}

function toolForStatus(status: ReviewItemStatus): 'accept_review_item' | 'reject_review_item' | 'snooze_review_item' {
  if (status === 'accepted') return 'accept_review_item'
  if (status === 'rejected') return 'reject_review_item'
  return 'snooze_review_item'
}

function setReviewItemStatus(
  vault: Vault,
  status: ReviewItemStatus,
  options: ReviewQueueActionOptions,
): ReviewQueueActionResult {
  if (!options.itemId || typeof options.itemId !== 'string') {
    throw new Error('review item_id ist erforderlich')
  }

  const dryRun = options.dryRun ?? true
  if (status === 'snoozed') {
    const timestamp = options.snoozedUntil ? Date.parse(options.snoozedUntil) : Number.NaN
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      throw new Error('snoozedUntil muss ein gültiger Zeitpunkt in der Zukunft sein')
    }
  }
  const entry: ReviewQueueEntry = {
    itemId: options.itemId,
    status,
    reason: options.reason,
    snoozedUntil: status === 'snoozed' ? options.snoozedUntil : undefined,
    updatedAt: now(),
  }

  if (!dryRun) {
    const tool = toolForStatus(status)
    assertCanWriteTool(tool, [STATE_FILE])
    const state = readReviewQueueState(vault)
    state[options.itemId] = entry
    writeState(vault, state)
    appendActionLog(vault.vaultPath, {
      tool,
      mode: 'apply',
      targets: [STATE_FILE],
      summary: `Review item ${status}: ${options.itemId}`,
      meta: { entry },
    })
  }

  return {
    dryRun,
    entry,
    statePath: STATE_FILE,
  }
}

export function acceptReviewItem(vault: Vault, options: ReviewQueueActionOptions): ReviewQueueActionResult {
  return setReviewItemStatus(vault, 'accepted', options)
}

export function rejectReviewItem(vault: Vault, options: ReviewQueueActionOptions): ReviewQueueActionResult {
  return setReviewItemStatus(vault, 'rejected', options)
}

export function snoozeReviewItem(vault: Vault, options: ReviewQueueActionOptions): ReviewQueueActionResult {
  return setReviewItemStatus(vault, 'snoozed', options)
}

export function applyAllSafeFixes(vault: Vault, options: ApplyAllSafeFixesOptions = {}): RunSafeMaintenanceResult {
  const dryRun = options.dryRun ?? true
  if (!dryRun) assertCanWriteTool('apply_all_safe_fixes')
  return vault.runSafeMaintenance({
    dryRun,
    steps: options.steps,
    minLinkConfidence: options.minLinkConfidence,
    minLifecycleConfidence: options.minLifecycleConfidence,
    mocMinNotes: options.mocMinNotes,
  })
}
