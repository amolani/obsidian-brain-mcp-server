import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeRelativePath } from './vault-paths.ts'

export type PolicyRisk = 'low' | 'medium' | 'high'
export type WorkingMemoryMode = 'manual_only' | 'disabled'

export interface ToolPolicy {
  write: boolean
  risk: PolicyRisk
  requiresDryRunDefault?: boolean
}

export interface BrainPolicy {
  workingMemory: {
    mode: WorkingMemoryMode
    allowAutomaticRecall: boolean
  }
  automation: {
    mode: 'auto_build' | 'review_only' | 'off'
    afterSession: {
      promoteCaptures: boolean
      extractClaims: boolean
      updateEvidence: boolean
      buildDashboard: boolean
      buildKnowledgeIndex: boolean
      updateHotCache: boolean
      buildCustomerTimeline: boolean
      buildCustomerSnapshot: boolean
      buildKnowledgeInbox: boolean
      promoteRunbooks: boolean
    }
    limits: {
      maxNewNotesPerRun: number
      maxClaimsPerRun: number
      maxRuntimeMs: number
    }
    duringSession: {
      allowManualAutoBuildTool: boolean
      autoCheckpoint: boolean
      runAutoBuildOnCheckpoint: boolean
      minMinutesBetweenCheckpoints: number
      minCommandsBetweenCheckpoints: number
      maxCheckpointsPerSession: number
    }
    neverAutoApply: string[]
  }
  hooks: {
    createDailyNote: boolean
    autoCapture: boolean
    appendDailyCaptureLink: boolean
    autoOrganize: boolean
    captureSafety: {
      secretRedaction: boolean
      blockOnSecret: boolean
      excludeCwdPatterns: string[]
    }
  }
  protectedPaths: string[]
  tools: Record<string, ToolPolicy>
}

export interface WritePolicyCheck {
  allowed: boolean
  reason?: string
  risk: PolicyRisk
}

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const POLICY_PATH = join(PROJECT_ROOT, '..', 'brain-policy.json')

