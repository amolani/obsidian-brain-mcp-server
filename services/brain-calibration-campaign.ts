import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Vault } from '../vault.ts'
import {
  BRAIN_CALIBRATION_SCHEMA_VERSION,
  calibrationSnapshotFingerprint,
  parseBrainCalibrationTargetSnapshot,
  readBrainCalibrationDataset,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationEntry,
  type BrainCalibrationTargetSnapshot,
} from './brain-calibration.ts'
import {
  BRAIN_CALIBRATION_EVALUATION_VERSION,
  BRAIN_CALIBRATION_HOLDOUT_POLICY,
  BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY,
  collectBrainCalibrationEvaluationFrame,
  computeBrainCalibrationDataFingerprint,
  deriveBrainCalibrationSplitPlan,
  evaluateBrainCalibrationSnapshot,
  normalizeBrainCalibrationEvaluationOptions,
  parseBrainCalibrationEvaluationSplitPlan,
  validateBrainCalibrationSplitPlan,
  type BrainCalibrationEvaluationFrameSnapshot,
  type BrainCalibrationEvaluationFrameTarget,
  type BrainCalibrationEvaluationGroupBy,
  type BrainCalibrationEvaluationResult,
  type BrainCalibrationEvaluationSplitPlan,
} from './brain-calibration-evaluation.ts'
import {
  CALIBRATION_CAPTURE_SCHEMA,
  CALIBRATION_CAPTURE_PRODUCER,
  calibrationObservationId,
  calibrationReviewToken,
  parseCalibrationCaptureBundle,
  type CalibrationReviewPayload,
} from './calibration-capture.ts'
import { EVIDENCE_SCORING_MODEL } from './evidence-scoring.ts'
import { KNOWLEDGE_SALIENCE_MODEL } from './knowledge-salience.ts'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath, vaultJoin } from './vault-paths.ts'

export const BRAIN_CALIBRATION_CAMPAIGN_SCHEMA =
  'brain-calibration-campaign-seal-v1' as const
export const BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY = '.brain-calibration-campaign'
export const BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH =
  `${BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY}/registration.json`
export const BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH =
  `${BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY}/closure.json`
export const BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH =
  `${BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY}/result.json`
export const BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH =
  '.brain-calibration-campaign.lock'
/**
 * A dead owner is not enough on its own: a grace period avoids reclaiming a
 * lock while its owner is still publishing the freshly-created metadata.
 */
export const BRAIN_CALIBRATION_CAMPAIGN_LOCK_STALE_AFTER_MS = 10 * 60 * 1000
export const BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV =
  'BRAIN_CALIBRATION_ANCHOR_DIR'
export const BRAIN_CALIBRATION_VAULT_ID_ENV = 'BRAIN_CALIBRATION_VAULT_ID'

const REVIEW_PROTOCOL_VERSION = 'brain-calibration-blind-review-v1'
const SAMPLE_POLICY_VERSION = 'seeded_uniform_candidate_sample_v2'
const BRAIN_CALIBRATION_CAMPAIGN_LOCK_RECLAIM_SUFFIX = '.reclaim'
const ASSURANCE_PROFILE = {
  anchor:
    'external-retention-must-enforce-append-only-or-worm-v1',
  reviewerIdentity:
    'process-bound-pseudonym-without-cryptographic-signature-v1',
  runtime:
    'complete-source-tree-and-runtime-hashes-on-trusted-host-v1',
} as const
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ROOT_SOURCE_FILES = [
  'brain-policy.json',
  'cli.ts',
  'config.ts',
  'package.json',
  'package-lock.json',
  'server.ts',
  'server-tools.ts',
  'suggestions.ts',
  'tag-aliases.json',
  'tech-terms.json',
  'technik-categories.json',
  'technik-categories.ts',
  'tool-handlers.ts',
  'tsconfig.json',
  'vault.ts',
] as const
const SOURCE_DIRECTORIES = ['hooks', 'services', 'tool-handlers'] as const
const HASH = /^[a-f0-9]{64}$/
const OBSERVATION_ID = /^ko-[a-f0-9]{24}$/
const REVIEW_TOKEN = /^brt-[a-f0-9]{32}$/
const FACT_ID = /^ks-[a-f0-9]{20}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function collectTypeScriptSourceFiles(
  relativeDirectory: string,
): string[] {
  const directory = resolve(ROOT, relativeDirectory)
  const paths: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) {
      paths.push(...collectTypeScriptSourceFiles(relativePath))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      paths.push(relativePath)
    }
  }
  return paths
}

function sourceFiles(): string[] {
  return [
    ...ROOT_SOURCE_FILES,
    ...SOURCE_DIRECTORIES.flatMap(collectTypeScriptSourceFiles),
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
}

export interface BrainCalibrationCampaignLock {
  readonly descriptor: number
  readonly path: string
  readonly device: number
  readonly inode: number
}

export interface BrainCalibrationCampaignSourceBinding {
  path: string
  sha256: string
}

export interface BrainCalibrationCampaignRuntimeBinding {
  node: string
  v8: string
  platform: NodeJS.Platform
  arch: string
  execPathSha256: string
  execArgvSha256: string
  nodeOptionsSha256: string | null
}

export interface BrainCalibrationCampaignReviewArchive {
  observationId: string
  factId: string
  sourcePath: string
  reviewToken: string
  reviewReference: string
  captureSchema: typeof CALIBRATION_CAPTURE_SCHEMA
  captureProducer: typeof CALIBRATION_CAPTURE_PRODUCER
  captureIntegrity: string
  sampleSeed: string
  snapshotFingerprint: string
  snapshotPayload: string
  review: CalibrationReviewPayload
}

export interface BrainCalibrationCampaignCaptureArchive {
  sourcePath: string
  schema: typeof CALIBRATION_CAPTURE_SCHEMA
  producer: typeof CALIBRATION_CAPTURE_PRODUCER
  captureIntegrity: string
  sessionId: string
  modelVersion: string
  sampleSeed: string
  candidateUniverseFactIds: string[]
  selectedFactIds: string[]
}

export interface BrainCalibrationCampaignPlan {
  labels: readonly ['useful', 'supported']
  groupBy: BrainCalibrationEvaluationGroupBy
  bootstrapSamples: number
  cutoffAt: string | null
  splitPlan: BrainCalibrationEvaluationSplitPlan
  evaluationVersion: typeof BRAIN_CALIBRATION_EVALUATION_VERSION
  holdoutPolicyVersion: typeof BRAIN_CALIBRATION_HOLDOUT_POLICY.version
  captureSchema: typeof CALIBRATION_CAPTURE_SCHEMA
  datasetSchemaVersion: typeof BRAIN_CALIBRATION_SCHEMA_VERSION
  reviewProtocolVersion: typeof REVIEW_PROTOCOL_VERSION
  samplePolicyVersion: typeof SAMPLE_POLICY_VERSION
  salienceModelVersion: string
  evidenceModelVersion: string
  holdoutGates: typeof BRAIN_CALIBRATION_HOLDOUT_POLICY
  shadowModels: typeof BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY
  assuranceProfile: typeof ASSURANCE_PROFILE
  runtime: BrainCalibrationCampaignRuntimeBinding
  sourceBindings: BrainCalibrationCampaignSourceBinding[]
}

export interface BrainCalibrationCampaignRegistration {
  schema: typeof BRAIN_CALIBRATION_CAMPAIGN_SCHEMA
  phase: 'registered'
  campaignId: string
  vaultIdHash: string
  registeredAt: string
  reviewers: string[]
  plan: BrainCalibrationCampaignPlan
  frame: BrainCalibrationEvaluationFrameSnapshot
  captureArchives: BrainCalibrationCampaignCaptureArchive[]
  reviewArchive: BrainCalibrationCampaignReviewArchive[]
  frameFingerprint: string
  baselineNonPrimaryEntryCount: number
  baselineNonPrimaryEntriesRoot: string
  registrationRoot: string
}

export interface BrainCalibrationCampaignClosure {
  schema: typeof BRAIN_CALIBRATION_CAMPAIGN_SCHEMA
  phase: 'closed'
  campaignId: string
  vaultIdHash: string
  closedAt: string
  registrationRoot: string
  entries: BrainCalibrationEntry[]
  dataFingerprint: string
  closureRoot: string
}

export interface BrainCalibrationCampaignResult {
  schema: typeof BRAIN_CALIBRATION_CAMPAIGN_SCHEMA
  phase: 'evaluated'
  campaignId: string
  vaultIdHash: string
  evaluatedAt: string
  registrationRoot: string
  closureRoot: string
  evaluation: BrainCalibrationEvaluationResult
  resultRoot: string
}

export type BrainCalibrationCampaignPhase =
  | 'unregistered'
  | 'registered'
  | 'closed'
  | 'evaluated'

export interface BrainCalibrationCampaignState {
  phase: BrainCalibrationCampaignPhase
  registration: BrainCalibrationCampaignRegistration | null
  closure: BrainCalibrationCampaignClosure | null
  result: BrainCalibrationCampaignResult | null
}

export interface RegisterBrainCalibrationCampaignOptions {
  campaignId: string
  reviewers: string[]
  groupBy: BrainCalibrationEvaluationGroupBy
  bootstrapSamples?: number
  /**
   * Required together with expectedRegisteredAt when dryRun=false. These two
   * values bind apply to the exact artifact previously returned by dry-run.
   */
  expectedRegistrationRoot?: string
  expectedRegisteredAt?: string
  dryRun?: boolean
}

export interface BrainCalibrationCampaignMutationResult<T> {
  dryRun: boolean
  operation: 'created' | 'unchanged'
  externalAnchor: 'pending' | 'written' | 'verified'
  artifact: T
}

type JsonRecord = Record<string, unknown>

function appendCampaignAction(
  vault: Vault,
  tool: string,
  path: string,
  operation: BrainCalibrationCampaignMutationResult<unknown>['operation'],
  externalAnchor: BrainCalibrationCampaignMutationResult<unknown>['externalAnchor'],
  campaignId: string,
  phase: BrainCalibrationCampaignPhase,
  root: string,
): void {
  appendActionLog(vault.vaultPath, {
    tool,
    mode: 'apply',
    targets: [path],
    summary: `Kalibrierungskampagne ${phase}: ${operation}`,
    meta: {
      schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
      operation,
      externalAnchor,
      campaignId,
      phase,
      root,
    },
  })
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Kanonisches JSON erlaubt nur endliche Zahlen')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Kanonisches JSON erlaubt keine Zyklen')
    seen.add(value)
    const encoded = `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    seen.delete(value)
    return encoded
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error('Kanonisches JSON erlaubt keine Zyklen')
    seen.add(value)
    const encoded = `{${Object.keys(value).sort().map(key => {
      const child = value[key]
      if (child === undefined) {
        throw new Error(`Kanonisches JSON erlaubt kein undefined (${key})`)
      }
      return `${JSON.stringify(key)}:${canonicalValue(child, seen)}`
    }).join(',')}}`
    seen.delete(value)
    return encoded
  }
  throw new Error(`Nicht unterstützter JSON-Wert: ${typeof value}`)
}

/** Recursive, key-sorted JSON used for every campaign digest and file. */
export function canonicalBrainCalibrationCampaignJson(value: unknown): string {
  return canonicalValue(value, new Set())
}

/** Full, domain-separated SHA-256; campaign integrity never uses truncated hashes. */
export function brainCalibrationCampaignHash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update('obsidian-brain-calibration-campaign\0')
    .update(domain)
    .update('\0')
    .update(canonicalBrainCalibrationCampaignJson(value))
    .digest('hex')
}

function now(): string {
  return new Date().toISOString()
}

function localPath(vault: Vault, path: string): string {
  return vaultJoin(vault.vaultPath, path)
}

interface BrainCalibrationCampaignLockMetadata {
  acquiredAtMs: number
  pid: number
  hostname: string
}

type ProcessLiveness = 'alive' | 'dead' | 'unknown'

function parseBrainCalibrationCampaignLockMetadata(
  value: string,
): BrainCalibrationCampaignLockMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const acquiredAt = parsed.acquiredAt
  const pid = parsed.pid
  const ownerHostname = parsed.hostname
  if (
    typeof acquiredAt !== 'string'
    || !ISO_INSTANT.test(acquiredAt)
    || !Number.isFinite(Date.parse(acquiredAt))
    || new Date(acquiredAt).toISOString() !== acquiredAt
    || !Number.isSafeInteger(pid)
    || (pid as number) <= 0
    || (pid as number) > 0xffff_ffff
    || typeof ownerHostname !== 'string'
    || ownerHostname.trim() === ''
  ) {
    return null
  }

  return {
    acquiredAtMs: Date.parse(acquiredAt),
    pid: pid as number,
    // Host identity is mandatory: a PID from a shared/remote vault must never
    // be interpreted in the local machine's process namespace.
    hostname: ownerHostname.trim().toLowerCase(),
  }
}

function processLiveness(pid: number): ProcessLiveness {
  if (pid === process.pid) return 'alive'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    // EPERM means that the process exists but cannot be signalled. Any other
    // platform-specific result is also kept fail-closed.
    return 'unknown'
  }
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Reclaims one demonstrably stale local lock. Every ambiguous condition is
 * fail-closed; callers then report the ordinary "campaign locked" error.
 */
function reclaimStaleBrainCalibrationCampaignLock(path: string): boolean {
  let descriptor: number | null = null
  let inspected: { dev: number; ino: number } | null = null
  let ownsReclaimLink = false
  const reclaimPath = `${path}${BRAIN_CALIBRATION_CAMPAIGN_LOCK_RECLAIM_SUFFIX}`
  try {
    descriptor = openSync(path, 'r')
    const opened = fstatSync(descriptor)
    inspected = opened
    const linked = lstatSync(path)
    if (
      !opened.isFile()
      || !linked.isFile()
      || !sameFile(opened, linked)
      || opened.size > 4096
    ) {
      return false
    }

    const metadata = parseBrainCalibrationCampaignLockMetadata(
      readFileSync(descriptor, 'utf8').trim(),
    )
    if (!metadata) return false

    if (
      metadata.hostname !== hostname().trim().toLowerCase()
    ) {
      return false
    }

    // Both independently observable timestamps must be old. In particular, a
    // forged old acquiredAt cannot make a freshly replaced file reclaimable.
    const newestTimestamp = Math.max(metadata.acquiredAtMs, opened.mtimeMs)
    if (
      !Number.isFinite(newestTimestamp)
      || Date.now() - newestTimestamp
        < BRAIN_CALIBRATION_CAMPAIGN_LOCK_STALE_AFTER_MS
      || processLiveness(metadata.pid) !== 'dead'
    ) {
      return false
    }

    closeSync(descriptor)
    descriptor = null

    // A canonical hard-link claim serializes concurrent reclaimers before any
    // unlink. It points at the inspected inode, so a replacement at the main
    // path can be detected before unlinking.
    linkSync(path, reclaimPath)
    ownsReclaimLink = true
    const claim = lstatSync(reclaimPath)
    const current = lstatSync(path)
    if (!sameFile(opened, claim) || !sameFile(opened, current)) return false
    unlinkSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // The owner released the lock between our open attempt and inspection;
      // acquisition can safely retry without deleting anything.
      return true
    }
    return false
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch {}
    }
    if (ownsReclaimLink && inspected !== null) {
      try {
        const claim = lstatSync(reclaimPath)
        if (sameFile(inspected, claim)) unlinkSync(reclaimPath)
      } catch {}
    }
  }
}

export function acquireBrainCalibrationCampaignLock(
  vault: Vault,
): BrainCalibrationCampaignLock {
  const path = localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null
    try {
      descriptor = openSync(path, 'wx', 0o600)
      writeFileSync(descriptor, `${canonicalBrainCalibrationCampaignJson({
        acquiredAt: now(),
        hostname: hostname(),
        pid: process.pid,
      })}\n`, 'utf8')
      fsyncSync(descriptor)
      const info = fstatSync(descriptor)
      return {
        descriptor,
        path,
        device: info.dev,
        inode: info.ino,
      }
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch {}
        // A partial lock remains fail-closed. Removing by path could delete a
        // replacement lock acquired by another process.
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (
          attempt === 0
          && reclaimStaleBrainCalibrationCampaignLock(path)
        ) {
          continue
        }
        throw new Error(
          `Kalibrierungskampagne ist gesperrt (${BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH})`,
        )
      }
      throw error
    }
  }
  throw new Error(
    `Kalibrierungskampagne ist gesperrt (${BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH})`,
  )
}

export function releaseBrainCalibrationCampaignLock(
  lock: BrainCalibrationCampaignLock,
): void {
  let ownsPath = false
  try {
    const current = lstatSync(lock.path)
    ownsPath = current.dev === lock.device && current.ino === lock.inode
    if (!ownsPath) {
      throw new Error('Campaign-Lock wurde während der Operation ersetzt')
    }
    closeSync(lock.descriptor)
  } catch (error) {
    try { closeSync(lock.descriptor) } catch {}
    throw error
  }
  if (ownsPath) {
    unlinkSync(lock.path)
  }
}

export function withBrainCalibrationCampaignLock<T>(
  vault: Vault,
  action: () => T,
): T {
  const lock = acquireBrainCalibrationCampaignLock(vault)
  try {
    return action()
  } finally {
    releaseBrainCalibrationCampaignLock(lock)
  }
}

interface AnchorContext {
  directory: string
  vaultIdHash: string
}

type AnchorPhase = 'registration' | 'closure' | 'result'

interface ExternalAnchorReceipt {
  schema: 'brain-calibration-external-anchor-v1'
  vaultIdHash: string
  campaignId: string
  phase: AnchorPhase
  root: string
  previousRoot: string | null
  anchoredAt: string
  receiptRoot: string
}

function identifier(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string') throw new Error(`${field} muss ein String sein`)
  const text = value.normalize('NFC').trim()
  if (
    !text
    || text.length > max
    || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(text)
  ) {
    throw new Error(`${field} muss eine opake, einzeilige ID sein`)
  }
  return text
}

function isoInstant(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !ISO_INSTANT.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} muss ein kanonischer UTC-Zeitstempel sein`)
  }
  return value
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`${field} muss ein vollständiger SHA-256-Hash sein`)
  }
  return value
}

