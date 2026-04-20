import { dirname } from 'node:path'
import type { Vault } from '../vault.ts'
import { tokenize, tokenizeContent, jaccard } from './text-utils.ts'

export interface DuplicateMatch {
  noteA: string
  noteB: string
  titleA: string
  titleB: string
  score: number
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  suggestion: 'merge' | 'review' | 'link'
}

export function findDuplicates(vault: Vault, minScore: number = 40): DuplicateMatch[] {
  const notes = [...vault.notes.entries()]
  const candidates: DuplicateMatch[] = []

  // Pre-compute tokens for each note (cache)
  const noteData = new Map<string, {
    titleTokens: Set<string>
    contentTokens: Set<string>
    tagSet: Set<string>
  }>()

  for (const [rel, entry] of notes) {
    noteData.set(rel, {
      titleTokens: tokenize(entry.title),
      contentTokens: tokenizeContent(entry.content),
      tagSet: new Set(entry.tags),
    })
  }

  // Compare every pair (O(n²) but fine for vault sizes < 1000)
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const [relA, entryA] = notes[i]
      const [relB, entryB] = notes[j]

      // Skip if either is a daily note (intentional file-per-day pattern)
      if (entryA.frontmatter?.tags?.includes('daily') || entryB.frontmatter?.tags?.includes('daily')) continue

      const dataA = noteData.get(relA)!
      const dataB = noteData.get(relB)!

      const reasons: string[] = []
      let score = 0

      // 1. Title similarity (Jaccard on word tokens, weighted high)
      const titleSim = jaccard(dataA.titleTokens, dataB.titleTokens)
      if (titleSim >= 0.35) {
        const contribution = Math.round(titleSim * 50)
        score += contribution
        reasons.push(`Titel ${Math.round(titleSim * 100)}% ähnlich`)
      }

      // 2. Substring title match (strong signal if one contains the other)
      const tA = entryA.title.toLowerCase().trim()
      const tB = entryB.title.toLowerCase().trim()
      if (tA.length > 10 && tB.length > 10) {
        if (tA.includes(tB) || tB.includes(tA)) {
          score += 25
          reasons.push('Titel enthält den anderen')
        }
      }

      // 3. Content overlap (Jaccard on words)
      const contentSim = jaccard(dataA.contentTokens, dataB.contentTokens)
      if (contentSim >= 0.3) {
        const contribution = Math.round(contentSim * 35)
        score += contribution
        reasons.push(`Inhalt ${Math.round(contentSim * 100)}% ähnlich`)
      }

      // 4. Tag overlap (shared tags)
      const sharedTags = [...dataA.tagSet].filter(t => dataB.tagSet.has(t))
      if (sharedTags.length >= 3) {
        score += sharedTags.length * 2
        reasons.push(`${sharedTags.length} gemeinsame Tags`)
      }

      // 5. Same folder bonus (potential same-topic duplicate)
      const folderA = dirname(relA)
      const folderB = dirname(relB)
      if (folderA === folderB && folderA !== '.') {
        score += 5
        reasons.push('gleicher Ordner')
      }

      if (score < minScore) continue

      // Determine confidence
      let confidence: 'high' | 'medium' | 'low'
      let suggestion: 'merge' | 'review' | 'link'
      if (score >= 80) {
        confidence = 'high'
        suggestion = 'merge'
      } else if (score >= 55) {
        confidence = 'medium'
        suggestion = 'review'
      } else {
        confidence = 'low'
        suggestion = 'link'
      }

      candidates.push({
        noteA: relA,
        noteB: relB,
        titleA: entryA.title,
        titleB: entryB.title,
        score,
        confidence,
        reasons,
        suggestion,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates
}
