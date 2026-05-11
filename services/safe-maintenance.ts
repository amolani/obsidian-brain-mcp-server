import type { Vault } from '../vault.ts'

export type SafeMaintenanceStep =
  | 'frontmatter'
  | 'broken_links'
  | 'link_suggestions'
  | 'lifecycle'
  | 'mocs'
  | 'semantic_index'

export interface RunSafeMaintenanceOptions {
  dryRun?: boolean
  steps?: SafeMaintenanceStep[]
  minLinkConfidence?: number
  minLifecycleConfidence?: 'high' | 'medium' | 'low'
  mocMinNotes?: number
}

export interface SafeMaintenanceStepResult {
  step: SafeMaintenanceStep
  changed: number
  skipped: number
  summary: string
}

export interface RunSafeMaintenanceResult {
  dryRun: boolean
  steps: SafeMaintenanceStepResult[]
  totalChanged: number
  totalSkipped: number
}

const DEFAULT_STEPS: SafeMaintenanceStep[] = [
  'frontmatter',
  'broken_links',
  'link_suggestions',
  'lifecycle',
  'mocs',
  'semantic_index',
]

export function runSafeMaintenance(vault: Vault, options: RunSafeMaintenanceOptions = {}): RunSafeMaintenanceResult {
  const dryRun = options.dryRun ?? true
  const requestedSteps = options.steps?.length ? options.steps : DEFAULT_STEPS
  const steps: SafeMaintenanceStepResult[] = []

  for (const step of requestedSteps) {
    switch (step) {
      case 'frontmatter': {
        const result = vault.fixFrontmatter(dryRun)
        const changes = result.fixed.reduce((sum, item) => sum + item.changes.length, 0)
        steps.push({
          step,
          changed: changes,
          skipped: result.skipped.length,
          summary: `${result.fixed.length} Note(s), ${changes} Frontmatter-Änderung(en)`,
        })
        break
      }

      case 'broken_links': {
        const result = vault.fixBrokenLinks(dryRun)
        steps.push({
          step,
          changed: result.fixed.length,
          skipped: result.skipped.length,
          summary: `${result.fixed.length} kaputte Link(s) reparierbar`,
        })
        break
      }

      case 'link_suggestions': {
        const result = vault.applyLinkSuggestions({
          dryRun,
          minConfidence: options.minLinkConfidence ?? 0.9,
        })
        steps.push({
          step,
          changed: result.linked.length,
          skipped: result.skipped.length,
          summary: `${result.linked.length} Link-Vorschlag/Vorschläge anwendbar`,
        })
        break
      }

      case 'lifecycle': {
        const result = vault.applyLifecycleUpdates({
          dryRun,
          minConfidence: options.minLifecycleConfidence ?? 'high',
        })
        steps.push({
          step,
          changed: result.updated.length,
          skipped: result.skipped.length,
          summary: `${result.updated.length} Lifecycle-Status-Update(s)`,
        })
        break
      }

      case 'mocs': {
        const result = vault.generateMocs(dryRun, options.mocMinNotes ?? 2)
        const written = result.filter(r => r.action === 'created' || r.action === 'updated')
        const skipped = result.filter(r => r.action === 'skipped')
        steps.push({
          step,
          changed: written.length,
          skipped: skipped.length,
          summary: `${written.length} MOC(s) erstell-/aktualisierbar`,
        })
        break
      }

      case 'semantic_index': {
        const result = vault.rebuildSemanticIndex({ dryRun })
        steps.push({
          step,
          changed: result.indexedNotes,
          skipped: 0,
          summary: `${result.indexedNotes}/${result.totalNotes} Semantic-Index-Einträge`,
        })
        break
      }
    }
  }

  return {
    dryRun,
    steps,
    totalChanged: steps.reduce((sum, step) => sum + step.changed, 0),
    totalSkipped: steps.reduce((sum, step) => sum + step.skipped, 0),
  }
}