function exactKeys(value: JsonRecord, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalBrainCalibrationCampaignJson(actual)
    !== canonicalBrainCalibrationCampaignJson(wanted)) {
    throw new Error(`${field} enthält fehlende oder unerlaubte Felder`)
  }
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${field} muss ein Objekt sein`)
  return value
}

function assertRegularFile(path: string, field: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${field} muss eine reguläre Datei ohne Symlink sein`)
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolves the external trust domain.
 *
 * The create-only receipts below are tamper-evident. Actual irreversibility
 * additionally depends on WORM/retention and independent access control for
 * this directory; a normal user-writable directory cannot provide that
 * guarantee by itself.
 */
function anchorContext(vault: Vault, required = true): AnchorContext | null {
  const configuredDirectory = process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV]
  const configuredVaultId = process.env[BRAIN_CALIBRATION_VAULT_ID_ENV]
  if (!configuredDirectory && !configuredVaultId && !required) return null
  if (!configuredDirectory || !configuredVaultId) {
    throw new Error(
      `${BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV} und `
      + `${BRAIN_CALIBRATION_VAULT_ID_ENV} müssen gemeinsam gesetzt sein`,
    )
  }
  if (!isAbsolute(configuredDirectory)) {
    throw new Error(`${BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV} muss absolut sein`)
  }
  const lexicalDirectory = resolve(configuredDirectory)
  const info = lstatSync(lexicalDirectory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Externes Anchor-Verzeichnis muss ein echtes Verzeichnis sein')
  }
  const directory = realpathSync(lexicalDirectory)
  if (directory !== lexicalDirectory) {
    throw new Error('Externes Anchor-Verzeichnis darf keine Symlink-Komponente enthalten')
  }
  const vaultRoot = realpathSync(resolve(vault.vaultPath))
  if (isWithin(vaultRoot, directory)) {
    throw new Error('Externes Anchor-Verzeichnis muss außerhalb des Vaults liegen')
  }
  const vaultId = identifier(configuredVaultId, BRAIN_CALIBRATION_VAULT_ID_ENV)
  return {
    directory,
    vaultIdHash: brainCalibrationCampaignHash('vault-id-v1', vaultId),
  }
}

function receiptFileName(
  context: AnchorContext,
  campaignId: string,
  phase: AnchorPhase,
): string {
  const campaignHash = brainCalibrationCampaignHash('campaign-id-v1', campaignId)
  return `${context.vaultIdHash}.${campaignHash}.${phase}.json`
}

function receiptPayload(receipt: ExternalAnchorReceipt): Omit<
  ExternalAnchorReceipt,
  'receiptRoot'
> {
  const { receiptRoot: _root, ...payload } = receipt
  return payload
}

function parseReceipt(value: unknown): ExternalAnchorReceipt {
  const item = record(value, 'anchor')
  exactKeys(item, [
    'schema', 'vaultIdHash', 'campaignId', 'phase', 'root',
    'previousRoot', 'anchoredAt', 'receiptRoot',
  ], 'anchor')
  if (item.schema !== 'brain-calibration-external-anchor-v1') {
    throw new Error('Anchor-Schema ist ungültig')
  }
  if (!['registration', 'closure', 'result'].includes(String(item.phase))) {
    throw new Error('Anchor-Phase ist ungültig')
  }
  const receipt: ExternalAnchorReceipt = {
    schema: 'brain-calibration-external-anchor-v1',
    vaultIdHash: sha256(item.vaultIdHash, 'anchor.vaultIdHash'),
    campaignId: identifier(item.campaignId, 'anchor.campaignId'),
    phase: item.phase as AnchorPhase,
    root: sha256(item.root, 'anchor.root'),
    previousRoot: item.previousRoot === null
      ? null
      : sha256(item.previousRoot, 'anchor.previousRoot'),
    anchoredAt: isoInstant(item.anchoredAt, 'anchor.anchoredAt'),
    receiptRoot: sha256(item.receiptRoot, 'anchor.receiptRoot'),
  }
  const expected = brainCalibrationCampaignHash(
    'external-anchor-receipt-v1',
    receiptPayload(receipt),
  )
  if (receipt.receiptRoot !== expected) throw new Error('Anchor-Receipt-Root ist ungültig')
  return receipt
}

function readJson(path: string, field: string, maximumBytes = 256 * 1024 * 1024): unknown {
  assertRegularFile(path, field)
  if (statSync(path).size > maximumBytes) throw new Error(`${field} ist zu groß`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`${field} ist kein gültiges JSON: ${
      error instanceof Error ? error.message : String(error)
    }`)
  }
}

function listReceipts(context: AnchorContext): ExternalAnchorReceipt[] {
  const prefix = `${context.vaultIdHash}.`
  const receipts: ExternalAnchorReceipt[] = []
  for (const name of readdirSync(context.directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
    const path = resolve(context.directory, name)
    if (!isWithin(context.directory, path)) throw new Error('Unsicherer Anchor-Dateiname')
    const receipt = parseReceipt(readJson(path, `Anchor ${name}`, 64 * 1024))
    if (receipt.vaultIdHash !== context.vaultIdHash) {
      throw new Error('Anchor-Vault-ID stimmt nicht mit seinem Dateinamen überein')
    }
    if (name !== receiptFileName(context, receipt.campaignId, receipt.phase)) {
      throw new Error('Anchor-Dateiname ist nicht aus Receipt-Inhalt reproduzierbar')
    }
    receipts.push(receipt)
  }
  return receipts
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function writeCreateOnly(path: string, value: unknown, mode = 0o600): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'wx', mode)
    writeFileSync(descriptor, `${canonicalBrainCalibrationCampaignJson(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    fsyncDirectory(dirname(path))
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch {}
      // A partial artifact deliberately remains fail-closed. It is never
      // silently removed or overwritten by the campaign API.
    }
  }
}

function ensureCampaignDirectory(vault: Vault): string {
  const path = localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY)
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 })
      fsyncDirectory(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${BRAIN_CALIBRATION_CAMPAIGN_DIRECTORY} muss ein echtes Verzeichnis sein`)
  }
  return path
}

function externalReceipt(
  context: AnchorContext,
  campaignId: string,
  phase: AnchorPhase,
): ExternalAnchorReceipt | null {
  const expectedName = receiptFileName(context, campaignId, phase)
  const path = resolve(context.directory, expectedName)
  if (!existsSync(path)) return null
  return parseReceipt(readJson(path, `Anchor ${expectedName}`, 64 * 1024))
}

function verifyReceipt(
  context: AnchorContext,
  campaignId: string,
  phase: AnchorPhase,
  root: string,
  previousRoot: string | null,
): ExternalAnchorReceipt {
  const receipt = externalReceipt(context, campaignId, phase)
  if (!receipt) throw new Error(`Externer ${phase}-Anchor fehlt`)
  if (
    receipt.vaultIdHash !== context.vaultIdHash
    || receipt.campaignId !== campaignId
    || receipt.phase !== phase
    || receipt.root !== root
    || receipt.previousRoot !== previousRoot
  ) {
    throw new Error(`Externer ${phase}-Anchor stimmt nicht mit dem lokalen Siegel überein`)
  }
  return receipt
}

