import type { NoteEntry } from '../vault.ts'
import { redactSecrets } from './secret-redaction.ts'

const SENSITIVE_PATH_OR_TITLE = /\b(zugangsdaten|credentials?|passw(?:ort|örter|oerter)?|secret|secrets|token|tokens|kennwort|auth)\b/i
const SENSITIVE_FILE_PROBE = /\b(\.env|auth-user-pass|id_rsa|credentials?|secrets?|tokens?|passw(?:ort|örter|oerter)?)\b/i
const SHELL_COMMAND_SNIPPET = /`[^`]*(?:&&|;|\||\b(?:cat|grep|find|openssl|ssh|docker|systemctl|kubectl|nmap|curl|sed|awk|tail|head)\b)[^`]*`/i

export function isSensitiveGeneratedSource(source: Pick<NoteEntry, 'relativePath' | 'title' | 'tags'> | { path: string; title: string; tags?: string[] }): boolean {
  const path = 'relativePath' in source ? source.relativePath : source.path
  const tags = source.tags ?? []
  return SENSITIVE_PATH_OR_TITLE.test(path)
    || SENSITIVE_PATH_OR_TITLE.test(source.title)
    || tags.some(tag => SENSITIVE_PATH_OR_TITLE.test(tag))
}

export function redactGeneratedText(text: string): string {
  return redactSecrets(text).content
}

export function isUnsafeGeneratedSnippet(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/<task-notification|toolu_/i.test(trimmed)) return true
  if (SENSITIVE_FILE_PROBE.test(trimmed) && /`|\b(cat|grep|find|sed|awk|tail|head|less)\b/i.test(trimmed)) return true
  return trimmed.length > 140 && SHELL_COMMAND_SNIPPET.test(trimmed)
}

export function safeGeneratedSnippet(
  source: Pick<NoteEntry, 'relativePath' | 'title' | 'tags'> | { path: string; title: string; tags?: string[] },
  text: string,
): string {
  if (isSensitiveGeneratedSource(source)) {
    return '[REDACTED_SENSITIVE_NOTE_SNIPPET: Quelle ist als Zugangsdaten/Credential-Notiz erkannt]'
  }
  if (isUnsafeGeneratedSnippet(text)) {
    return '[REDACTED_COMMAND_SNIPPET: Rohbefehl/Datei-Probe wird in generierten Surfaces nicht ausgeschrieben]'
  }
  return redactGeneratedText(text)
}
