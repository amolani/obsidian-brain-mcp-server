import type { Vault } from './vault.ts'
import { knowledgeHandlers } from './tool-handlers/knowledge.ts'
import { linkHandlers } from './tool-handlers/links.ts'
import { maintenanceHandlers } from './tool-handlers/maintenance.ts'
import { overviewHandlers } from './tool-handlers/overview.ts'
import { searchHandlers } from './tool-handlers/search.ts'
import type { ToolCallRequest, ToolHandlerRegistry } from './tool-handlers/types.ts'

const TOOL_HANDLERS: ToolHandlerRegistry = {
  ...searchHandlers,
  ...knowledgeHandlers,
  ...overviewHandlers,
  ...linkHandlers,
  ...maintenanceHandlers,
}

/** Stable, read-only registry view used by release-contract tests. */
export const TOOL_HANDLER_NAMES = Object.freeze(Object.keys(TOOL_HANDLERS).sort())

export function createToolHandler(vault: Vault) {
  return async (req: ToolCallRequest) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const handler = TOOL_HANDLERS[req.params.name]

    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unbekanntes Tool: ${req.params.name}` }],
        isError: true,
      }
    }

    try {
      return handler(vault, args, req)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${req.params.name} fehlgeschlagen: ${msg}` }],
        isError: true,
      }
    }
  }
}
