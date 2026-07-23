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
const DEFAULT_POLICY_PATH = join(PROJECT_ROOT, '..', 'brain-policy.json')

const REQUIRED_PROTECTED_PATHS = ['.git/', '.obsidian/', '.trash/', 'System/', 'Templates/']
const REQUIRED_NEVER_AUTO_APPLY = [
  'merge_duplicates',
  'rename_note',
  'organize_referenz',
  'fix_broken_links',
  'apply_link_suggestions',
  'resolve_gap',
]
const REQUIRED_DRY_RUN_TOOLS = [
  'brain_review_inbox_items',
  'repair_generated_surfaces',
  'promote_suggestion',
  'rename_note',
  'merge_duplicates',
  'organize_referenz',
  'fix_broken_links',
  'apply_link_suggestions',
  'resolve_gap',
]

export interface BrainPolicyDiagnostic {
  path: string
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function brainPolicyPath(): string {
  return process.env.BRAIN_POLICY_PATH || DEFAULT_POLICY_PATH
}

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
    get_note_context: { write: false, risk: 'low' },
    vault_overview: { write: false, risk: 'low' },
    semantic_index_status: { write: false, risk: 'low' },
    todo_list: { write: false, risk: 'low' },
    suggest_links: { write: false, risk: 'low' },
    suggest_links_v2: { write: false, risk: 'low' },
    weekly_review: { write: false, risk: 'low' },
    extract_troubleshooting_pattern: { write: false, risk: 'low' },
    find_duplicates: { write: false, risk: 'low' },
    find_broken_links: { write: false, risk: 'low' },
    list_suggestions: { write: false, risk: 'low' },
    score_note_quality: { write: false, risk: 'low' },
    list_low_quality_notes: { write: false, risk: 'low' },
    suggest_lifecycle_updates: { write: false, risk: 'low' },
    lint_frontmatter: { write: false, risk: 'low' },
    brain_review: { write: false, risk: 'low' },
    brain_apply_review_item: { write: true, risk: 'medium', requiresDryRunDefault: true },
    brain_auto_build: { write: true, risk: 'medium', requiresDryRunDefault: false },
    archive_auto_build_run: { write: true, risk: 'medium', requiresDryRunDefault: true },
    vault_search: { write: false, risk: 'low' },
    semantic_search: { write: false, risk: 'low' },
    create_note: { write: true, risk: 'medium', requiresDryRunDefault: false },
    capture: { write: true, risk: 'medium', requiresDryRunDefault: false },
    capture_v2: { write: true, risk: 'medium', requiresDryRunDefault: true },
    auto_capture: { write: true, risk: 'medium', requiresDryRunDefault: false },
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
    repair_generated_surfaces: { write: true, risk: 'low', requiresDryRunDefault: true },
    build_knowledge_inbox: { write: true, risk: 'low', requiresDryRunDefault: true },
    brain_apply_inbox_item: { write: true, risk: 'medium', requiresDryRunDefault: true },
    brain_review_inbox_items: { write: true, risk: 'low', requiresDryRunDefault: true },
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
    promote_suggestion: { write: true, risk: 'medium', requiresDryRunDefault: true },
    create_daily_note: { write: true, risk: 'low', requiresDryRunDefault: false },
    daily_note: { write: true, risk: 'low', requiresDryRunDefault: false },
    organize_referenz: { write: true, risk: 'medium', requiresDryRunDefault: true },
    rename_note: { write: true, risk: 'high', requiresDryRunDefault: true },
    merge_duplicates: { write: true, risk: 'high', requiresDryRunDefault: true },
    triage_note: { write: true, risk: 'medium', requiresDryRunDefault: true },
    triage_inbox: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_frontmatter: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_broken_links: { write: true, risk: 'medium', requiresDryRunDefault: true },
    apply_link_suggestions: { write: true, risk: 'medium', requiresDryRunDefault: true },
    apply_lifecycle_updates: { write: true, risk: 'medium', requiresDryRunDefault: true },
    apply_all_safe_fixes: { write: true, risk: 'medium', requiresDryRunDefault: true },
    run_safe_maintenance: { write: true, risk: 'medium', requiresDryRunDefault: true },
    generate_mocs: { write: true, risk: 'low', requiresDryRunDefault: true },
    generate_runbook: { write: true, risk: 'medium', requiresDryRunDefault: true },
    promote_capture_to_runbook: { write: true, risk: 'medium', requiresDryRunDefault: true },
    generate_postmortem: { write: true, risk: 'medium', requiresDryRunDefault: true },
    build_customer_context: { write: true, risk: 'medium', requiresDryRunDefault: true },
    build_project_dashboard: { write: true, risk: 'medium', requiresDryRunDefault: true },
    run_vault_maintenance: { write: true, risk: 'low', requiresDryRunDefault: false },
    accept_review_item: { write: true, risk: 'low', requiresDryRunDefault: true },
    reject_review_item: { write: true, risk: 'low', requiresDryRunDefault: true },
    snooze_review_item: { write: true, risk: 'low', requiresDryRunDefault: true },
    rebuild_semantic_index: { write: true, risk: 'low', requiresDryRunDefault: true },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireBooleanFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const field of fields) {
    if (typeof value[field] !== 'boolean') errors.push(`${label}.${field} muss boolean sein`)
  }
}