const DEFAULT_POLICY: BrainPolicy = {
  workingMemory: {
    mode: 'manual_only',
    allowAutomaticRecall: false,
  },
  automation: {
    mode: 'auto_build',
    afterSession: {
      promoteCaptures: true,
      extractClaims: true,
      updateEvidence: true,
      buildDashboard: true,
      buildKnowledgeIndex: true,
      updateHotCache: true,
      buildCustomerTimeline: true,
      buildCustomerSnapshot: true,
      buildKnowledgeInbox: true,
      promoteRunbooks: true,
    },
    limits: {
      maxNewNotesPerRun: 12,
      maxClaimsPerRun: 6,
      maxRuntimeMs: 10000,
    },
    duringSession: {
      allowManualAutoBuildTool: true,
      autoCheckpoint: true,
      runAutoBuildOnCheckpoint: true,
      minMinutesBetweenCheckpoints: 30,
      minCommandsBetweenCheckpoints: 12,
      maxCheckpointsPerSession: 6,
    },
    neverAutoApply: [
      'merge_duplicates',
      'rename_note',
      'organize_referenz',
      'fix_broken_links',
      'apply_link_suggestions',
      'resolve_gap',
    ],
  },
  hooks: {
    createDailyNote: true,
    autoCapture: true,
    appendDailyCaptureLink: true,
    autoOrganize: false,
    captureSafety: {
      secretRedaction: true,
      blockOnSecret: false,
      excludeCwdPatterns: [],
    },
  },
  protectedPaths: ['.git/', '.obsidian/', '.trash/', 'System/', 'Templates/'],
  tools: {
    recall_context: { write: false, risk: 'low' },
    build_context_pack: { write: false, risk: 'low' },
    brain_review: { write: false, risk: 'low' },
    brain_apply_review_item: { write: true, risk: 'medium', requiresDryRunDefault: true },
    brain_auto_build: { write: true, risk: 'medium', requiresDryRunDefault: false },
    archive_auto_build_run: { write: true, risk: 'medium', requiresDryRunDefault: true },
    auto_capture: { write: true, risk: 'medium' },
    ingest_source: { write: true, risk: 'medium', requiresDryRunDefault: true },
    save_insight: { write: true, risk: 'low', requiresDryRunDefault: true },
    save_decision: { write: true, risk: 'low', requiresDryRunDefault: true },
    save_answer: { write: true, risk: 'low', requiresDryRunDefault: true },
    update_evidence: { write: true, risk: 'low', requiresDryRunDefault: true },
    evidence_report: { write: false, risk: 'low' },
    extract_claims: { write: true, risk: 'medium', requiresDryRunDefault: true },
    update_hot_cache: { write: true, risk: 'low', requiresDryRunDefault: true },
    read_hot_cache: { write: false, risk: 'low' },
    build_knowledge_index: { write: true, risk: 'low', requiresDryRunDefault: true },
    flag_knowledge_gap: { write: true, risk: 'low', requiresDryRunDefault: true },
    flag_contradiction: { write: true, risk: 'low', requiresDryRunDefault: true },
    list_open_questions: { write: false, risk: 'low' },
    resolve_gap: { write: true, risk: 'low', requiresDryRunDefault: true },
    create_research_plan: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_brain_dashboard: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_capture_review: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_evidence_dashboard: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_session_impact_report: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_knowledge_inbox: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_apply_inbox_item: { write: true, risk: 'medium', requiresDryRunDefault: true },
    migrate_brain_metadata: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_change_ledger: { write: true, risk: 'low', requiresDryRunDefault: true },
    record_brain_feedback: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_feedback_summary: { write: false, risk: 'low' },
    build_memory_timeline: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_schedule: { write: false, risk: 'low' },
    build_customer_snapshot: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_metrics: { write: false, risk: 'low' },
    brain_health_check: { write: false, risk: 'low' },
    brain_run_background: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_checkpoint: { write: true, risk: 'low', requiresDryRunDefault: true },
    create_daily_note: { write: true, risk: 'low' },
    daily_note: { write: true, risk: 'low' },
    organize_referenz: { write: true, risk: 'medium', requiresDryRunDefault: true },
    rename_note: { write: true, risk: 'high', requiresDryRunDefault: true },
    merge_duplicates: { write: true, risk: 'high', requiresDryRunDefault: true },
    triage_note: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_frontmatter: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_broken_links: { write: true, risk: 'medium', requiresDryRunDefault: true },
    generate_runbook: { write: true, risk: 'medium', requiresDryRunDefault: true },
  },
}

