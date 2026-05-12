import { readFileSync, readdirSync, statSync, watch, unlinkSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { findDuplicates as findDuplicatesService, type DuplicateMatch } from './services/duplicate-analyzer.ts'
import { findBrokenLinks as findBrokenLinksService, fixBrokenLinks as fixBrokenLinksService, type BrokenLink } from './services/broken-link-analyzer.ts'
import { lintFrontmatter as lintFrontmatterService, fixFrontmatter as fixFrontmatterService, type FrontmatterFixOptions, type FrontmatterLintOptions, type FrontmatterProfile, type LintIssue } from './services/frontmatter-linter.ts'
import { generateMocs as generateMocsService, type MocResult } from './services/moc-generator.ts'
import { runMaintenance as runMaintenanceService, type MaintenanceReport } from './services/review-queue-builder.ts'
import { captureV2 as captureV2Service, type CaptureMode, type CaptureV2Options, type CaptureV2Result } from './services/capture-service.ts'
import { scoreNoteQuality as scoreNoteQualityService, listLowQualityNotes as listLowQualityNotesService, type NoteQualityScore } from './services/note-quality.ts'
import { applyLinkSuggestions as applyLinkSuggestionsService, suggestLinksV2 as suggestLinksV2Service, type ApplyLinkSuggestionsOptions, type ApplyLinkSuggestionsResult, type LinkSuggestionV2, type LinkSuggestionOptions } from './services/link-suggester.ts'
import { buildCustomerDashboard as buildCustomerDashboardService, type CustomerDashboardOptions, type CustomerDashboardResult } from './services/customer-dashboard.ts'
import { mergeDuplicates as mergeDuplicatesService, type MergeDuplicatesOptions, type MergeDuplicatesResult } from './services/duplicate-merger.ts'
import { suggestLifecycleUpdates as suggestLifecycleUpdatesService, applyLifecycleUpdates as applyLifecycleUpdatesService, type LifecycleAnalyzeOptions, type LifecycleApplyOptions, type LifecycleApplyResult, type LifecycleSuggestion } from './services/lifecycle-manager.ts'
import { semanticSearch as semanticSearchService, semanticIndexStatus as semanticIndexStatusService, rebuildSemanticIndex as rebuildSemanticIndexService, type RebuildSemanticIndexOptions, type RebuildSemanticIndexResult, type SemanticIndexStatus, type SemanticSearchOptions, type SemanticSearchResult } from './services/semantic-search.ts'
import { buildContextPack as buildContextPackService, type ContextPack, type ContextPackOptions } from './services/context-pack.ts'
import { runSafeMaintenance as runSafeMaintenanceService, type RunSafeMaintenanceOptions, type RunSafeMaintenanceResult, type SafeMaintenanceStep } from './services/safe-maintenance.ts'
import { parseNoteEntry } from './services/note-parser.ts'
import { buildLinkIndexForNotes, removeNoteFromLinkIndex, resolveLinkInNotes } from './services/link-index.ts'
import { searchNotes, type SearchParams, type SearchResult } from './services/vault-search.ts'
import { createNote as createNoteService, type CreateNoteOptions, type CreateNoteResult } from './services/note-creator.ts'
import { buildVaultOverview, type VaultStats } from './services/vault-overview.ts'
import { buildNoteContext, type NoteContext } from './services/note-context.ts'
import { buildTodoList, type TodoItem } from './services/todo-list.ts'
import { buildWeeklyReview, type WeeklyReview } from './services/weekly-review.ts'
import { suggestLegacyLinks, type LegacyLinkSuggestion } from './services/legacy-link-suggester.ts'
import { dailyNote as dailyNoteService, type DailyNoteResult } from './services/daily-note.ts'
import { generateRunbook as generateRunbookService, type GenerateRunbookResult } from './services/runbook-generator.ts'
import { organizeReferenz as organizeReferenzService, type OrganizeReferenzResult } from './services/referenz-organizer.ts'
import { renameNote as renameNoteService, type RenameNoteOptions, type RenameNoteResult } from './services/note-renamer.ts'
import { triageInbox as triageInboxService, triageNote as triageNoteService, type TriageInboxOptions, type TriageInboxResult, type TriageNoteOptions, type TriageNoteResult } from './services/inbox-triage.ts'
import { acceptReviewItem as acceptReviewItemService, applyAllSafeFixes as applyAllSafeFixesService, rejectReviewItem as rejectReviewItemService, snoozeReviewItem as snoozeReviewItemService, type ApplyAllSafeFixesOptions, type ReviewQueueActionOptions, type ReviewQueueActionResult } from './services/review-queue-actions.ts'
import { extractTroubleshootingPattern as extractTroubleshootingPatternService, generatePostmortem as generatePostmortemService, promoteCaptureToRunbook as promoteCaptureToRunbookService, type ExtractTroubleshootingPatternResult, type GeneratePostmortemOptions, type GeneratePostmortemResult, type PromoteCaptureToRunbookOptions, type PromoteCaptureToRunbookResult } from './services/incident-extractor.ts'
import { ingestSource as ingestSourceService, type IngestSourceOptions, type IngestSourceResult } from './services/source-ingest.ts'
import { saveKnowledge as saveKnowledgeService, type SaveKnowledgeOptions, type SaveKnowledgeResult, type SavedKnowledgeType } from './services/knowledge-capture.ts'
import { readHotCache as readHotCacheService, updateHotCache as updateHotCacheService, type HotCacheResult, type UpdateHotCacheOptions } from './services/hot-cache.ts'
import { buildKnowledgeIndex as buildKnowledgeIndexService, type BuildKnowledgeIndexOptions, type KnowledgeIndexResult } from './services/knowledge-index.ts'
import { flagContradiction as flagContradictionService, flagKnowledgeGap as flagKnowledgeGapService, listOpenQuestions as listOpenQuestionsService, resolveGap as resolveGapService, type FlagContradictionOptions, type FlagKnowledgeGapOptions, type KnowledgeGapResult, type OpenQuestion, type ResolveGapOptions } from './services/knowledge-gaps.ts'
import { createResearchPlan as createResearchPlanService, type CreateResearchPlanOptions, type ResearchPlanResult } from './services/research-plan.ts'
import { brainApplyReviewItem as brainApplyReviewItemService, brainReview as brainReviewService, type BrainApplyReviewItemOptions, type BrainApplyReviewItemResult, type BrainReviewItem, type BrainReviewOptions, type BrainReviewResult } from './services/brain-review.ts'

// Re-export service types so existing consumers (server.ts) keep working.
export type { BrokenLink, LintIssue, FrontmatterProfile, FrontmatterLintOptions, FrontmatterFixOptions, MocResult, MaintenanceReport, DuplicateMatch, CaptureMode, CaptureV2Options, CaptureV2Result, NoteQualityScore, LinkSuggestionV2, LinkSuggestionOptions, ApplyLinkSuggestionsOptions, ApplyLinkSuggestionsResult, CustomerDashboardOptions, CustomerDashboardResult, MergeDuplicatesOptions, MergeDuplicatesResult, LifecycleAnalyzeOptions, LifecycleApplyOptions, LifecycleApplyResult, LifecycleSuggestion, SemanticSearchOptions, SemanticSearchResult, SemanticIndexStatus, RebuildSemanticIndexOptions, RebuildSemanticIndexResult, ContextPack, ContextPackOptions, RunSafeMaintenanceOptions, RunSafeMaintenanceResult, SafeMaintenanceStep, SearchParams, SearchResult, CreateNoteOptions, CreateNoteResult, VaultStats, NoteContext, TodoItem, WeeklyReview, LegacyLinkSuggestion, DailyNoteResult, GenerateRunbookResult, OrganizeReferenzResult, RenameNoteOptions, RenameNoteResult, TriageNoteOptions, TriageNoteResult, TriageInboxOptions, TriageInboxResult, ReviewQueueActionOptions, ReviewQueueActionResult, ApplyAllSafeFixesOptions, ExtractTroubleshootingPatternResult, PromoteCaptureToRunbookOptions, PromoteCaptureToRunbookResult, GeneratePostmortemOptions, GeneratePostmortemResult, IngestSourceOptions, IngestSourceResult, SaveKnowledgeOptions, SaveKnowledgeResult, SavedKnowledgeType, HotCacheResult, UpdateHotCacheOptions, BuildKnowledgeIndexOptions, KnowledgeIndexResult, FlagKnowledgeGapOptions, FlagContradictionOptions, ResolveGapOptions, KnowledgeGapResult, OpenQuestion, CreateResearchPlanOptions, ResearchPlanResult, BrainReviewOptions, BrainReviewItem, BrainReviewResult, BrainApplyReviewItemOptions, BrainApplyReviewItemResult }

// ── Types ──────────────────────────────────────────────────────────────

export interface NoteEntry {
  path: string
  relativePath: string
  title: string
  frontmatter: Record<string, any>
  tags: string[]
  outgoingLinks: string[]
  todos: { text: string; done: boolean; line: number }[]
  lastModified: number
  content: string
}

// ── Known entities for auto-categorization ─────────────────────────────
// Clients and tech-terms are loaded from config.ts (clients.json, tech-terms.json).

// ── Vault Class ────────────────────────────────────────────────────────

export class Vault {
  // State fields exposed for service modules in ./services/.
  // Not part of the public MCP API — external callers go through methods.
  readonly vaultPath: string
  readonly notes: Map<string, NoteEntry> = new Map()
  readonly linkIndex: Map<string, Set<string>> = new Map() // target → sources (backlinks)
  private tagIndex: Map<string, Set<string>> = new Map()
  private watcher: ReturnType<typeof watch> | null = null

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath
  }

  async init(): Promise<void> {
    this.scanVault()
    this.startWatcher()
    process.stderr.write(`obsidian-brain: indexed ${this.notes.size} notes\n`)
  }

  shutdown(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  // ── Scanning ───────────────────────────────────────────────────────

  private scanVault(): void {
    this.notes.clear()
    this.tagIndex.clear()
    this.linkIndex.clear()

    // Pass 1: scan all files, build notes + tag index
    this.scanDirectory(this.vaultPath)

    // Pass 2: resolve links now that ALL notes are indexed
    this.buildLinkIndex()
  }

  buildLinkIndex(): void {
    this.linkIndex.clear()
    for (const [target, sources] of buildLinkIndexForNotes(this.notes)) {
      this.linkIndex.set(target, sources)
    }
  }

  private scanDirectory(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue // skip .obsidian, .trash etc
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        this.scanDirectory(fullPath)
      } else if (extname(entry) === '.md') {
        this.indexNote(fullPath, stat.mtimeMs)
      }
    }
  }

  indexNote(fullPath: string, mtimeMs: number): void {
    let raw: string
    try {
      raw = readFileSync(fullPath, 'utf-8')
    } catch {
      return
    }

    const relativePath = relative(this.vaultPath, fullPath)
    const entry = parseNoteEntry(fullPath, relativePath, raw, mtimeMs)

    this.notes.set(relativePath, entry)

    // Update tag index
    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set())
      this.tagIndex.get(tag)!.add(relativePath)
    }

    // Note: link index is built in buildLinkIndex() after all notes are scanned
  }

  private removeFromIndex(relativePath: string): void {
    const entry = this.notes.get(relativePath)
    if (!entry) return

    // Remove from tag index
    for (const tag of entry.tags) {
      this.tagIndex.get(tag)?.delete(relativePath)
      if (this.tagIndex.get(tag)?.size === 0) this.tagIndex.delete(tag)
    }

    removeNoteFromLinkIndex(this.linkIndex, this.notes, relativePath)

    this.notes.delete(relativePath)
  }

  removeNoteFromIndex(relativePath: string): void {
    this.removeFromIndex(relativePath)
  }

  // ── Link Resolution ────────────────────────────────────────────────

  resolveLink(link: string): string | null {
    return resolveLinkInNotes(this.notes, link)
  }

  // ── File Watcher ───────────────────────────────────────────────────

  private startWatcher(): void {
    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return
        if (filename.startsWith('.')) return

        const fullPath = join(this.vaultPath, filename)
        const relativePath = filename

        // Remove old entry first
        this.removeFromIndex(relativePath)

        // Re-index if file still exists
        try {
          const stat = statSync(fullPath)
          this.indexNote(fullPath, stat.mtimeMs)
        } catch {
          // File was deleted, already removed from index
        }

        // Rebuild link index (links may have changed)
        this.buildLinkIndex()
      })
    } catch (err) {
      process.stderr.write(`obsidian-brain: watcher failed: ${err}\n`)
    }
  }

  // ── Public API: Search ─────────────────────────────────────────────

  search(params: SearchParams): SearchResult[] {
    return searchNotes(this.notes, params)
  }

  semanticSearch(options: SemanticSearchOptions): SemanticSearchResult[] {
    return semanticSearchService(this, options)
  }

  semanticIndexStatus(): SemanticIndexStatus {
    return semanticIndexStatusService(this)
  }

  rebuildSemanticIndex(options: RebuildSemanticIndexOptions = {}): RebuildSemanticIndexResult {
    return rebuildSemanticIndexService(this, options)
  }

  buildContextPack(options: ContextPackOptions): ContextPack {
    return buildContextPackService(this, options)
  }

  recallContext(options: ContextPackOptions): ContextPack {
    return this.buildContextPack(options)
  }

  // ── Public API: Note Context ───────────────────────────────────────

  getNoteContext(pathOrTitle: string): NoteContext | null {
    return buildNoteContext(this.notes, this.linkIndex, this.tagIndex, link => this.resolveLink(link), pathOrTitle)
  }

  // ── Public API: Create Note ────────────────────────────────────────

  createNote(
    title: string,
    template: string,
    content?: string,
    tags?: string[],
    folder?: string
  ): { path: string } {
    return createNoteService(this, { title, template, content, tags, folder })
  }

  // ── Public API: Capture ────────────────────────────────────────────

  capture(
    content: string,
    category?: string
  ): { path: string; title: string; tags: string[]; folder: string } {
    const result = this.captureV2(content, { category, mode: 'fast', dryRun: false, logTool: 'capture' })
    return {
      path: result.path,
      title: result.title,
      tags: result.tags,
      folder: result.folder,
    }
  }

  captureV2(content: string, options: CaptureV2Options = {}): CaptureV2Result {
    return captureV2Service(this, content, options)
  }

  ingestSource(options: IngestSourceOptions): IngestSourceResult {
    return ingestSourceService(this, options)
  }

  saveKnowledge(options: SaveKnowledgeOptions): SaveKnowledgeResult {
    return saveKnowledgeService(this, options)
  }

  saveInsight(options: Omit<SaveKnowledgeOptions, 'type'>): SaveKnowledgeResult {
    return this.saveKnowledge({ ...options, type: 'insight' })
  }

  saveDecision(options: Omit<SaveKnowledgeOptions, 'type'>): SaveKnowledgeResult {
    return this.saveKnowledge({ ...options, type: 'decision' })
  }

  saveAnswer(options: Omit<SaveKnowledgeOptions, 'type'>): SaveKnowledgeResult {
    return this.saveKnowledge({ ...options, type: 'answer' })
  }

  updateHotCache(options: UpdateHotCacheOptions = {}): HotCacheResult {
    return updateHotCacheService(this, options)
  }

  readHotCache(): HotCacheResult {
    return readHotCacheService(this)
  }

  buildKnowledgeIndex(options: BuildKnowledgeIndexOptions = {}): KnowledgeIndexResult {
    return buildKnowledgeIndexService(this, options)
  }

  flagKnowledgeGap(options: FlagKnowledgeGapOptions): KnowledgeGapResult {
    return flagKnowledgeGapService(this, options)
  }

  flagContradiction(options: FlagContradictionOptions): KnowledgeGapResult {
    return flagContradictionService(this, options)
  }

  listOpenQuestions(): OpenQuestion[] {
    return listOpenQuestionsService(this)
  }

  resolveGap(options: ResolveGapOptions): KnowledgeGapResult {
    return resolveGapService(this, options)
  }

  createResearchPlan(options: CreateResearchPlanOptions): ResearchPlanResult {
    return createResearchPlanService(this, options)
  }

  brainReview(options: BrainReviewOptions = {}): BrainReviewResult {
    return brainReviewService(this, options)
  }

  brainApplyReviewItem(options: BrainApplyReviewItemOptions): BrainApplyReviewItemResult {
    return brainApplyReviewItemService(this, options)
  }

  // ── Public API: Vault Overview ─────────────────────────────────────

  getOverview(): VaultStats {
    return buildVaultOverview(this.notes, this.linkIndex)
  }

  // ── Public API: Todo List ──────────────────────────────────────────

  getTodoList(folder?: string): TodoItem[] {
    return buildTodoList(this.notes, folder)
  }

  // ── Public API: Suggest Links ──────────────────────────────────────

  suggestLinks(): LegacyLinkSuggestion[] {
    return suggestLegacyLinks(this.notes, link => this.resolveLink(link))
  }

  suggestLinksV2(options: LinkSuggestionOptions = {}): LinkSuggestionV2[] {
    return suggestLinksV2Service(this, options)
  }

  applyLinkSuggestions(options: ApplyLinkSuggestionsOptions = {}): ApplyLinkSuggestionsResult {
    return applyLinkSuggestionsService(this, options)
  }

  buildCustomerDashboard(client: string, options: CustomerDashboardOptions = {}): CustomerDashboardResult {
    return buildCustomerDashboardService(this, client, options)
  }

  suggestLifecycleUpdates(options: LifecycleAnalyzeOptions = {}): LifecycleSuggestion[] {
    return suggestLifecycleUpdatesService(this, options)
  }

  applyLifecycleUpdates(options: LifecycleApplyOptions = {}): LifecycleApplyResult {
    return applyLifecycleUpdatesService(this, options)
  }

  // ── Public API: Weekly Review ──────────────────────────────────────

  weeklyReview(): WeeklyReview {
    return buildWeeklyReview(this.notes)
  }

  // ── Public API: Daily Note ─────────────────────────────────────────

  dailyNote(append?: string): DailyNoteResult {
    return dailyNoteService({
      vaultPath: this.vaultPath,
      createNote: (title, template, content) => this.createNote(title, template, content),
      indexNote: (fullPath, mtimeMs) => this.indexNote(fullPath, mtimeMs),
      buildLinkIndex: () => this.buildLinkIndex(),
    }, append)
  }

  // ── Public API: Generate Runbook ───────────────────────────────────

  generateRunbook(
    topic: string,
    outputFolder?: string
  ): GenerateRunbookResult {
    return generateRunbookService({
      vaultPath: this.vaultPath,
      notes: this.notes,
      indexNote: (fullPath, mtimeMs) => this.indexNote(fullPath, mtimeMs),
      buildLinkIndex: () => this.buildLinkIndex(),
    }, topic, outputFolder)
  }

  extractTroubleshootingPattern(path: string): ExtractTroubleshootingPatternResult {
    return extractTroubleshootingPatternService(this, path)
  }

  promoteCaptureToRunbook(options: PromoteCaptureToRunbookOptions): PromoteCaptureToRunbookResult {
    return promoteCaptureToRunbookService(this, options)
  }

  generatePostmortem(options: GeneratePostmortemOptions): GeneratePostmortemResult {
    return generatePostmortemService(this, options)
  }

  // ── Public API: Organize Referenz into Technik ─────────────────────

  organizeReferenz(dryRun: boolean = false): OrganizeReferenzResult {
    return organizeReferenzService({
      vaultPath: this.vaultPath,
      notes: this.notes,
      indexNote: (fullPath, mtimeMs) => this.indexNote(fullPath, mtimeMs),
      buildLinkIndex: () => this.buildLinkIndex(),
    }, dryRun)
  }

  // ── Public API: Find Duplicates ────────────────────────────────────

  findDuplicates(minScore: number = 40): DuplicateMatch[] {
    return findDuplicatesService(this, minScore)
  }

  mergeDuplicates(options: MergeDuplicatesOptions = {}): MergeDuplicatesResult {
    return mergeDuplicatesService(this, options)
  }

  renameNote(options: RenameNoteOptions): RenameNoteResult {
    return renameNoteService(this, options)
  }

  triageNote(options: TriageNoteOptions): TriageNoteResult {
    return triageNoteService(this, options)
  }

  triageInbox(options: TriageInboxOptions = {}): TriageInboxResult {
    return triageInboxService(this, options)
  }

  acceptReviewItem(options: ReviewQueueActionOptions): ReviewQueueActionResult {
    return acceptReviewItemService(this, options)
  }

  rejectReviewItem(options: ReviewQueueActionOptions): ReviewQueueActionResult {
    return rejectReviewItemService(this, options)
  }

  snoozeReviewItem(options: ReviewQueueActionOptions): ReviewQueueActionResult {
    return snoozeReviewItemService(this, options)
  }

  applyAllSafeFixes(options: ApplyAllSafeFixesOptions = {}): RunSafeMaintenanceResult {
    return applyAllSafeFixesService(this, options)
  }

  // ── Public API: Find & Fix Broken Links ────────────────────────────

  findBrokenLinks(): BrokenLink[] {
    return findBrokenLinksService(this)
  }

  fixBrokenLinks(dryRun: boolean = true) {
    return fixBrokenLinksService(this, dryRun)
  }

  // ── Public API: Lint & Fix Frontmatter ─────────────────────────────

  lintFrontmatter(options: FrontmatterLintOptions = {}): LintIssue[] {
    return lintFrontmatterService(this, options)
  }

  fixFrontmatter(dryRunOrOptions: boolean | FrontmatterFixOptions = true) {
    return fixFrontmatterService(this, dryRunOrOptions)
  }

  // ── Public API: Note Quality ───────────────────────────────────────

  scoreNoteQuality(pathOrTitle: string): NoteQualityScore | null {
    return scoreNoteQualityService(this, pathOrTitle)
  }

  listLowQualityNotes(maxScore: number = 69): NoteQualityScore[] {
    return listLowQualityNotesService(this, maxScore)
  }

  // ── Public API: Generate MOCs (Maps of Content) ────────────────────

  generateMocs(dryRun: boolean = false, minNotes: number = 2): MocResult[] {
    return generateMocsService(this, dryRun, minNotes)
  }

  // ── Public API: Run Full Maintenance Analysis ──────────────────────

  runMaintenance(): MaintenanceReport {
    return runMaintenanceService(this)
  }

  runSafeMaintenance(options: RunSafeMaintenanceOptions = {}): RunSafeMaintenanceResult {
    return runSafeMaintenanceService(this, options)
  }
}