function ensureReceipt(
  context: AnchorContext,
  campaignId: string,
  phase: AnchorPhase,
  root: string,
  previousRoot: string | null,
  apply: boolean,
  anchoredAt?: string,
): 'pending' | 'written' | 'verified' {
  const existing = externalReceipt(context, campaignId, phase)
  if (existing) {
    verifyReceipt(context, campaignId, phase, root, previousRoot)
    if (anchoredAt !== undefined && existing.anchoredAt !== anchoredAt) {
      throw new Error(
        `Externer ${phase}-Anchor stimmt nicht mit dem gebundenen Artefaktzeitpunkt überein`,
      )
    }
    return 'verified'
  }
  if (!apply) return 'pending'
  const receiptTime = anchoredAt === undefined
    ? now()
    : isoInstant(anchoredAt, `${phase}.anchoredAt`)
  const base: Omit<ExternalAnchorReceipt, 'receiptRoot'> = {
    schema: 'brain-calibration-external-anchor-v1',
    vaultIdHash: context.vaultIdHash,
    campaignId,
    phase,
    root,
    previousRoot,
    anchoredAt: receiptTime,
  }
  const receipt: ExternalAnchorReceipt = {
    ...base,
    receiptRoot: brainCalibrationCampaignHash('external-anchor-receipt-v1', base),
  }
  const path = resolve(context.directory, receiptFileName(context, campaignId, phase))
  writeCreateOnly(path, receipt, 0o444)
  verifyReceipt(context, campaignId, phase, root, previousRoot)
  return 'written'
}

function assertReceiptHistory(
  context: AnchorContext,
  registration: BrainCalibrationCampaignRegistration | null,
  closure: BrainCalibrationCampaignClosure | null,
  result: BrainCalibrationCampaignResult | null,
  options: { allowClosureRecovery?: boolean } = {},
): void {
  const receipts = listReceipts(context)
  if (!registration) {
    if (receipts.length > 0) {
      throw new Error(
        'Rollback erkannt: externe Campaign-Events existieren, '
        + 'aber die lokale Registrierung fehlt',
      )
    }
    return
  }
  for (const receipt of receipts) {
    if (receipt.campaignId !== registration.campaignId) {
      throw new Error('Externe Events einer anderen Kampagne verhindern einen lokalen Neustart')
    }
    if (
      receipt.phase === 'closure'
      && !closure
      && options.allowClosureRecovery !== true
    ) {
      throw new Error('Rollback erkannt: externer Closure-Anchor ohne lokale Closure')
    }
    if (receipt.phase === 'result' && !result) {
      throw new Error('Rollback erkannt: externer Result-Anchor ohne lokales Resultat')
    }
  }
}

function registrationPayload(
  registration: BrainCalibrationCampaignRegistration,
): Omit<BrainCalibrationCampaignRegistration, 'registrationRoot'> {
  const { registrationRoot: _root, ...payload } = registration
  return payload
}

function closurePayload(
  closure: BrainCalibrationCampaignClosure,
): Omit<BrainCalibrationCampaignClosure, 'closureRoot'> {
  const { closureRoot: _root, ...payload } = closure
  return payload
}

function resultPayload(
  result: BrainCalibrationCampaignResult,
): Omit<BrainCalibrationCampaignResult, 'resultRoot'> {
  const { resultRoot: _root, ...payload } = result
  return payload
}

function parseFrameTarget(value: unknown, field: string): BrainCalibrationEvaluationFrameTarget {
  const item = record(value, field)
  exactKeys(item, [
    'observationId', 'factId', 'selectionStatus', 'samplingProbability',
    'samplingWeight', 'generatedAt', 'salienceScore', 'evidenceScore',
    'candidatePopulationCount', 'sourcePath', 'sessionId', 'projectGroupId',
    'captureIntegrity', 'snapshotFingerprint',
  ], field)
  if (typeof item.observationId !== 'string' || !OBSERVATION_ID.test(item.observationId)) {
    throw new Error(`${field}.observationId ist ungültig`)
  }
  if (typeof item.factId !== 'string' || !FACT_ID.test(item.factId)) {
    throw new Error(`${field}.factId ist ungültig`)
  }
  if (item.selectionStatus !== 'selected' && item.selectionStatus !== 'sampled_unselected') {
    throw new Error(`${field}.selectionStatus ist ungültig`)
  }
  const number = (key: string, min: number, max: number): number => {
    const current = item[key]
    if (typeof current !== 'number' || !Number.isFinite(current) || current < min || current > max) {
      throw new Error(`${field}.${key} ist ungültig`)
    }
    return current
  }
  const samplingProbability = number('samplingProbability', Number.MIN_VALUE, 1)
  const samplingWeight = number('samplingWeight', 1, Number.MAX_VALUE)
  if (Math.abs(samplingWeight - (1 / samplingProbability)) > 1e-9) {
    throw new Error(`${field}.samplingWeight ist nicht reproduzierbar`)
  }
  const candidatePopulationCount = number('candidatePopulationCount', 1, 10_000)
  if (!Number.isInteger(candidatePopulationCount)) {
    throw new Error(`${field}.candidatePopulationCount muss ganzzahlig sein`)
  }
  const sourcePath = assertSafeRelativePath(String(item.sourcePath))
  const sessionId = identifier(item.sessionId, `${field}.sessionId`, 180)
  const projectGroupId = identifier(item.projectGroupId, `${field}.projectGroupId`, 64)
  return {
    observationId: item.observationId,
    factId: item.factId,
    selectionStatus: item.selectionStatus,
    samplingProbability,
    samplingWeight,
    generatedAt: isoInstant(item.generatedAt, `${field}.generatedAt`),
    salienceScore: number('salienceScore', 0, 100),
    evidenceScore: number('evidenceScore', 0, 100),
    candidatePopulationCount,
    sourcePath,
    sessionId,
    projectGroupId,
    captureIntegrity: sha256(item.captureIntegrity, `${field}.captureIntegrity`),
    snapshotFingerprint: sha256(item.snapshotFingerprint, `${field}.snapshotFingerprint`),
  }
}

function parseFrame(value: unknown): BrainCalibrationEvaluationFrameSnapshot {
  const item = record(value, 'registration.frame')
  exactKeys(item, ['targets', 'invalidCaptureBundles'], 'registration.frame')
  if (!Array.isArray(item.targets)) throw new Error('registration.frame.targets muss ein Array sein')
  if (
    typeof item.invalidCaptureBundles !== 'number'
    || !Number.isInteger(item.invalidCaptureBundles)
    || item.invalidCaptureBundles < 0
  ) {
    throw new Error('registration.frame.invalidCaptureBundles ist ungültig')
  }
  const targets = item.targets.map((target, index) =>
    parseFrameTarget(target, `registration.frame.targets[${index}]`))
  const sorted = [...targets].sort((a, b) => a.observationId.localeCompare(b.observationId, 'en'))
  if (canonicalBrainCalibrationCampaignJson(targets)
    !== canonicalBrainCalibrationCampaignJson(sorted)) {
    throw new Error('registration.frame.targets muss kanonisch sortiert sein')
  }
  if (new Set(targets.map(target => target.observationId)).size !== targets.length) {
    throw new Error('registration.frame enthält doppelte observationId')
  }
  return { targets, invalidCaptureBundles: item.invalidCaptureBundles }
}

function parseReviewPayload(value: unknown, field: string): CalibrationReviewPayload {
  const item = record(value, field)
  exactKeys(item, ['reviewId', 'statement', 'evidence'], field)
  if (typeof item.reviewId !== 'string' || !/^R[1-9]\d*$/.test(item.reviewId)) {
    throw new Error(`${field}.reviewId ist ungültig`)
  }
  if (typeof item.statement !== 'string' || !item.statement || item.statement.length > 500) {
    throw new Error(`${field}.statement ist ungültig`)
  }
  if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 8) {
    throw new Error(`${field}.evidence ist ungültig`)
  }
  const evidence = item.evidence.map((raw, index) => {
    const evidenceItem = record(raw, `${field}.evidence[${index}]`)
    exactKeys(evidenceItem, ['ref', 'hash', 'excerpt'], `${field}.evidence[${index}]`)
    if (
      typeof evidenceItem.ref !== 'string'
      || typeof evidenceItem.excerpt !== 'string'
      || evidenceItem.excerpt.length > 180
    ) {
      throw new Error(`${field}.evidence[${index}] ist ungültig`)
    }
    return {
      ref: evidenceItem.ref,
      hash: sha256(evidenceItem.hash, `${field}.evidence[${index}].hash`),
      excerpt: evidenceItem.excerpt,
    }
  })
  return { reviewId: item.reviewId, statement: item.statement, evidence }
}

function parseReviewArchive(value: unknown, index: number): BrainCalibrationCampaignReviewArchive {
  const field = `registration.reviewArchive[${index}]`
  const item = record(value, field)
  exactKeys(item, [
    'observationId', 'factId', 'sourcePath', 'reviewToken', 'reviewReference',
    'captureSchema', 'captureProducer', 'captureIntegrity', 'sampleSeed',
    'snapshotFingerprint', 'snapshotPayload', 'review',
  ], field)
  if (typeof item.observationId !== 'string' || !OBSERVATION_ID.test(item.observationId)) {
    throw new Error(`${field}.observationId ist ungültig`)
  }
  if (typeof item.factId !== 'string' || !FACT_ID.test(item.factId)) {
    throw new Error(`${field}.factId ist ungültig`)
  }
  if (typeof item.reviewToken !== 'string' || !REVIEW_TOKEN.test(item.reviewToken)) {
    throw new Error(`${field}.reviewToken ist ungültig`)
  }
  if (
    typeof item.reviewReference !== 'string'
    || !/^R[1-9]\d*$/.test(item.reviewReference)
  ) {
    throw new Error(`${field}.reviewReference ist ungültig`)
  }
  if (item.captureSchema !== CALIBRATION_CAPTURE_SCHEMA
    || item.captureProducer !== CALIBRATION_CAPTURE_PRODUCER) {
    throw new Error(`${field} trägt ein ungültiges Capture-Protokoll`)
  }
  if (typeof item.snapshotPayload !== 'string') {
    throw new Error(`${field}.snapshotPayload muss ein String sein`)
  }
  const parsedSnapshot = parseBrainCalibrationTargetSnapshot(
    JSON.parse(item.snapshotPayload) as unknown,
  )
  if (serializeCalibrationSnapshotCore(parsedSnapshot) !== item.snapshotPayload) {
    throw new Error(`${field}.snapshotPayload ist nicht kanonisch`)
  }
  const snapshotFingerprint = sha256(
    item.snapshotFingerprint,
    `${field}.snapshotFingerprint`,
  )
  if (calibrationSnapshotFingerprint(parsedSnapshot) !== snapshotFingerprint) {
    throw new Error(`${field}.snapshotFingerprint ist nicht reproduzierbar`)
  }
  return {
    observationId: item.observationId,
    factId: item.factId,
    sourcePath: assertSafeRelativePath(String(item.sourcePath)),
    reviewToken: item.reviewToken,
    reviewReference: item.reviewReference,
    captureSchema: CALIBRATION_CAPTURE_SCHEMA,
    captureProducer: CALIBRATION_CAPTURE_PRODUCER,
    captureIntegrity: sha256(item.captureIntegrity, `${field}.captureIntegrity`),
    sampleSeed: identifier(item.sampleSeed, `${field}.sampleSeed`, 35),
    snapshotFingerprint,
    snapshotPayload: item.snapshotPayload,
    review: parseReviewPayload(item.review, `${field}.review`),
  }
}

function parseCaptureArchives(value: unknown): BrainCalibrationCampaignCaptureArchive[] {
  if (!Array.isArray(value)) throw new Error('registration.captureArchives muss ein Array sein')
  const archives: BrainCalibrationCampaignCaptureArchive[] = value.map((raw, index) => {
    const field = `registration.captureArchives[${index}]`
    const item = record(raw, field)
    exactKeys(item, [
      'sourcePath', 'schema', 'producer', 'captureIntegrity', 'sessionId',
      'modelVersion', 'sampleSeed', 'candidateUniverseFactIds', 'selectedFactIds',
    ], field)
    if (item.schema !== CALIBRATION_CAPTURE_SCHEMA
      || item.producer !== CALIBRATION_CAPTURE_PRODUCER) {
      throw new Error(`${field} muss das aktuelle Capture-Schema verwenden`)
    }
    const factIds = (candidate: unknown, key: string): string[] => {
      if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 10_000) {
        throw new Error(`${field}.${key} ist ungültig`)
      }
      const ids = candidate.map((id, factIndex) => {
        if (typeof id !== 'string' || !FACT_ID.test(id)) {
          throw new Error(`${field}.${key}[${factIndex}] ist ungültig`)
        }
        return id
      })
      if (new Set(ids).size !== ids.length) {
        throw new Error(`${field}.${key} enthält Duplikate`)
      }
      if (key === 'candidateUniverseFactIds') {
        const ordered = [...ids].sort((left, right) =>
          Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
        if (canonicalBrainCalibrationCampaignJson(ids)
          !== canonicalBrainCalibrationCampaignJson(ordered)) {
          throw new Error(`${field}.${key} muss nach UTF-8-Bytes sortiert sein`)
        }
      }
      return ids
    }
    return {
      sourcePath: assertSafeRelativePath(String(item.sourcePath)),
      schema: CALIBRATION_CAPTURE_SCHEMA as typeof CALIBRATION_CAPTURE_SCHEMA,
      producer: CALIBRATION_CAPTURE_PRODUCER as typeof CALIBRATION_CAPTURE_PRODUCER,
      captureIntegrity: sha256(item.captureIntegrity, `${field}.captureIntegrity`),
      sessionId: identifier(item.sessionId, `${field}.sessionId`, 180),
      modelVersion: identifier(item.modelVersion, `${field}.modelVersion`, 120),
      sampleSeed: identifier(item.sampleSeed, `${field}.sampleSeed`, 35),
      candidateUniverseFactIds: factIds(
        item.candidateUniverseFactIds,
        'candidateUniverseFactIds',
      ),
      selectedFactIds: factIds(item.selectedFactIds, 'selectedFactIds'),
    }
  })
  const sorted = [...archives].sort((a, b) =>
    canonicalBrainCalibrationCampaignJson([a.sourcePath, a.captureIntegrity])
      .localeCompare(
        canonicalBrainCalibrationCampaignJson([b.sourcePath, b.captureIntegrity]),
        'en',
      ))
  if (canonicalBrainCalibrationCampaignJson(archives)
    !== canonicalBrainCalibrationCampaignJson(sorted)) {
    throw new Error('registration.captureArchives muss kanonisch sortiert sein')
  }
  if (new Set(archives.map(archive => archive.captureIntegrity)).size !== archives.length) {
    throw new Error('registration.captureArchives enthält doppelte Integritäten')
  }
  return archives
}

