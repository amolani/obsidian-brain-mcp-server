import type { Vault } from '../vault.ts'

export interface ToolCallRequest {
  params: {
    name: string
    arguments?: Record<string, unknown>
  }
}

export type ToolArgs = Record<string, unknown>
export type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}
export type ToolHandler = (vault: Vault, args: ToolArgs, req: ToolCallRequest) => ToolResult
export type ToolHandlerRegistry = Record<string, ToolHandler>

export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

export function confidence(value: unknown): 'high' | 'medium' | 'low' | undefined {
  return ['high', 'medium', 'low'].includes(String(value))
    ? value as 'high' | 'medium' | 'low'
    : undefined
}
