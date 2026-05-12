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
  hooks: {
    createDailyNote: boolean
    autoCapture: boolean
    appendDailyCaptureLink: boolean
    autoOrganize: boolean
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
  hooks: {
    createDailyNote: true,
    autoCapture: true,
    appendDailyCaptureLink: true,
    autoOrganize: false,
  },
  protectedPaths: ['.git/', '.obsidian/', '.trash/', 'System/', 'Templates/'],
  tools: {
    recall_context: { write: false, risk: 'low' },
    build_context_pack: { write: false, risk: 'low' },
    brain_review: { write: false, risk: 'low' },
    brain_apply_review_item: { write: true, risk: 'medium', requiresDryRunDefault: true },
    auto_capture: { write: true, risk: 'medium' },
    ingest_source: { write: true, risk: 'medium', requiresDryRunDefault: true },
    save_insight: { write: true, risk: 'low', requiresDryRunDefault: true },
    save_decision: { write: true, risk: 'low', requiresDryRunDefault: true },
    save_answer: { write: true, risk: 'low', requiresDryRunDefault: true },
    update_hot_cache: { write: true, risk: 'low', requiresDryRunDefault: true },
    read_hot_cache: { write: false, risk: 'low' },
    build_knowledge_index: { write: true, risk: 'low', requiresDryRunDefault: true },
    flag_knowledge_gap: { write: true, risk: 'low', requiresDryRunDefault: true },
    flag_contradiction: { write: true, risk: 'low', requiresDryRunDefault: true },
    list_open_questions: { write: false, risk: 'low' },
    resolve_gap: { write: true, risk: 'low', requiresDryRunDefault: true },
    create_research_plan: { write: true, risk: 'low', requiresDryRunDefault: true },
    create_daily_note: { write: true, risk: 'low' },
    daily_note: { write: true, risk: 'low' },
    organize_referenz: { write: true, risk: 'medium', requiresDryRunDefault: true },
    rename_note: { write: true, risk: 'high', requiresDryRunDefault: true },
    merge_duplicates: { write: true, risk: 'high', requiresDryRunDefault: true },
    triage_note: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_frontmatter: { write: true, risk: 'medium', requiresDryRunDefault: true },
    fix_broken_links: { write: true, risk: 'medium', requiresDryRunDefault: true },
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
    hooks: {
      ...DEFAULT_POLICY.hooks,
      ...(raw.hooks ?? {}),
      createDailyNote: asBoolean(raw.hooks?.createDailyNote, DEFAULT_POLICY.hooks.createDailyNote),
      autoCapture: asBoolean(raw.hooks?.autoCapture, DEFAULT_POLICY.hooks.autoCapture),
      appendDailyCaptureLink: asBoolean(raw.hooks?.appendDailyCaptureLink, DEFAULT_POLICY.hooks.appendDailyCaptureLink),
      autoOrganize: asBoolean(raw.hooks?.autoOrganize, DEFAULT_POLICY.hooks.autoOrganize),
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