function parseSourceBindings(value: unknown): BrainCalibrationCampaignSourceBinding[] {
  if (!Array.isArray(value)) throw new Error('plan.sourceBindings muss ein Array sein')
  const expectedPaths = sourceFiles()
  const bindings = value.map((raw, index) => {
    const item = record(raw, `plan.sourceBindings[${index}]`)
    exactKeys(item, ['path', 'sha256'], `plan.sourceBindings[${index}]`)
    if (typeof item.path !== 'string' || !expectedPaths.includes(item.path)) {
      throw new Error(`plan.sourceBindings[${index}].path ist ungültig`)
    }
    return {
      path: item.path,
      sha256: sha256(item.sha256, `plan.sourceBindings[${index}].sha256`),
    }
  })
  const sorted = [...bindings].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (canonicalBrainCalibrationCampaignJson(bindings)
    !== canonicalBrainCalibrationCampaignJson(sorted)) {
    throw new Error('plan.sourceBindings muss kanonisch sortiert sein')
  }
  if (new Set(bindings.map(binding => binding.path)).size !== expectedPaths.length) {
    throw new Error('plan.sourceBindings muss jede relevante Datei exakt einmal binden')
  }
  return bindings
}

function parsePlan(value: unknown): BrainCalibrationCampaignPlan {
  const item = record(value, 'registration.plan')
  exactKeys(item, [
    'labels', 'groupBy', 'bootstrapSamples', 'cutoffAt', 'splitPlan',
    'evaluationVersion',
    'holdoutPolicyVersion', 'captureSchema', 'datasetSchemaVersion',
    'reviewProtocolVersion', 'samplePolicyVersion', 'salienceModelVersion',
    'evidenceModelVersion', 'holdoutGates', 'shadowModels', 'assuranceProfile', 'runtime',
    'sourceBindings',
  ], 'registration.plan')
  const normalized = normalizeBrainCalibrationEvaluationOptions({
    label: 'all',
    groupBy: item.groupBy as BrainCalibrationEvaluationGroupBy,
    bootstrapSamples: item.bootstrapSamples as number,
  })
  if (canonicalBrainCalibrationCampaignJson(item.labels)
    !== canonicalBrainCalibrationCampaignJson(['useful', 'supported'])) {
    throw new Error('registration.plan.labels ist ungültig')
  }
  if (
    item.evaluationVersion !== BRAIN_CALIBRATION_EVALUATION_VERSION
    || item.holdoutPolicyVersion !== BRAIN_CALIBRATION_HOLDOUT_POLICY.version
    || item.captureSchema !== CALIBRATION_CAPTURE_SCHEMA
    || item.datasetSchemaVersion !== BRAIN_CALIBRATION_SCHEMA_VERSION
    || item.reviewProtocolVersion !== REVIEW_PROTOCOL_VERSION
    || item.samplePolicyVersion !== SAMPLE_POLICY_VERSION
    || typeof item.salienceModelVersion !== 'string'
    || typeof item.evidenceModelVersion !== 'string'
  ) {
    throw new Error('registration.plan enthält ungültige Protokollversionen')
  }
  const runtime = record(item.runtime, 'registration.plan.runtime')
  exactKeys(runtime, [
    'node', 'v8', 'platform', 'arch', 'execPathSha256',
    'execArgvSha256', 'nodeOptionsSha256',
  ], 'registration.plan.runtime')
  if (
    typeof runtime.node !== 'string'
    || typeof runtime.v8 !== 'string'
    || typeof runtime.platform !== 'string'
    || typeof runtime.arch !== 'string'
    || !HASH.test(String(runtime.execPathSha256))
    || !HASH.test(String(runtime.execArgvSha256))
    || (
      runtime.nodeOptionsSha256 !== null
      && !HASH.test(String(runtime.nodeOptionsSha256))
    )
  ) {
    throw new Error('registration.plan.runtime ist ungültig')
  }
  const cutoffAt = item.cutoffAt === null
    ? null
    : isoInstant(item.cutoffAt, 'registration.plan.cutoffAt')
  const splitPlan = parseBrainCalibrationEvaluationSplitPlan(item.splitPlan)
  if (
    splitPlan.groupBy !== normalized.groupBy
    || splitPlan.cutoffAt !== cutoffAt
  ) {
    throw new Error('registration.plan.splitPlan widerspricht Gruppierung oder Cutoff')
  }
  if (canonicalBrainCalibrationCampaignJson(item.holdoutGates)
    !== canonicalBrainCalibrationCampaignJson(BRAIN_CALIBRATION_HOLDOUT_POLICY)) {
    throw new Error('registration.plan.holdoutGates stimmt nicht mit der Version überein')
  }
  if (canonicalBrainCalibrationCampaignJson(item.shadowModels)
    !== canonicalBrainCalibrationCampaignJson(BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY)) {
    throw new Error('registration.plan.shadowModels stimmt nicht mit der Version überein')
  }
  if (canonicalBrainCalibrationCampaignJson(item.assuranceProfile)
    !== canonicalBrainCalibrationCampaignJson(ASSURANCE_PROFILE)) {
    throw new Error('registration.plan.assuranceProfile ist ungültig')
  }
  return {
    labels: ['useful', 'supported'],
    groupBy: normalized.groupBy,
    bootstrapSamples: normalized.bootstrapSamples,
    cutoffAt,
    splitPlan,
    evaluationVersion: BRAIN_CALIBRATION_EVALUATION_VERSION,
    holdoutPolicyVersion: BRAIN_CALIBRATION_HOLDOUT_POLICY.version,
    captureSchema: CALIBRATION_CAPTURE_SCHEMA,
    datasetSchemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
    reviewProtocolVersion: REVIEW_PROTOCOL_VERSION,
    samplePolicyVersion: SAMPLE_POLICY_VERSION,
    salienceModelVersion: item.salienceModelVersion,
    evidenceModelVersion: item.evidenceModelVersion,
    holdoutGates: item.holdoutGates as typeof BRAIN_CALIBRATION_HOLDOUT_POLICY,
    shadowModels: item.shadowModels as typeof BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY,
    assuranceProfile: ASSURANCE_PROFILE,
    runtime: runtime as unknown as BrainCalibrationCampaignRuntimeBinding,
    sourceBindings: parseSourceBindings(item.sourceBindings),
  }
}

function parseRegistration(value: unknown): BrainCalibrationCampaignRegistration {
  const item = record(value, 'registration')
  exactKeys(item, [
    'schema', 'phase', 'campaignId', 'vaultIdHash', 'registeredAt',
    'reviewers', 'plan', 'frame', 'captureArchives', 'reviewArchive', 'frameFingerprint',
    'baselineNonPrimaryEntryCount', 'baselineNonPrimaryEntriesRoot',
    'registrationRoot',
  ], 'registration')
  if (item.schema !== BRAIN_CALIBRATION_CAMPAIGN_SCHEMA || item.phase !== 'registered') {
    throw new Error('Registrierungs-Schema oder -Phase ist ungültig')
  }
  if (!Array.isArray(item.reviewers) || item.reviewers.length < 1) {
    throw new Error('registration.reviewers muss mindestens eine ID enthalten')
  }
  const reviewers = item.reviewers.map((reviewer, index) =>
    identifier(reviewer, `registration.reviewers[${index}]`, 64))
  if (
    new Set(reviewers).size !== reviewers.length
    || canonicalBrainCalibrationCampaignJson(reviewers)
      !== canonicalBrainCalibrationCampaignJson([...reviewers].sort())
  ) {
    throw new Error('registration.reviewers muss eindeutig und sortiert sein')
  }
  const frame = parseFrame(item.frame)
  const captureArchives = parseCaptureArchives(item.captureArchives)
  const reviewArchiveRaw = item.reviewArchive
  if (!Array.isArray(reviewArchiveRaw)) {
    throw new Error('registration.reviewArchive muss ein Array sein')
  }
  const reviewArchive = reviewArchiveRaw.map(parseReviewArchive)
  if (canonicalBrainCalibrationCampaignJson(reviewArchive.map(entry => entry.observationId))
    !== canonicalBrainCalibrationCampaignJson(
      [...reviewArchive].map(entry => entry.observationId).sort(),
    )) {
    throw new Error('registration.reviewArchive muss sortiert sein')
  }
  const baselineCount = item.baselineNonPrimaryEntryCount
  if (typeof baselineCount !== 'number' || !Number.isInteger(baselineCount) || baselineCount < 0) {
    throw new Error('registration.baselineNonPrimaryEntryCount ist ungültig')
  }
  const registration: BrainCalibrationCampaignRegistration = {
    schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
    phase: 'registered',
    campaignId: identifier(item.campaignId, 'registration.campaignId'),
    vaultIdHash: sha256(item.vaultIdHash, 'registration.vaultIdHash'),
    registeredAt: isoInstant(item.registeredAt, 'registration.registeredAt'),
    reviewers,
    plan: parsePlan(item.plan),
    frame,
    captureArchives,
    reviewArchive,
    frameFingerprint: sha256(item.frameFingerprint, 'registration.frameFingerprint'),
    baselineNonPrimaryEntryCount: baselineCount,
    baselineNonPrimaryEntriesRoot: sha256(
      item.baselineNonPrimaryEntriesRoot,
      'registration.baselineNonPrimaryEntriesRoot',
    ),
    registrationRoot: sha256(item.registrationRoot, 'registration.registrationRoot'),
  }
  const validatedSplitPlan = validateBrainCalibrationSplitPlan(
    registration.plan.splitPlan,
    registration.frame,
    registration.plan.groupBy,
    registration.plan.cutoffAt,
  )
  if (
    canonicalBrainCalibrationCampaignJson(validatedSplitPlan)
      !== canonicalBrainCalibrationCampaignJson(registration.plan.splitPlan)
  ) {
    throw new Error('registration.plan.splitPlan ist nicht kanonisch')
  }
  if (registration.reviewArchive.length !== registration.frame.targets.length) {
    throw new Error('Review-Archiv und Evaluationsframe müssen gleich groß sein')
  }
  const captureRoots = new Set(
    registration.captureArchives.map(archive => archive.captureIntegrity),
  )
  if (registration.reviewArchive.some(
    archive => !captureRoots.has(archive.captureIntegrity),
  )) {
    throw new Error('Review-Archiv verweist auf ein fehlendes Capture-Archiv')
  }
  const targetById = new Map(
    registration.frame.targets.map(target => [target.observationId, target]),
  )
  const captureByIntegrity = new Map(
    registration.captureArchives.map(archive => [archive.captureIntegrity, archive]),
  )
  const seenReviewTokens = new Set<string>()
  const seenObservationIds = new Set<string>()
  for (const archive of registration.reviewArchive) {
    const target = targetById.get(archive.observationId)
    const capture = captureByIntegrity.get(archive.captureIntegrity)
    const snapshot = parseBrainCalibrationTargetSnapshot(
      JSON.parse(archive.snapshotPayload) as unknown,
    )
    if (
      !target
      || !capture
      || archive.factId !== target.factId
      || archive.sourcePath !== target.sourcePath
      || archive.sourcePath !== capture.sourcePath
      || archive.captureIntegrity !== target.captureIntegrity
      || archive.snapshotFingerprint !== target.snapshotFingerprint
      || archive.factId !== snapshot.factId
      || snapshot.generatedAt !== target.generatedAt
      || snapshot.selectionStatus !== target.selectionStatus
      || snapshot.samplingProbability !== target.samplingProbability
      || snapshot.salienceScore !== target.salienceScore
      || snapshot.evidenceScore !== target.evidenceScore
      || snapshot.candidatePopulationCount !== target.candidatePopulationCount
      || capture.sessionId !== target.sessionId
      || capture.modelVersion !== snapshot.modelVersion
      || capture.candidateUniverseFactIds.length !== target.candidatePopulationCount
      || !capture.candidateUniverseFactIds.includes(archive.factId)
      || archive.review.reviewId !== archive.reviewReference
      || calibrationObservationId(
        capture.sessionId,
        archive.factId,
        archive.snapshotFingerprint,
      ) !== archive.observationId
      || calibrationReviewToken(
        archive.captureIntegrity,
        archive.reviewReference,
        archive.snapshotFingerprint,
      ) !== archive.reviewToken
      || seenReviewTokens.has(archive.reviewToken)
      || seenObservationIds.has(archive.observationId)
    ) {
      throw new Error('Review-Archiv ist nicht reproduzierbar/bijektiv zum Frame')
    }
    seenReviewTokens.add(archive.reviewToken)
    seenObservationIds.add(archive.observationId)
  }
  if (seenObservationIds.size !== targetById.size) {
    throw new Error('Review-Archiv deckt den Frame nicht bijektiv ab')
  }
  if (registration.frameFingerprint !== computeBrainCalibrationDataFingerprint(
    [],
    registration.frame,
  )) {
    throw new Error('registration.frameFingerprint ist nicht reproduzierbar')
  }
  const expectedRoot = brainCalibrationCampaignHash(
    'registration-root-v1',
    registrationPayload(registration),
  )
  if (registration.registrationRoot !== expectedRoot) {
    throw new Error('registration.registrationRoot ist nicht reproduzierbar')
  }
  return registration
}