let cachedPolicy: BrainPolicy | null = null

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function mergePolicy(raw: Partial<BrainPolicy>): BrainPolicy {
  return {
    workingMemory: {
      ...DEFAULT_POLICY.workingMemory,
      ...(raw.workingMemory ?? {}),
      mode: raw.workingMemory?.mode === 'disabled' ? 'disabled' : 'manual_only',
      allowAutomaticRecall: asBoolean(raw.workingMemory?.allowAutomaticRecall, DEFAULT_POLICY.workingMemory.allowAutomaticRecall),
    },
    automation: {
      ...DEFAULT_POLICY.automation,
      ...(raw.automation ?? {}),
      mode: ['auto_build', 'review_only', 'off'].includes(String(raw.automation?.mode))
        ? raw.automation!.mode as BrainPolicy['automation']['mode']
        : DEFAULT_POLICY.automation.mode,
      afterSession: {
        ...DEFAULT_POLICY.automation.afterSession,
        ...(raw.automation?.afterSession ?? {}),
        promoteCaptures: asBoolean(raw.automation?.afterSession?.promoteCaptures, DEFAULT_POLICY.automation.afterSession.promoteCaptures),
        extractClaims: asBoolean(raw.automation?.afterSession?.extractClaims, DEFAULT_POLICY.automation.afterSession.extractClaims),
        updateEvidence: asBoolean(raw.automation?.afterSession?.updateEvidence, DEFAULT_POLICY.automation.afterSession.updateEvidence),
        buildDashboard: asBoolean(raw.automation?.afterSession?.buildDashboard, DEFAULT_POLICY.automation.afterSession.buildDashboard),
        buildKnowledgeIndex: asBoolean(raw.automation?.afterSession?.buildKnowledgeIndex, DEFAULT_POLICY.automation.afterSession.buildKnowledgeIndex),
        updateHotCache: asBoolean(raw.automation?.afterSession?.updateHotCache, DEFAULT_POLICY.automation.afterSession.updateHotCache),
        buildCustomerTimeline: asBoolean(raw.automation?.afterSession?.buildCustomerTimeline, DEFAULT_POLICY.automation.afterSession.buildCustomerTimeline),
        buildCustomerSnapshot: asBoolean(raw.automation?.afterSession?.buildCustomerSnapshot, DEFAULT_POLICY.automation.afterSession.buildCustomerSnapshot),
        buildKnowledgeInbox: asBoolean(raw.automation?.afterSession?.buildKnowledgeInbox, DEFAULT_POLICY.automation.afterSession.buildKnowledgeInbox),
        promoteRunbooks: asBoolean(raw.automation?.afterSession?.promoteRunbooks, DEFAULT_POLICY.automation.afterSession.promoteRunbooks),
      },
      limits: {
        ...DEFAULT_POLICY.automation.limits,
        ...(raw.automation?.limits ?? {}),
        maxNewNotesPerRun: typeof raw.automation?.limits?.maxNewNotesPerRun === 'number'
          ? Math.max(1, Math.min(raw.automation.limits.maxNewNotesPerRun, 50))
          : DEFAULT_POLICY.automation.limits.maxNewNotesPerRun,
        maxClaimsPerRun: typeof raw.automation?.limits?.maxClaimsPerRun === 'number'
          ? Math.max(0, Math.min(raw.automation.limits.maxClaimsPerRun, 50))
          : DEFAULT_POLICY.automation.limits.maxClaimsPerRun,
        maxRuntimeMs: typeof raw.automation?.limits?.maxRuntimeMs === 'number'
          ? Math.max(1000, Math.min(raw.automation.limits.maxRuntimeMs, 60000))
          : DEFAULT_POLICY.automation.limits.maxRuntimeMs,
      },
      duringSession: {
        ...DEFAULT_POLICY.automation.duringSession,
        ...(raw.automation?.duringSession ?? {}),
        allowManualAutoBuildTool: asBoolean(raw.automation?.duringSession?.allowManualAutoBuildTool, DEFAULT_POLICY.automation.duringSession.allowManualAutoBuildTool),
        autoCheckpoint: asBoolean(raw.automation?.duringSession?.autoCheckpoint, DEFAULT_POLICY.automation.duringSession.autoCheckpoint),
        runAutoBuildOnCheckpoint: asBoolean(raw.automation?.duringSession?.runAutoBuildOnCheckpoint, DEFAULT_POLICY.automation.duringSession.runAutoBuildOnCheckpoint),
        minMinutesBetweenCheckpoints: typeof raw.automation?.duringSession?.minMinutesBetweenCheckpoints === 'number'
          ? Math.max(5, Math.min(raw.automation.duringSession.minMinutesBetweenCheckpoints, 240))
          : DEFAULT_POLICY.automation.duringSession.minMinutesBetweenCheckpoints,
        minCommandsBetweenCheckpoints: typeof raw.automation?.duringSession?.minCommandsBetweenCheckpoints === 'number'
          ? Math.max(3, Math.min(raw.automation.duringSession.minCommandsBetweenCheckpoints, 100))
          : DEFAULT_POLICY.automation.duringSession.minCommandsBetweenCheckpoints,
        maxCheckpointsPerSession: typeof raw.automation?.duringSession?.maxCheckpointsPerSession === 'number'
          ? Math.max(1, Math.min(raw.automation.duringSession.maxCheckpointsPerSession, 24))
          : DEFAULT_POLICY.automation.duringSession.maxCheckpointsPerSession,
      },
      neverAutoApply: Array.isArray(raw.automation?.neverAutoApply)
        ? raw.automation!.neverAutoApply.map(String)
        : DEFAULT_POLICY.automation.neverAutoApply,
    },
    hooks: {
      ...DEFAULT_POLICY.hooks,
      ...(raw.hooks ?? {}),
      createDailyNote: asBoolean(raw.hooks?.createDailyNote, DEFAULT_POLICY.hooks.createDailyNote),
      autoCapture: asBoolean(raw.hooks?.autoCapture, DEFAULT_POLICY.hooks.autoCapture),
      appendDailyCaptureLink: asBoolean(raw.hooks?.appendDailyCaptureLink, DEFAULT_POLICY.hooks.appendDailyCaptureLink),
      autoOrganize: asBoolean(raw.hooks?.autoOrganize, DEFAULT_POLICY.hooks.autoOrganize),
      captureSafety: {
        ...DEFAULT_POLICY.hooks.captureSafety,
        ...(raw.hooks?.captureSafety ?? {}),
        secretRedaction: asBoolean(raw.hooks?.captureSafety?.secretRedaction, DEFAULT_POLICY.hooks.captureSafety.secretRedaction),
        blockOnSecret: asBoolean(raw.hooks?.captureSafety?.blockOnSecret, DEFAULT_POLICY.hooks.captureSafety.blockOnSecret),
        excludeCwdPatterns: Array.isArray(raw.hooks?.captureSafety?.excludeCwdPatterns)
          ? raw.hooks!.captureSafety!.excludeCwdPatterns.map(String)
          : DEFAULT_POLICY.hooks.captureSafety.excludeCwdPatterns,
      },
    },
    protectedPaths: Array.isArray(raw.protectedPaths) ? raw.protectedPaths.map(String) : DEFAULT_POLICY.protectedPaths,
    tools: {
      ...DEFAULT_POLICY.tools,
      ...(raw.tools ?? {}),
    },
  }
}