function requireFiniteNumber(
  value: Record<string, unknown>,
  field: string,
  label: string,
  min: number,
  max: number,
  errors: string[],
): void {
  const candidate = value[field]
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > max) {
    errors.push(`${label}.${field} muss eine endliche Zahl zwischen ${min} und ${max} sein`)
  }
}

function safeFallbackPolicy(): BrainPolicy {
  const fallback = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as BrainPolicy
  fallback.automation.mode = 'off'
  fallback.automation.afterSession = Object.fromEntries(
    Object.keys(fallback.automation.afterSession).map(key => [key, false]),
  ) as BrainPolicy['automation']['afterSession']
  fallback.automation.duringSession.allowManualAutoBuildTool = false
  fallback.automation.duringSession.autoCheckpoint = false
  fallback.automation.duringSession.runAutoBuildOnCheckpoint = false
  fallback.hooks.createDailyNote = false
  fallback.hooks.autoCapture = false
  fallback.hooks.appendDailyCaptureLink = false
  fallback.hooks.autoOrganize = false
  fallback.hooks.captureSafety.secretRedaction = true
  fallback.hooks.captureSafety.blockOnSecret = true
  return fallback
}

function validatePolicyValue(value: unknown, path: string): BrainPolicyDiagnostic {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(value)) {
    return { path, valid: false, errors: ['Top-Level muss ein JSON-Objekt sein'], warnings }
  }

  const workingMemory = value.workingMemory
  const automation = value.automation
  const hooks = value.hooks
  const protectedPaths = value.protectedPaths
  const tools = value.tools

  if (!isRecord(workingMemory)) {
    errors.push('workingMemory muss ein Objekt sein')
  } else {
    if (workingMemory.mode !== 'manual_only' && workingMemory.mode !== 'disabled') errors.push('workingMemory.mode muss manual_only oder disabled sein')
    if (workingMemory.allowAutomaticRecall !== false) errors.push('workingMemory.allowAutomaticRecall muss für V1 false sein')
  }

  if (!isRecord(automation)) {
    errors.push('automation muss ein Objekt sein')
  } else {
    if (!['auto_build', 'review_only', 'off'].includes(String(automation.mode))) errors.push('automation.mode ist ungültig')
    if (!isRecord(automation.afterSession)) {
      errors.push('automation.afterSession muss ein Objekt sein')
    } else {
      requireBooleanFields(automation.afterSession, Object.keys(DEFAULT_POLICY.automation.afterSession), 'automation.afterSession', errors)
    }
    if (!isRecord(automation.limits)) {
      errors.push('automation.limits muss ein Objekt sein')
    } else {
      requireFiniteNumber(automation.limits, 'maxNewNotesPerRun', 'automation.limits', 1, 50, errors)
      requireFiniteNumber(automation.limits, 'maxClaimsPerRun', 'automation.limits', 0, 50, errors)
      requireFiniteNumber(automation.limits, 'maxRuntimeMs', 'automation.limits', 1000, 60000, errors)
    }
    if (!isRecord(automation.duringSession)) {
      errors.push('automation.duringSession muss ein Objekt sein')
    } else {
      requireBooleanFields(
        automation.duringSession,
        ['allowManualAutoBuildTool', 'autoCheckpoint', 'runAutoBuildOnCheckpoint'],
        'automation.duringSession',
        errors,
      )
      requireFiniteNumber(automation.duringSession, 'minMinutesBetweenCheckpoints', 'automation.duringSession', 5, 240, errors)
      requireFiniteNumber(automation.duringSession, 'minCommandsBetweenCheckpoints', 'automation.duringSession', 3, 100, errors)
      requireFiniteNumber(automation.duringSession, 'maxCheckpointsPerSession', 'automation.duringSession', 1, 24, errors)
    }
    if (!Array.isArray(automation.neverAutoApply)) {
      errors.push('automation.neverAutoApply muss ein Array sein')
    } else {
      const blocked = automation.neverAutoApply.map(String)
      if (automation.neverAutoApply.some(value => typeof value !== 'string')) errors.push('automation.neverAutoApply darf nur Strings enthalten')
      for (const action of REQUIRED_NEVER_AUTO_APPLY) {
        if (!blocked.includes(action)) errors.push(`automation.neverAutoApply fehlt: ${action}`)
      }
    }
  }

  if (!isRecord(hooks)) {
    errors.push('hooks muss ein Objekt sein')
  } else {
    requireBooleanFields(hooks, ['createDailyNote', 'autoCapture', 'appendDailyCaptureLink', 'autoOrganize'], 'hooks', errors)
    if (hooks.autoOrganize !== false) errors.push('hooks.autoOrganize muss für V1 false sein; Ordner-Reorganisation ist nur manuell erlaubt')
    const captureSafety = hooks.captureSafety
    if (!isRecord(captureSafety)) {
      errors.push('hooks.captureSafety muss ein Objekt sein')
    } else {
      requireBooleanFields(captureSafety, ['secretRedaction', 'blockOnSecret'], 'hooks.captureSafety', errors)
      if (!Array.isArray(captureSafety.excludeCwdPatterns) || captureSafety.excludeCwdPatterns.some(value => typeof value !== 'string')) {
        errors.push('hooks.captureSafety.excludeCwdPatterns muss ein String-Array sein')
      }
      if (hooks.autoCapture === true && captureSafety.secretRedaction !== true) {
        errors.push('Secret-Redaction muss bei aktiviertem Auto-Capture eingeschaltet sein')
      }
    }
  }

  if (!Array.isArray(protectedPaths)) {
    errors.push('protectedPaths muss ein Array sein')
  } else {
    const configured = protectedPaths.map(String)
    if (protectedPaths.some(value => typeof value !== 'string')) errors.push('protectedPaths darf nur Strings enthalten')
    for (const required of REQUIRED_PROTECTED_PATHS) {
      if (!configured.includes(required)) errors.push(`protectedPaths fehlt: ${required}`)
    }
  }

  if (!isRecord(tools)) {
    errors.push('tools muss ein Objekt sein')
  } else {
    for (const [tool, config] of Object.entries(tools)) {
      if (!isRecord(config)) {
        errors.push(`Tool-Policy ${tool} muss ein Objekt sein`)
        continue
      }
      if (typeof config.write !== 'boolean') errors.push(`Tool-Policy ${tool}.write muss boolean sein`)
      if (!['low', 'medium', 'high'].includes(String(config.risk))) errors.push(`Tool-Policy ${tool}.risk ist ungültig`)
      if (config.requiresDryRunDefault !== undefined && typeof config.requiresDryRunDefault !== 'boolean') {
        errors.push(`Tool-Policy ${tool}.requiresDryRunDefault muss boolean sein`)
      }
    }
    for (const [tool, defaults] of Object.entries(DEFAULT_POLICY.tools)) {
      if (!Object.hasOwn(tools, tool)) {
        errors.push(`Tool-Policy fehlt: ${tool}`)
        continue
      }
      const configured = tools[tool]
      if (defaults.requiresDryRunDefault === true && isRecord(configured) && configured.requiresDryRunDefault !== true) {
        errors.push(`${tool}.requiresDryRunDefault muss true bleiben`)
      }
    }
    for (const tool of REQUIRED_DRY_RUN_TOOLS) {
      const config = tools[tool]
      if (!isRecord(config)) {
        errors.push(`Tool-Policy fehlt: ${tool}`)
      } else if (config.requiresDryRunDefault !== true) {
        errors.push(`${tool} muss dry-run-first konfiguriert sein`)
      }
    }
  }

  return { path, valid: errors.length === 0, errors, warnings }
}