function parseClosureEntry(value: unknown, index: number): BrainCalibrationEntry {
  const field = `closure.entries[${index}]`
  const item = record(value, field)
  exactKeys(item, [
    'observationId', 'baseObservationId', 'label', 'value',
    'snapshot', 'recordedAt', 'reviewer',
  ], field)
  if (
    typeof item.observationId !== 'string'
    || !OBSERVATION_ID.test(item.observationId)
    || item.baseObservationId !== item.observationId
  ) {
    throw new Error(`${field}.observationId/baseObservationId ist ungültig`)
  }
  if (item.label !== 'useful' && item.label !== 'supported') {
    throw new Error(`${field}.label muss useful oder supported sein`)
  }
  if (typeof item.value !== 'boolean') throw new Error(`${field}.value muss boolean sein`)
  return {
    observationId: item.observationId,
    baseObservationId: item.observationId,
    label: item.label,
    value: item.value,
    snapshot: parseBrainCalibrationTargetSnapshot(item.snapshot),
    recordedAt: isoInstant(item.recordedAt, `${field}.recordedAt`),
    reviewer: identifier(item.reviewer, `${field}.reviewer`, 64),
  }
}

function parseClosure(value: unknown): BrainCalibrationCampaignClosure {
  const item = record(value, 'closure')
  exactKeys(item, [
    'schema', 'phase', 'campaignId', 'vaultIdHash', 'closedAt',
    'registrationRoot', 'entries', 'dataFingerprint', 'closureRoot',
  ], 'closure')
  if (item.schema !== BRAIN_CALIBRATION_CAMPAIGN_SCHEMA || item.phase !== 'closed') {
    throw new Error('Closure-Schema oder -Phase ist ungültig')
  }
  if (!Array.isArray(item.entries)) throw new Error('closure.entries muss ein Array sein')
  const closure: BrainCalibrationCampaignClosure = {
    schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
    phase: 'closed',
    campaignId: identifier(item.campaignId, 'closure.campaignId'),
    vaultIdHash: sha256(item.vaultIdHash, 'closure.vaultIdHash'),
    closedAt: isoInstant(item.closedAt, 'closure.closedAt'),
    registrationRoot: sha256(item.registrationRoot, 'closure.registrationRoot'),
    entries: item.entries.map(parseClosureEntry),
    dataFingerprint: sha256(item.dataFingerprint, 'closure.dataFingerprint'),
    closureRoot: sha256(item.closureRoot, 'closure.closureRoot'),
  }
  if (closure.closureRoot !== brainCalibrationCampaignHash(
    'closure-root-v1',
    closurePayload(closure),
  )) {
    throw new Error('closure.closureRoot ist nicht reproduzierbar')
  }
  return closure
}

function parseResult(value: unknown): BrainCalibrationCampaignResult {
  const item = record(value, 'result')
  exactKeys(item, [
    'schema', 'phase', 'campaignId', 'vaultIdHash', 'evaluatedAt',
    'registrationRoot', 'closureRoot', 'evaluation', 'resultRoot',
  ], 'result')
  if (item.schema !== BRAIN_CALIBRATION_CAMPAIGN_SCHEMA || item.phase !== 'evaluated') {
    throw new Error('Result-Schema oder -Phase ist ungültig')
  }
  const evaluation = record(
    item.evaluation,
    'result.evaluation',
  ) as unknown as BrainCalibrationEvaluationResult
  if (
    evaluation.releaseDecisionAllowed !== false
    || evaluation.activeWeightsChanged !== false
    || evaluation.evaluationVersion !== BRAIN_CALIBRATION_EVALUATION_VERSION
  ) {
    throw new Error('Versiegelte Evaluation darf weder Release noch Gewichte verändern')
  }
  const result: BrainCalibrationCampaignResult = {
    schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
    phase: 'evaluated',
    campaignId: identifier(item.campaignId, 'result.campaignId'),
    vaultIdHash: sha256(item.vaultIdHash, 'result.vaultIdHash'),
    evaluatedAt: isoInstant(item.evaluatedAt, 'result.evaluatedAt'),
    registrationRoot: sha256(item.registrationRoot, 'result.registrationRoot'),
    closureRoot: sha256(item.closureRoot, 'result.closureRoot'),
    evaluation,
    resultRoot: sha256(item.resultRoot, 'result.resultRoot'),
  }
  if (result.resultRoot !== brainCalibrationCampaignHash(
    'result-root-v1',
    resultPayload(result),
  )) {
    throw new Error('result.resultRoot ist nicht reproduzierbar')
  }
  return result
}

function readOptional<T>(
  vault: Vault,
  path: string,
  parser: (value: unknown) => T,
): T | null {
  const fullPath = localPath(vault, path)
  if (!existsSync(fullPath)) return null
  return parser(readJson(fullPath, path))
}

export function readBrainCalibrationCampaignRegistration(
  vault: Vault,
): BrainCalibrationCampaignRegistration | null {
  return readOptional(vault, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH, parseRegistration)
}

export function readBrainCalibrationCampaignClosure(
  vault: Vault,
): BrainCalibrationCampaignClosure | null {
  return readOptional(vault, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH, parseClosure)
}

export function readBrainCalibrationCampaignResult(
  vault: Vault,
): BrainCalibrationCampaignResult | null {
  return readOptional(vault, BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH, parseResult)
}

export function readBrainCalibrationCampaignState(vault: Vault): BrainCalibrationCampaignState {
  const registration = readBrainCalibrationCampaignRegistration(vault)
  const closure = readBrainCalibrationCampaignClosure(vault)
  const result = readBrainCalibrationCampaignResult(vault)
  if (!registration && (closure || result)) {
    throw new Error('Campaign-State ist beschädigt: Registrierung fehlt')
  }
  if (!closure && result) throw new Error('Campaign-State ist beschädigt: Closure fehlt')
  if (registration && closure && (
    closure.campaignId !== registration.campaignId
    || closure.vaultIdHash !== registration.vaultIdHash
    || closure.registrationRoot !== registration.registrationRoot
  )) {
    throw new Error('Campaign-Closure gehört nicht zur Registrierung')
  }
  if (registration && closure && result && (
    result.campaignId !== registration.campaignId
    || result.vaultIdHash !== registration.vaultIdHash
    || result.registrationRoot !== registration.registrationRoot
    || result.closureRoot !== closure.closureRoot
  )) {
    throw new Error('Campaign-Resultat gehört nicht zur Closure')
  }
  return {
    phase: result ? 'evaluated' : closure ? 'closed' : registration ? 'registered' : 'unregistered',
    registration,
    closure,
    result,
  }
}

export function getBrainCalibrationCampaignPhase(
  vault: Vault,
): BrainCalibrationCampaignPhase {
  return readBrainCalibrationCampaignState(vault).phase
}

function runtimeBinding(): BrainCalibrationCampaignRuntimeBinding {
  const executable = realpathSync(process.execPath)
  assertRegularFile(executable, 'Node-Executable')
  const nodeOptions = process.env.NODE_OPTIONS
  return {
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    execPathSha256: createHash('sha256')
      .update(readFileSync(executable))
      .digest('hex'),
    execArgvSha256: brainCalibrationCampaignHash(
      'node-exec-argv-v1',
      process.execArgv,
    ),
    nodeOptionsSha256: nodeOptions === undefined
      ? null
      : brainCalibrationCampaignHash('node-options-v1', nodeOptions),
  }
}