export function loadBrainPolicy(): BrainPolicy {
  if (cachedPolicy) return cachedPolicy
  try {
    if (!existsSync(POLICY_PATH)) {
      cachedPolicy = DEFAULT_POLICY
      return cachedPolicy
    }
    cachedPolicy = mergePolicy(JSON.parse(readFileSync(POLICY_PATH, 'utf-8')) as Partial<BrainPolicy>)
  } catch {
    cachedPolicy = DEFAULT_POLICY
  }
  return cachedPolicy
}

export function reloadBrainPolicy(): BrainPolicy {
  cachedPolicy = null
  return loadBrainPolicy()
}

export function isAutomaticRecallAllowed(): boolean {
  const policy = loadBrainPolicy()
  return policy.workingMemory.mode !== 'manual_only' && policy.workingMemory.allowAutomaticRecall
}

export function isProtectedPath(relativePath: string, policy: BrainPolicy = loadBrainPolicy()): boolean {
  const safe = normalize(assertSafeRelativePath(relativePath)).replace(/\\/g, '/')
  return policy.protectedPaths.some(prefix => {
    const clean = normalize(prefix).replace(/\\/g, '/').replace(/^\/+/, '')
    return clean.endsWith('/') ? safe.startsWith(clean) : safe === clean || safe.startsWith(`${clean}/`)
  })
}

export function canWriteTool(tool: string, targets: string[] = [], policy: BrainPolicy = loadBrainPolicy()): WritePolicyCheck {
  const toolPolicy = policy.tools[tool]
  if (toolPolicy && !toolPolicy.write) {
    return { allowed: false, reason: `${tool} ist laut Policy read-only`, risk: toolPolicy.risk }
  }
  const risk = toolPolicy?.risk ?? 'high'
  for (const target of targets) {
    if (isProtectedPath(target, policy)) {
      return { allowed: false, reason: `Geschützter Pfad laut Policy: ${target}`, risk }
    }
  }
  if (toolPolicy && toolPolicy.write === false) {
    return { allowed: false, reason: `${tool} darf laut Policy nicht schreiben`, risk }
  }
  return { allowed: true, risk }
}

export function assertCanWriteTool(tool: string, targets: string[] = []): void {
  const result = canWriteTool(tool, targets)
  if (!result.allowed) throw new Error(result.reason ?? `Write blockiert: ${tool}`)
}