export function diagnoseBrainPolicy(): BrainPolicyDiagnostic {
  const path = brainPolicyPath()
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return validatePolicyValue(value, path)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { path, valid: false, errors: [`nicht lesbar oder ungültiges JSON: ${message}`], warnings: [] }
  }
}

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
  const path = brainPolicyPath()
  try {
    const diagnostic = diagnoseBrainPolicy()
    if (!diagnostic.valid || !existsSync(path)) {
      return safeFallbackPolicy()
    }
    return mergePolicy(JSON.parse(readFileSync(path, 'utf-8')) as Partial<BrainPolicy>)
  } catch {
    return safeFallbackPolicy()
  }
}

export function reloadBrainPolicy(): BrainPolicy {
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
  const diagnostic = diagnoseBrainPolicy()
  if (!diagnostic.valid) {
    return {
      allowed: false,
      reason: `Brain-Policy ungültig; Schreibzugriff fail-closed blockiert: ${diagnostic.errors.join('; ')}`,
      risk: toolPolicy?.risk ?? 'high',
    }
  }
  if (!toolPolicy) {
    return {
      allowed: false,
      reason: `Keine Tool-Policy für ${tool}; Schreibzugriff fail-closed blockiert`,
      risk: 'high',
    }
  }
  if (toolPolicy && !toolPolicy.write) {
    return { allowed: false, reason: `${tool} ist laut Policy read-only`, risk: toolPolicy.risk }
  }
  const risk = toolPolicy.risk
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