function sourceBindings(): BrainCalibrationCampaignSourceBinding[] {
  return sourceFiles().map(path => {
    const fullPath = resolve(ROOT, path)
    if (!isWithin(realpathSync(ROOT), realpathSync(fullPath))) {
      throw new Error(`Implementierungsdatei liegt außerhalb des Projekts: ${path}`)
    }
    assertRegularFile(fullPath, `Implementierungsdatei ${path}`)
    return {
      path,
      sha256: createHash('sha256').update(readFileSync(fullPath)).digest('hex'),
    }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function currentPlan(
  frame: BrainCalibrationEvaluationFrameSnapshot,
  groupBy: BrainCalibrationEvaluationGroupBy,
  bootstrapSamples?: number,
): BrainCalibrationCampaignPlan {
  const normalized = normalizeBrainCalibrationEvaluationOptions({
    label: 'all',
    groupBy,
    bootstrapSamples,
  })
  const splitPlan = deriveBrainCalibrationSplitPlan(frame, normalized.groupBy)
  return {
    labels: ['useful', 'supported'],
    groupBy: normalized.groupBy,
    bootstrapSamples: normalized.bootstrapSamples,
    cutoffAt: splitPlan.cutoffAt,
    splitPlan,
    evaluationVersion: BRAIN_CALIBRATION_EVALUATION_VERSION,
    holdoutPolicyVersion: BRAIN_CALIBRATION_HOLDOUT_POLICY.version,
    captureSchema: CALIBRATION_CAPTURE_SCHEMA,
    datasetSchemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
    reviewProtocolVersion: REVIEW_PROTOCOL_VERSION,
    samplePolicyVersion: SAMPLE_POLICY_VERSION,
    salienceModelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    evidenceModelVersion: EVIDENCE_SCORING_MODEL.version,
    holdoutGates: BRAIN_CALIBRATION_HOLDOUT_POLICY,
    shadowModels: BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY,
    assuranceProfile: ASSURANCE_PROFILE,
    runtime: runtimeBinding(),
    sourceBindings: sourceBindings(),
  }
}

function assertCurrentBinding(registration: BrainCalibrationCampaignRegistration): void {
  const expected = {
    evaluationVersion: BRAIN_CALIBRATION_EVALUATION_VERSION,
    holdoutPolicyVersion: BRAIN_CALIBRATION_HOLDOUT_POLICY.version,
    captureSchema: CALIBRATION_CAPTURE_SCHEMA,
    datasetSchemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
    reviewProtocolVersion: REVIEW_PROTOCOL_VERSION,
    samplePolicyVersion: SAMPLE_POLICY_VERSION,
    salienceModelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    evidenceModelVersion: EVIDENCE_SCORING_MODEL.version,
    holdoutGates: BRAIN_CALIBRATION_HOLDOUT_POLICY,
    shadowModels: BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY,
    assuranceProfile: ASSURANCE_PROFILE,
    runtime: runtimeBinding(),
    sourceBindings: sourceBindings(),
  }
  const actual = {
    evaluationVersion: registration.plan.evaluationVersion,
    holdoutPolicyVersion: registration.plan.holdoutPolicyVersion,
    captureSchema: registration.plan.captureSchema,
    datasetSchemaVersion: registration.plan.datasetSchemaVersion,
    reviewProtocolVersion: registration.plan.reviewProtocolVersion,
    samplePolicyVersion: registration.plan.samplePolicyVersion,
    salienceModelVersion: registration.plan.salienceModelVersion,
    evidenceModelVersion: registration.plan.evidenceModelVersion,
    holdoutGates: registration.plan.holdoutGates,
    shadowModels: registration.plan.shadowModels,
    assuranceProfile: registration.plan.assuranceProfile,
    runtime: registration.plan.runtime,
    sourceBindings: registration.plan.sourceBindings,
  }
  if (canonicalBrainCalibrationCampaignJson(actual)
    !== canonicalBrainCalibrationCampaignJson(expected)) {
    throw new Error(
      'Implementierung, Modelle, Holdout-Regeln oder Runtime sind seit '
      + 'der Registrierung gedriftet; diese Kampagne darf nicht ausgewertet werden',
    )
  }
}

function normalizeReviewers(reviewers: unknown): string[] {
  if (!Array.isArray(reviewers) || reviewers.length < 1 || reviewers.length > 64) {
    throw new Error('reviewers muss 1 bis 64 opake Reviewer-IDs enthalten')
  }
  const normalized = reviewers.map((reviewer, index) =>
    identifier(reviewer, `reviewers[${index}]`, 64)).sort()
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('reviewers darf keine Duplikate enthalten')
  }
  return normalized
}

function normalizeFrame(
  frame: BrainCalibrationEvaluationFrameSnapshot,
): BrainCalibrationEvaluationFrameSnapshot {
  return parseFrame({
    targets: [...frame.targets].sort(
      (a, b) => a.observationId.localeCompare(b.observationId, 'en'),
    ),
    invalidCaptureBundles: frame.invalidCaptureBundles,
  })
}

function collectReviewArchive(
  vault: Vault,
  frame: BrainCalibrationEvaluationFrameSnapshot,
): {
  reviewArchive: BrainCalibrationCampaignReviewArchive[]
  captureArchives: BrainCalibrationCampaignCaptureArchive[]
} {
  const targetById = new Map(frame.targets.map(target => [target.observationId, target]))
  const archive = new Map<string, BrainCalibrationCampaignReviewArchive>()
  const captureArchive = new Map<string, BrainCalibrationCampaignCaptureArchive>()
  for (const note of vault.notes.values()) {
    if (note.frontmatter.calibration_capture_schema === undefined) continue
    let bundle
    try {
      bundle = parseCalibrationCaptureBundle(note.frontmatter)
    } catch {
      continue
    }
    if (bundle.schema !== CALIBRATION_CAPTURE_SCHEMA) {
      throw new Error(`Capture ${note.relativePath} verwendet ein veraltetes Schema`)
    }
    if (!bundle.candidateUniverseFactIds) {
      throw new Error(`Capture ${note.relativePath} bindet keine Kandidatenpopulation`)
    }
    const relevant = bundle.facts.some(fact => targetById.has(calibrationObservationId(
      bundle.sessionId,
      fact.factId,
      fact.fingerprint,
    )))
    if (relevant) {
      const existingCapture = captureArchive.get(bundle.integrity)
      const candidate: BrainCalibrationCampaignCaptureArchive = {
        sourcePath: assertSafeRelativePath(note.relativePath),
        schema: CALIBRATION_CAPTURE_SCHEMA,
        producer: CALIBRATION_CAPTURE_PRODUCER,
        captureIntegrity: bundle.integrity,
        sessionId: bundle.sessionId,
        modelVersion: bundle.modelVersion,
        sampleSeed: bundle.sampleSeed,
        candidateUniverseFactIds: [...bundle.candidateUniverseFactIds],
        selectedFactIds: [...bundle.selectedFactIds],
      }
      if (existingCapture && canonicalBrainCalibrationCampaignJson(existingCapture)
        !== canonicalBrainCalibrationCampaignJson(candidate)) {
        throw new Error(`Capture-Integrität ist nicht eindeutig: ${bundle.integrity}`)
      }
      captureArchive.set(bundle.integrity, candidate)
    }
    for (const fact of bundle.facts) {
      const observationId = calibrationObservationId(
        bundle.sessionId,
        fact.factId,
        fact.fingerprint,
      )
      const target = targetById.get(observationId)
      if (!target) continue
      if (archive.has(observationId)) {
        throw new Error(`Doppelte Campaign-Beobachtung: ${observationId}`)
      }
      if (
        target.factId !== fact.factId
        || target.sourcePath !== note.relativePath
        || target.sessionId !== bundle.sessionId
        || target.captureIntegrity !== bundle.integrity
        || target.snapshotFingerprint !== fact.fingerprint
      ) {
        throw new Error(`Evaluator-Frame und Capture widersprechen sich für ${observationId}`)
      }
      const reviewToken = calibrationReviewToken(
        bundle.integrity,
        fact.reviewReference,
        fact.fingerprint,
      )
      archive.set(observationId, {
        observationId,
        factId: fact.factId,
        sourcePath: assertSafeRelativePath(note.relativePath),
        reviewToken,
        reviewReference: fact.reviewReference,
        captureSchema: bundle.schema,
        captureProducer: bundle.producer,
        captureIntegrity: bundle.integrity,
        sampleSeed: bundle.sampleSeed,
        snapshotFingerprint: fact.fingerprint,
        snapshotPayload: fact.payloadRaw,
        review: fact.review,
      })
    }
  }
  if (archive.size !== frame.targets.length) {
    const missing = frame.targets
      .filter(target => !archive.has(target.observationId))
      .map(target => target.observationId)
    throw new Error(`Review-Archiv ist unvollständig: ${missing.join(', ')}`)
  }
  const items = [...archive.values()].sort(
    (a, b) => a.observationId.localeCompare(b.observationId, 'en'),
  )
  if (new Set(items.map(item => item.reviewToken)).size !== items.length) {
    throw new Error('Review-Token-Kollision im Campaign-Frame')
  }
  return {
    reviewArchive: items,
    captureArchives: [...captureArchive.values()].sort((a, b) =>
      canonicalBrainCalibrationCampaignJson([a.sourcePath, a.captureIntegrity])
        .localeCompare(
          canonicalBrainCalibrationCampaignJson([b.sourcePath, b.captureIntegrity]),
          'en',
        )),
  }
}

function frameEntry(entry: BrainCalibrationEntry, frameIds: ReadonlySet<string>): boolean {
  return frameIds.has(entry.baseObservationId ?? entry.observationId)
}

function sortedEntries(entries: readonly BrainCalibrationEntry[]): BrainCalibrationEntry[] {
  return [...entries].sort((left, right) =>
    canonicalBrainCalibrationCampaignJson(left)
      .localeCompare(canonicalBrainCalibrationCampaignJson(right), 'en'))
}

function nonPrimaryBaseline(
  entries: readonly BrainCalibrationEntry[],
  frameIds: ReadonlySet<string>,
): { count: number; root: string } {
  const baseline = sortedEntries(entries.filter(entry =>
    frameEntry(entry, frameIds)
    && entry.label !== 'useful'
    && entry.label !== 'supported'))
  return {
    count: baseline.length,
    root: brainCalibrationCampaignHash('registration-non-primary-baseline-v1', baseline),
  }
}

function buildRegistration(
  vault: Vault,
  context: AnchorContext,
  options: RegisterBrainCalibrationCampaignOptions,
  registeredAt = now(),
): BrainCalibrationCampaignRegistration {
  vault.refreshIndex()
  const frame = normalizeFrame(collectBrainCalibrationEvaluationFrame(vault))
  if (frame.invalidCaptureBundles !== 0) {
    throw new Error(
      `Registrierung blockiert: ${frame.invalidCaptureBundles} ungültige Capture-Bundles`,
    )
  }
  if (frame.targets.length === 0) {
    throw new Error('Registrierung braucht mindestens ein gültiges Evaluationstarget')
  }
  const { reviewArchive, captureArchives } = collectReviewArchive(vault, frame)
  const dataset = readBrainCalibrationDataset(vault)
  const frameIds = new Set(frame.targets.map(target => target.observationId))
  const leakedPrimary = dataset.entries.filter(entry =>
    frameEntry(entry, frameIds)
    && (entry.label === 'useful' || entry.label === 'supported'))
  if (leakedPrimary.length > 0) {
    throw new Error(
      'Registrierung ist nach Vorab-Entblindung unzulässig: '
      + `${leakedPrimary.length} useful/supported-Labels existieren bereits`,
    )
  }
  const baseline = nonPrimaryBaseline(dataset.entries, frameIds)
  const plan = currentPlan(frame, options.groupBy, options.bootstrapSamples)
  if (plan.cutoffAt === null) {
    throw new Error(
      'Registrierung braucht einen identifizierbaren strikten Cutoff '
      + '(mindestens zwei zeitlich trennbare Leakage-Gruppen)',
    )
  }
  const base: Omit<BrainCalibrationCampaignRegistration, 'registrationRoot'> = {
    schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
    phase: 'registered',
    campaignId: identifier(options.campaignId, 'campaignId'),
    vaultIdHash: context.vaultIdHash,
    registeredAt: isoInstant(registeredAt, 'registeredAt'),
    reviewers: normalizeReviewers(options.reviewers),
    plan,
    frame,
    captureArchives,
    reviewArchive,
    frameFingerprint: computeBrainCalibrationDataFingerprint([], frame),
    baselineNonPrimaryEntryCount: baseline.count,
    baselineNonPrimaryEntriesRoot: baseline.root,
  }
  return {
    ...base,
    registrationRoot: brainCalibrationCampaignHash('registration-root-v1', base),
  }
}

function assertRegistrationPreviewConfirmation(
  registration: BrainCalibrationCampaignRegistration,
  options: RegisterBrainCalibrationCampaignOptions,
): void {
  const expectedRoot = sha256(
    options.expectedRegistrationRoot,
    'expectedRegistrationRoot',
  )
  const expectedRegisteredAt = isoInstant(
    options.expectedRegisteredAt,
    'expectedRegisteredAt',
  )
  if (
    expectedRoot !== registration.registrationRoot
    || expectedRegisteredAt !== registration.registeredAt
  ) {
    throw new Error(
      'Registrierungs-Vorschau ist gedriftet; prüfe den neuen Dry-Run '
      + 'und bestätige dessen exakten Root und Zeitpunkt',
    )
  }
}

function assertRegistrationOptionsMatch(
  registration: BrainCalibrationCampaignRegistration,
  options: RegisterBrainCalibrationCampaignOptions,
): void {
  const normalized = normalizeBrainCalibrationEvaluationOptions({
    label: 'all',
    groupBy: options.groupBy,
    bootstrapSamples: options.bootstrapSamples,
  })
  if (
    identifier(options.campaignId, 'campaignId') !== registration.campaignId
    || canonicalBrainCalibrationCampaignJson(normalizeReviewers(options.reviewers))
      !== canonicalBrainCalibrationCampaignJson(registration.reviewers)
    || normalized.groupBy !== registration.plan.groupBy
    || normalized.bootstrapSamples !== registration.plan.bootstrapSamples
  ) {
    throw new Error('Campaign ist bereits mit einem anderen Analyseplan registriert')
  }
}

function registrationOperation(
  vault: Vault,
  options: RegisterBrainCalibrationCampaignOptions,
  apply: boolean,
): BrainCalibrationCampaignMutationResult<BrainCalibrationCampaignRegistration> {
  const context = anchorContext(vault, true) as AnchorContext
  const state = readBrainCalibrationCampaignState(vault)
  assertReceiptHistory(context, state.registration, state.closure, state.result)
  if (state.registration) {
    if (state.registration.vaultIdHash !== context.vaultIdHash) {
      throw new Error('Lokale Registrierung gehört zu einer anderen Vault-ID')
    }
    assertRegistrationOptionsMatch(state.registration, options)
    if (apply) {
      assertRegistrationPreviewConfirmation(state.registration, options)
    }
    assertCurrentBinding(state.registration)
    if (!externalReceipt(
      context,
      state.registration.campaignId,
      'registration',
    )) {
      assertFreshFrameMatchesRegistration(vault, state.registration)
      const dataset = readBrainCalibrationDataset(vault)
      const frameIds = new Set(
        state.registration.frame.targets.map(target => target.observationId),
      )
      if (dataset.entries.some(entry =>
        frameEntry(entry, frameIds)
        && (entry.label === 'useful' || entry.label === 'supported'))) {
        throw new Error(
          'Registrierungs-Anchor muss vor dem ersten useful/supported-Review entstehen',
        )
      }
      const baseline = nonPrimaryBaseline(dataset.entries, frameIds)
      if (
        baseline.count !== state.registration.baselineNonPrimaryEntryCount
        || baseline.root !== state.registration.baselineNonPrimaryEntriesRoot
      ) {
        throw new Error('Lokale Registrierung ist vor externer Verankerung gedriftet')
      }
    }
    const anchored = ensureReceipt(
      context,
      state.registration.campaignId,
      'registration',
      state.registration.registrationRoot,
      null,
      apply,
    )
    return {
      dryRun: !apply,
      operation: 'unchanged',
      externalAnchor: anchored,
      artifact: state.registration,
    }
  }
  const registration = buildRegistration(
    vault,
    context,
    options,
    apply
      ? isoInstant(options.expectedRegisteredAt, 'expectedRegisteredAt')
      : now(),
  )
  if (!apply) {
    return {
      dryRun: true,
      operation: 'created',
      externalAnchor: 'pending',
      artifact: registration,
    }
  }
  assertRegistrationPreviewConfirmation(registration, options)
  ensureCampaignDirectory(vault)
  writeCreateOnly(
    localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH),
    registration,
  )
  const anchored = ensureReceipt(
    context,
    registration.campaignId,
    'registration',
    registration.registrationRoot,
    null,
    true,
  )
  return {
    dryRun: false,
    operation: 'created',
    externalAnchor: anchored,
    artifact: registration,
  }
}

export function registerBrainCalibrationCampaign(
  vault: Vault,
  options: RegisterBrainCalibrationCampaignOptions,
): BrainCalibrationCampaignMutationResult<BrainCalibrationCampaignRegistration> {
  const dryRun = options.dryRun ?? true
  if (typeof dryRun !== 'boolean') throw new Error('dryRun muss boolean sein')
  if (dryRun) return registrationOperation(vault, options, false)
  assertCanWriteTool('brain_calibration_register_campaign', [
    BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH,
    BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH,
  ])
  return withBrainCalibrationCampaignLock(vault, () => {
    const result = registrationOperation(vault, options, true)
    appendCampaignAction(
      vault,
      'brain_calibration_register_campaign',
      BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH,
      result.operation,
      result.externalAnchor,
      result.artifact.campaignId,
      result.artifact.phase,
      result.artifact.registrationRoot,
    )
    return result
  })
}

export interface CloseBrainCalibrationCampaignOptions {
  dryRun?: boolean
}

export interface EvaluateSealedBrainCalibrationCampaignOptions {
  confirm: true
}

function verifyRegistrationAnchor(
  context: AnchorContext,
  registration: BrainCalibrationCampaignRegistration,
): ExternalAnchorReceipt {
  const receipt = verifyReceipt(
    context,
    registration.campaignId,
    'registration',
    registration.registrationRoot,
    null,
  )
  if (Date.parse(receipt.anchoredAt) < Date.parse(registration.registeredAt)) {
    throw new Error('Registrierungs-Anchor darf nicht vor der lokalen Registrierung liegen')
  }
  return receipt
}

function assertFreshFrameMatchesRegistration(
  vault: Vault,
  registration: BrainCalibrationCampaignRegistration,
): void {
  vault.refreshIndex()
  const frame = normalizeFrame(collectBrainCalibrationEvaluationFrame(vault))
  if (canonicalBrainCalibrationCampaignJson(frame)
    !== canonicalBrainCalibrationCampaignJson(registration.frame)) {
    throw new Error(
      'Capture-Frame ist seit der Registrierung gedriftet; Closure wird fail-closed blockiert',
    )
  }
  const archive = collectReviewArchive(vault, frame)
  if (canonicalBrainCalibrationCampaignJson(archive.reviewArchive)
    !== canonicalBrainCalibrationCampaignJson(registration.reviewArchive)) {
    throw new Error(
      'Blind-Review-/Capture-Archiv ist seit der Registrierung gedriftet',
    )
  }
  if (canonicalBrainCalibrationCampaignJson(archive.captureArchives)
    !== canonicalBrainCalibrationCampaignJson(registration.captureArchives)) {
    throw new Error('Kandidatenpopulation ist seit der Registrierung gedriftet')
  }
}

function validatePrimaryEntries(
  registration: BrainCalibrationCampaignRegistration,
  allEntries: readonly BrainCalibrationEntry[],
  verifyNonPrimaryBaseline = true,
  minimumReviewAt = registration.registeredAt,
  maximumReviewAt?: string,
): BrainCalibrationEntry[] {
  const targetById = new Map(
    registration.frame.targets.map(target => [target.observationId, target]),
  )
  const archiveById = new Map(
    registration.reviewArchive.map(archive => [archive.observationId, archive]),
  )
  const frameIds = new Set(targetById.keys())
  if (verifyNonPrimaryBaseline) {
    const baseline = nonPrimaryBaseline(allEntries, frameIds)
    if (
      baseline.count !== registration.baselineNonPrimaryEntryCount
      || baseline.root !== registration.baselineNonPrimaryEntriesRoot
    ) {
      throw new Error('Nicht-primäre Campaign-Labels sind seit der Registrierung gedriftet')
    }
  }
  const entries = allEntries.filter(entry =>
    frameEntry(entry, frameIds)
    && (entry.label === 'useful' || entry.label === 'supported'))
  const expectedCount = frameIds.size * registration.reviewers.length * 2
  if (entries.length !== expectedCount) {
    throw new Error(
      `Closure braucht exakt ${expectedCount} primäre Einträge; vorhanden: ${entries.length}`,
    )
  }
  const expectedKeys = new Set<string>()
  for (const observationId of frameIds) {
    for (const reviewer of registration.reviewers) {
      expectedKeys.add(canonicalBrainCalibrationCampaignJson(
        [observationId, reviewer, 'useful'],
      ))
      expectedKeys.add(canonicalBrainCalibrationCampaignJson(
        [observationId, reviewer, 'supported'],
      ))
    }
  }
  const pairs = new Map<string, BrainCalibrationEntry[]>()
  for (const entry of entries) {
    const observationId = entry.baseObservationId ?? entry.observationId
    const key = canonicalBrainCalibrationCampaignJson(
      [observationId, entry.reviewer, entry.label],
    )
    if (!expectedKeys.delete(key)) {
      throw new Error(
        `Unerwartetes oder doppeltes Campaign-Label: ${observationId}/${entry.reviewer}/${entry.label}`,
      )
    }
    if (
      Date.parse(entry.recordedAt) < Date.parse(minimumReviewAt)
      || Date.parse(entry.recordedAt) < Date.parse(entry.snapshot.generatedAt)
      || (
        maximumReviewAt !== undefined
        && Date.parse(entry.recordedAt) > Date.parse(maximumReviewAt)
      )
    ) {
      throw new Error(
        'Campaign-Labels müssen zwischen Registrierung/Capture und Closure liegen',
      )
    }
    const target = targetById.get(observationId)
    const archive = archiveById.get(observationId)
    if (!target || !archive) throw new Error(`Target ${observationId} fehlt im Siegel`)
    const snapshot = entry.snapshot
    if (
      entry.observationId !== observationId
      || snapshot.factId !== target.factId
      || snapshot.sourcePath !== target.sourcePath
      || snapshot.sessionId !== target.sessionId
      || snapshot.projectGroupId !== target.projectGroupId
      || snapshot.generatedAt !== target.generatedAt
      || snapshot.samplingProbability !== target.samplingProbability
      || calibrationSnapshotFingerprint(snapshot) !== target.snapshotFingerprint
      || serializeCalibrationSnapshotCore(snapshot) !== archive.snapshotPayload
    ) {
      throw new Error(`Label-Snapshot und Registrierungsframe widersprechen sich: ${observationId}`)
    }
    const pairKey = canonicalBrainCalibrationCampaignJson([observationId, entry.reviewer])
    const pair = pairs.get(pairKey) ?? []
    pair.push(entry)
    pairs.set(pairKey, pair)
  }
  if (expectedKeys.size !== 0) throw new Error('Campaign-Labelmatrix ist unvollständig')
  for (const pair of pairs.values()) {
    if (
      pair.length !== 2
      || new Set(pair.map(entry => entry.label)).size !== 2
      || pair[0].recordedAt !== pair[1].recordedAt
      || serializeCalibrationSnapshotCore(pair[0].snapshot)
        !== serializeCalibrationSnapshotCore(pair[1].snapshot)
    ) {
      throw new Error('useful/supported müssen ein atomares, zeitgleiches Snapshot-Paar bilden')
    }
  }
  return sortedEntries(entries)
}

function buildClosure(
  vault: Vault,
  registration: BrainCalibrationCampaignRegistration,
  minimumReviewAt: string,
  closedAt = now(),
): BrainCalibrationCampaignClosure {
  const canonicalClosedAt = isoInstant(closedAt, 'closure.closedAt')
  assertFreshFrameMatchesRegistration(vault, registration)
  const entries = validatePrimaryEntries(
    registration,
    readBrainCalibrationDataset(vault).entries,
    true,
    minimumReviewAt,
    canonicalClosedAt,
  )
  const base: Omit<BrainCalibrationCampaignClosure, 'closureRoot'> = {
    schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
    phase: 'closed',
    campaignId: registration.campaignId,
    vaultIdHash: registration.vaultIdHash,
    closedAt: canonicalClosedAt,
    registrationRoot: registration.registrationRoot,
    entries,
    dataFingerprint: computeBrainCalibrationDataFingerprint(entries, registration.frame),
  }
  return {
    ...base,
    closureRoot: brainCalibrationCampaignHash('closure-root-v1', base),
  }
}

function assertClosureMatchesRegistration(
  registration: BrainCalibrationCampaignRegistration,
  closure: BrainCalibrationCampaignClosure,
  minimumReviewAt: string,
): void {
  if (
    closure.campaignId !== registration.campaignId
    || closure.vaultIdHash !== registration.vaultIdHash
    || closure.registrationRoot !== registration.registrationRoot
    || Date.parse(closure.closedAt) < Date.parse(registration.registeredAt)
  ) {
    throw new Error('Closure ist nicht konsistent mit der Registrierung')
  }
  validatePrimaryEntries(
    registration,
    closure.entries,
    false,
    minimumReviewAt,
    closure.closedAt,
  )
  const fingerprint = computeBrainCalibrationDataFingerprint(
    closure.entries,
    registration.frame,
  )
  if (closure.dataFingerprint !== fingerprint) {
    throw new Error('Closure-Datenfingerprint ist nicht reproduzierbar')
  }
}

function closureOperation(
  vault: Vault,
  apply: boolean,
): BrainCalibrationCampaignMutationResult<BrainCalibrationCampaignClosure> {
  const context = anchorContext(vault, true) as AnchorContext
  const state = readBrainCalibrationCampaignState(vault)
  assertReceiptHistory(
    context,
    state.registration,
    state.closure,
    state.result,
    { allowClosureRecovery: state.registration !== null && state.closure === null },
  )
  const registration = state.registration
  if (!registration) throw new Error('Kampagne muss vor der Closure registriert werden')
  if (registration.vaultIdHash !== context.vaultIdHash) {
    throw new Error('Lokale Registrierung gehört zu einer anderen Vault-ID')
  }
  const registrationAnchor = verifyRegistrationAnchor(context, registration)
  assertCurrentBinding(registration)
  if (state.closure) {
    assertClosureMatchesRegistration(
      registration,
      state.closure,
      registrationAnchor.anchoredAt,
    )
    const existingAnchor = externalReceipt(
      context,
      registration.campaignId,
      'closure',
    )
    if (!existingAnchor) {
      throw new Error(
        'Nicht verankerte lokale Closure wird nicht nachträglich extern signiert; '
        + 'die Kampagne bleibt fail-closed',
      )
    }
    const anchored = ensureReceipt(
      context,
      registration.campaignId,
      'closure',
      state.closure.closureRoot,
      registration.registrationRoot,
      apply,
      state.closure.closedAt,
    )
    return {
      dryRun: !apply,
      operation: 'unchanged',
      externalAnchor: anchored,
      artifact: state.closure,
    }
  }
  const recoveryAnchor = externalReceipt(
    context,
    registration.campaignId,
    'closure',
  )
  if (recoveryAnchor) {
    verifyReceipt(
      context,
      registration.campaignId,
      'closure',
      recoveryAnchor.root,
      registration.registrationRoot,
    )
    if (Date.parse(recoveryAnchor.anchoredAt) < Date.parse(registrationAnchor.anchoredAt)) {
      throw new Error('Closure-Anchor darf nicht vor dem Registrierungs-Anchor liegen')
    }
    const recovered = buildClosure(
      vault,
      registration,
      registrationAnchor.anchoredAt,
      recoveryAnchor.anchoredAt,
    )
    if (recovered.closureRoot !== recoveryAnchor.root) {
      throw new Error(
        'Externer Closure-Anchor lässt sich nicht exakt aus dem Live-Dataset rekonstruieren',
      )
    }
    if (!apply) {
      return {
        dryRun: true,
        operation: 'created',
        externalAnchor: 'verified',
        artifact: recovered,
      }
    }
    ensureCampaignDirectory(vault)
    writeCreateOnly(
      localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH),
      recovered,
    )
    return {
      dryRun: false,
      operation: 'created',
      externalAnchor: 'verified',
      artifact: recovered,
    }
  }
  const closure = buildClosure(vault, registration, registrationAnchor.anchoredAt)
  if (!apply) {
    return {
      dryRun: true,
      operation: 'created',
      externalAnchor: 'pending',
      artifact: closure,
    }
  }
  ensureCampaignDirectory(vault)
  const anchored = ensureReceipt(
    context,
    registration.campaignId,
    'closure',
    closure.closureRoot,
    registration.registrationRoot,
    true,
    closure.closedAt,
  )
  // The externally durable root is the commit point. If this local write
  // crashes, the only supported recovery direction reconstructs the exact
  // local artifact from that already anchored root.
  writeCreateOnly(localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH), closure)
  return {
    dryRun: false,
    operation: 'created',
    externalAnchor: anchored,
    artifact: closure,
  }
}

