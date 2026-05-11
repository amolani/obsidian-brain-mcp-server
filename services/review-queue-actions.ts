import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunSafeMaintenanceOptions, RunSafeMaintenanceResult, SafeMaintenanceStep, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'

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

function readState(vault: Vault): Record<string, ReviewQueueEntry> {
  try {
    const path = statePath(vault)
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ReviewQueueEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(vault: Vault, state: Record<string, ReviewQueueEntry>): void {
  writeFileSync(statePath(vault), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
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
  const entry: ReviewQueueEntry = {
    itemId: options.itemId,
    status,
    reason: options.reason,
    snoozedUntil: status === 'snoozed' ? options.snoozedUntil : undefined,
    updatedAt: now(),
  }

  if (!dryRun) {
    const state = readState(vault)
    state[options.itemId] = entry
    writeState(vault, state)
    appendActionLog(vault.vaultPath, {
      tool: `${status}_review_item`,
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
  return vault.runSafeMaintenance({
    dryRun: options.dryRun ?? true,
    steps: options.steps,
    minLinkConfidence: options.minLinkConfidence,
    minLifecycleConfidence: options.minLifecycleConfidence,
    mocMinNotes: options.mocMinNotes,
  })
}
