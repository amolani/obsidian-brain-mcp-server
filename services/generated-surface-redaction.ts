import type { NoteEntry } from '../vault.ts'
import { redactSecrets } from './secret-redaction.ts'

const SENSITIVE_PATH_OR_TITLE = /\b(zugangsdaten|credentials?|passw(?:ort|örter|oerter)?|secret|secrets|token|tokens|kennwort|auth)\b/i

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

export function safeGeneratedSnippet(
  source: Pick<NoteEntry, 'relativePath' | 'title' | 'tags'> | { path: string; title: string; tags?: string[] },
  text: string,
): string {
  if (isSensitiveGeneratedSource(source)) {
    return '[REDACTED_SENSITIVE_NOTE_SNIPPET: Quelle ist als Zugangsdaten/Credential-Notiz erkannt]'
  }
  return redactGeneratedText(text)
}