export function closeBrainCalibrationCampaign(
  vault: Vault,
  options: CloseBrainCalibrationCampaignOptions = {},
): BrainCalibrationCampaignMutationResult<BrainCalibrationCampaignClosure> {
  const dryRun = options.dryRun ?? true
  if (typeof dryRun !== 'boolean') throw new Error('dryRun muss boolean sein')
  if (dryRun) return closureOperation(vault, false)
  assertCanWriteTool('brain_calibration_close_campaign', [
    BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH,
    BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH,
  ])
  return withBrainCalibrationCampaignLock(vault, () => {
    const result = closureOperation(vault, true)
    appendCampaignAction(
      vault,
      'brain_calibration_close_campaign',
      BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH,
      result.operation,
      result.externalAnchor,
      result.artifact.campaignId,
      result.artifact.phase,
      result.artifact.closureRoot,
    )
    return result
  })
}

function verifyClosureAnchor(
  context: AnchorContext,
  registration: BrainCalibrationCampaignRegistration,
  closure: BrainCalibrationCampaignClosure,
): ExternalAnchorReceipt {
  const receipt = verifyReceipt(
    context,
    registration.campaignId,
    'closure',
    closure.closureRoot,
    registration.registrationRoot,
  )
  if (receipt.anchoredAt !== closure.closedAt) {
    throw new Error(
      'Closure-Anchor und lokale Closure müssen exakt denselben Zeitpunkt binden',
    )
  }
  return receipt
}

