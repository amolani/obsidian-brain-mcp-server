import type { Vault } from '../vault.ts'
import { assertGeneratedSurfaceOwnership, isRecognizedLegacyGeneratedSurface } from './generated-surface-ownership.ts'
import { assertCanWriteTool } from './policy.ts'

export interface RepairGeneratedSurfacesOptions {
  dryRun?: boolean
  /** Explicitly adopt only narrowly recognized pre-marker Brain outputs. */
  adoptLegacy?: boolean
}

export interface GeneratedSurfaceRepairItem {
  id: string
  path: string
  result: unknown
}

export interface RepairGeneratedSurfacesResult {
  dryRun: boolean
  adoptLegacy: boolean
  recognizedLegacy: string[]
  repaired: number
  surfaces: GeneratedSurfaceRepairItem[]
}

const FIXED_SURFACES = [
  ['brain_dashboard', 'Knowledge/_brain.md', 'brain-dashboard', 'build_brain_dashboard'],
  ['capture_review', 'Maintenance/Capture Review.md', 'capture-review', 'build_capture_review'],
  ['evidence_dashboard', 'Knowledge/evidence.md', 'evidence-dashboard', 'build_evidence_dashboard'],
  ['knowledge_inbox', 'Maintenance/Knowledge Inbox.md', 'knowledge-inbox', 'build_knowledge_inbox'],
  ['knowledge_index', 'Knowledge/index.md', 'knowledge-index', 'build_knowledge_index'],
  ['hot_cache', 'Knowledge/hot.md', 'hot-cache', 'update_hot_cache'],
  ['change_ledger', 'Maintenance/Change Ledger.md', 'change-ledger', 'build_change_ledger'],
] as const

/**
 * Rebuilds the core fixed Markdown surfaces. Apply mode preflights every target
 * before the first builder runs, so a foreign/user-owned file cannot cause a
 * partially repaired set.
 */
export function repairGeneratedSurfaces(
  vault: Vault,
  options: RepairGeneratedSurfacesOptions = {},
): RepairGeneratedSurfacesResult {
  const dryRun = options.dryRun ?? true
  const adoptLegacy = options.adoptLegacy === true
  const recognizedLegacy = FIXED_SURFACES
    .filter(([, path, owner]) => isRecognizedLegacyGeneratedSurface(vault.vaultPath, path, owner))
    .map(([, path]) => path)
  if (!dryRun) {
    const paths = FIXED_SURFACES.map(([, path]) => path)
    assertCanWriteTool('repair_generated_surfaces', paths)
    for (const [, path, owner, tool] of FIXED_SURFACES) {
      assertCanWriteTool(tool, [path])
      assertGeneratedSurfaceOwnership(vault.vaultPath, path, owner, {
        allowRecognizedLegacy: adoptLegacy,
      })
    }
  }

  const surfaces: GeneratedSurfaceRepairItem[] = []
  const add = (id: string, result: { path: string }) => surfaces.push({ id, path: result.path, result })
  add('brain_dashboard', vault.buildBrainDashboard({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  add('capture_review', vault.buildCaptureReview({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  add('evidence_dashboard', vault.buildEvidenceDashboard({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  add('knowledge_inbox', vault.buildKnowledgeInbox({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  add('knowledge_index', vault.buildKnowledgeIndex({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  add('hot_cache', vault.updateHotCache({ dryRun, adoptLegacyOwnership: adoptLegacy }))
  // Keep the ledger last so its content includes writes made by this repair.
  add('change_ledger', vault.buildChangeLedger({ dryRun, adoptLegacyOwnership: adoptLegacy }))

  return {
    dryRun,
    adoptLegacy,
    recognizedLegacy,
    repaired: dryRun ? 0 : surfaces.length,
    surfaces,
  }
}