function assertResultMatchesClosure(
  registration: BrainCalibrationCampaignRegistration,
  closure: BrainCalibrationCampaignClosure,
  result: BrainCalibrationCampaignResult,
): void {
  if (
    result.campaignId !== registration.campaignId
    || result.vaultIdHash !== registration.vaultIdHash
    || result.registrationRoot !== registration.registrationRoot
    || result.closureRoot !== closure.closureRoot
    || result.evaluation.dataFingerprint !== closure.dataFingerprint
    || result.evaluation.releaseDecisionAllowed !== false
    || result.evaluation.activeWeightsChanged !== false
  ) {
    throw new Error('Versiegeltes Resultat ist nicht konsistent mit der Closure')
  }
}

function sealedEvaluation(
  registration: BrainCalibrationCampaignRegistration,
  closure: BrainCalibrationCampaignClosure,
): BrainCalibrationEvaluationResult {
  const evaluation = evaluateBrainCalibrationSnapshot(
    closure.entries,
    registration.frame,
    {
      label: 'all',
      groupBy: registration.plan.groupBy,
      bootstrapSamples: registration.plan.bootstrapSamples,
    },
    registration.plan.cutoffAt,
    registration.plan.splitPlan,
  )
  if (
    evaluation.releaseDecisionAllowed !== false
    || evaluation.activeWeightsChanged !== false
    || evaluation.dataFingerprint !== closure.dataFingerprint
    || evaluation.reports.some(report =>
      report.split.cutoffAt !== registration.plan.cutoffAt)
  ) {
    throw new Error('Evaluator verletzte den versiegelten Analyseplan')
  }
  return evaluation
}

function evaluationWithoutTimestamp(
  evaluation: BrainCalibrationEvaluationResult,
): Omit<BrainCalibrationEvaluationResult, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...stable } = evaluation
  return stable
}

export function evaluateSealedBrainCalibrationCampaign(
  vault: Vault,
  options: EvaluateSealedBrainCalibrationCampaignOptions,
): BrainCalibrationCampaignMutationResult<BrainCalibrationCampaignResult> {
  if (options?.confirm !== true) {
    throw new Error('confirm muss für die irreversible versiegelte Evaluation true sein')
  }
  assertCanWriteTool('brain_calibration_evaluate_sealed', [
    BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH,
    BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH,
  ])
  return withBrainCalibrationCampaignLock(vault, () => {
    const context = anchorContext(vault, true) as AnchorContext
    const state = readBrainCalibrationCampaignState(vault)
    assertReceiptHistory(context, state.registration, state.closure, state.result)
    const registration = state.registration
    const closure = state.closure
    if (!registration || !closure) {
      throw new Error('Versiegelte Evaluation erfordert Registrierung und Closure')
    }
    if (registration.vaultIdHash !== context.vaultIdHash) {
      throw new Error('Lokale Kampagne gehört zu einer anderen Vault-ID')
    }
    const registrationAnchor = verifyRegistrationAnchor(context, registration)
    verifyClosureAnchor(context, registration, closure)
    if (state.result) {
      assertResultMatchesClosure(registration, closure, state.result)
      if (!externalReceipt(context, registration.campaignId, 'result')) {
        // A crash can leave the create-only local result just before its
        // external receipt. Before anchoring that artifact, reproduce every
        // deterministic output under the originally bound implementation.
        assertCurrentBinding(registration)
        assertClosureMatchesRegistration(
          registration,
          closure,
          registrationAnchor.anchoredAt,
        )
        const reproduced = sealedEvaluation(registration, closure)
        if (canonicalBrainCalibrationCampaignJson(
          evaluationWithoutTimestamp(reproduced),
        ) !== canonicalBrainCalibrationCampaignJson(
          evaluationWithoutTimestamp(state.result.evaluation),
        )) {
          throw new Error('Nicht verankertes lokales Resultat ist nicht reproduzierbar')
        }
      }
      const anchored = ensureReceipt(
        context,
        registration.campaignId,
        'result',
        state.result.resultRoot,
        closure.closureRoot,
        true,
      )
      const replay: BrainCalibrationCampaignMutationResult<
        BrainCalibrationCampaignResult
      > = {
        dryRun: false,
        operation: 'unchanged',
        externalAnchor: anchored,
        artifact: state.result,
      }
      appendCampaignAction(
        vault,
        'brain_calibration_evaluate_sealed',
        BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH,
        replay.operation,
        replay.externalAnchor,
        replay.artifact.campaignId,
        replay.artifact.phase,
        replay.artifact.resultRoot,
      )
      return replay
    }
    assertCurrentBinding(registration)
    assertClosureMatchesRegistration(
      registration,
      closure,
      registrationAnchor.anchoredAt,
    )
    // Deliberately no live dataset/capture fallback: the only analysis inputs
    // are the frozen Closure entries and the frozen Registration frame.
    const evaluation = sealedEvaluation(registration, closure)
    const base: Omit<BrainCalibrationCampaignResult, 'resultRoot'> = {
      schema: BRAIN_CALIBRATION_CAMPAIGN_SCHEMA,
      phase: 'evaluated',
      campaignId: registration.campaignId,
      vaultIdHash: registration.vaultIdHash,
      evaluatedAt: now(),
      registrationRoot: registration.registrationRoot,
      closureRoot: closure.closureRoot,
      evaluation,
    }
    const result: BrainCalibrationCampaignResult = {
      ...base,
      resultRoot: brainCalibrationCampaignHash('result-root-v1', base),
    }
    ensureCampaignDirectory(vault)
    writeCreateOnly(localPath(vault, BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH), result)
    const anchored = ensureReceipt(
      context,
      registration.campaignId,
      'result',
      result.resultRoot,
      closure.closureRoot,
      true,
    )
    const created: BrainCalibrationCampaignMutationResult<
      BrainCalibrationCampaignResult
    > = {
      dryRun: false,
      operation: 'created',
      externalAnchor: anchored,
      artifact: result,
    }
    appendCampaignAction(
      vault,
      'brain_calibration_evaluate_sealed',
      BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH,
      created.operation,
      created.externalAnchor,
      created.artifact.campaignId,
      created.artifact.phase,
      created.artifact.resultRoot,
    )
    return created
  })
}

function trustedCampaignState(vault: Vault): BrainCalibrationCampaignState {
  const state = readBrainCalibrationCampaignState(vault)
  const context = anchorContext(vault, state.registration !== null)
  if (!context) return state
  assertReceiptHistory(context, state.registration, state.closure, state.result)
  if (state.registration) {
    if (state.registration.vaultIdHash !== context.vaultIdHash) {
      throw new Error('Lokale Kampagne gehört zu einer anderen Vault-ID')
    }
    verifyRegistrationAnchor(context, state.registration)
    if (state.closure) verifyClosureAnchor(context, state.registration, state.closure)
    if (state.result) {
      verifyReceipt(
        context,
        state.registration.campaignId,
        'result',
        state.result.resultRoot,
        state.closure?.closureRoot ?? null,
      )
    }
  }
  return state
}

/** Blocks the mutable/live evaluator once a protected frame is registered. */
export function assertBrainCalibrationExploratoryAccess(vault: Vault): void {
  const state = trustedCampaignState(vault)
  if (state.phase === 'registered' || state.phase === 'closed') {
    throw new Error(
      'Explorative Auswertung ist nach Campaign-Registrierung gesperrt; '
      + 'nur die einmalige versiegelte Evaluation ist zulässig',
    )
  }
}

/** Capture writers must call this while holding the global campaign lock. */
export function assertBrainCalibrationCampaignCaptureWriteAccess(vault: Vault): void {
  const state = trustedCampaignState(vault)
  if (state.phase === 'registered' || state.phase === 'closed') {
    throw new Error(
      'Kalibrierungs-Captures sind für die registrierte Kampagne eingefroren',
    )
  }
}

/** Temporal labels are mutable diagnostics and stay outside an active campaign. */
export function assertBrainCalibrationCampaignTemporalLabelWriteAccess(vault: Vault): void {
  const state = trustedCampaignState(vault)
  if (state.phase === 'registered' || state.phase === 'closed') {
    throw new Error(
      'still_valid-Labels sind während einer registrierten Kampagne eingefroren',
    )
  }
}

export interface BrainCalibrationCampaignResolvedReviewTarget {
  phase: Extract<BrainCalibrationCampaignPhase, 'registered' | 'closed' | 'evaluated'>
  observationId: string
  reviewToken: string
  reviewReference: string
  review: CalibrationReviewPayload
  captureIntegrity: string
  snapshot: BrainCalibrationTargetSnapshot
}

function resolvedReviewTarget(
  registration: BrainCalibrationCampaignRegistration,
  archive: BrainCalibrationCampaignReviewArchive,
  phase: BrainCalibrationCampaignResolvedReviewTarget['phase'],
): BrainCalibrationCampaignResolvedReviewTarget {
  const target = registration.frame.targets.find(
    candidate => candidate.observationId === archive.observationId,
  )
  if (!target) throw new Error('Review-Archiv ist nicht bijektiv zum Frame')
  const core = parseBrainCalibrationTargetSnapshot(JSON.parse(archive.snapshotPayload) as unknown)
  const snapshot = parseBrainCalibrationTargetSnapshot({
    ...core,
    sourcePath: target.sourcePath,
    sessionId: target.sessionId,
    projectGroupId: target.projectGroupId,
  })
  return {
    phase,
    observationId: archive.observationId,
    reviewToken: archive.reviewToken,
    reviewReference: archive.reviewReference,
    review: structuredClone(archive.review),
    captureIntegrity: archive.captureIntegrity,
    snapshot,
  }
}

export function resolveBrainCalibrationCampaignReviewTarget(
  vault: Vault,
  options: { reviewToken: string; reviewer: string },
): BrainCalibrationCampaignResolvedReviewTarget | null {
  const state = trustedCampaignState(vault)
  if (!state.registration) return null
  const reviewer = identifier(options.reviewer, 'reviewer', 64)
  if (!state.registration.reviewers.includes(reviewer)) {
    throw new Error('Reviewer ist für diese Kampagne nicht registriert')
  }
  if (typeof options.reviewToken !== 'string' || !REVIEW_TOKEN.test(options.reviewToken)) {
    throw new Error('reviewToken ist ungültig')
  }
  const archive = state.registration.reviewArchive.find(
    candidate => candidate.reviewToken === options.reviewToken,
  )
  if (!archive) throw new Error('reviewToken gehört nicht zum registrierten Campaign-Frame')
  return resolvedReviewTarget(
    state.registration,
    archive,
    state.phase as BrainCalibrationCampaignResolvedReviewTarget['phase'],
  )
}

export function listBrainCalibrationCampaignReviewTargets(
  vault: Vault,
  reviewer: string,
): BrainCalibrationCampaignResolvedReviewTarget[] {
  const state = trustedCampaignState(vault)
  if (!state.registration) return []
  const normalizedReviewer = identifier(reviewer, 'reviewer', 64)
  if (!state.registration.reviewers.includes(normalizedReviewer)) {
    throw new Error('Reviewer ist für diese Kampagne nicht registriert')
  }
  return state.registration.reviewArchive.map(archive =>
    resolvedReviewTarget(
      state.registration as BrainCalibrationCampaignRegistration,
      archive,
      state.phase as BrainCalibrationCampaignResolvedReviewTarget['phase'],
    ))
}

/** Explicitly named alias for integrations that consume the sealed review archive. */
export function listVerifiedBrainCalibrationCampaignReviewArchives(
  vault: Vault,
  reviewer: string,
): BrainCalibrationCampaignResolvedReviewTarget[] {
  return listBrainCalibrationCampaignReviewTargets(vault, reviewer)
}
