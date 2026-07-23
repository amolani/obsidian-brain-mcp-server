import { createHash } from 'node:crypto'

export const CALIBRATION_CAPTURE_SCHEMA = 'calibration-capture-v3'
export const LEGACY_CALIBRATION_CAPTURE_SCHEMA = 'calibration-capture-v2'
export const CALIBRATION_CAPTURE_PRODUCER = 'knowledge-harvester'
export const CALIBRATION_EVALUATION_SAMPLE_SIZE = 6

const MAX_CAPTURE_FACTS = 64
const MAX_CANDIDATE_UNIVERSE_FACTS = 10_000
const FACT_ID = /^ks-[a-f0-9]{20}$/
const FACT_REF = /^(F|C)([1-9]\d*):(ks-[a-f0-9]{20})$/
const FINGERPRINT = /^(ks-[a-f0-9]{20}):([a-f0-9]{64})$/
const REVIEW_REF = /^R([1-9]\d*):(ks-[a-f0-9]{20})$/
const PROVENANCE_REF = /^(?:phase|assistant_summary|error_fix|bash_pair):[\p{L}\p{N}._:@-]{1,180}$/u

export interface CalibrationReviewEvidence {
  ref: string
  hash: string
  excerpt: string
}

export interface CalibrationReviewPayload {
  reviewId: string
  statement: string
  evidence: CalibrationReviewEvidence[]
}

export interface CalibrationCaptureBundleInput {
  sessionId: string
  modelVersion: string
  /** Random per-session seed, persisted across incremental capture updates. */
  sampleSeed: string
  /**
   * Complete safe pre-selection population, deduplicated and sorted by its
   * UTF-8 bytes. IDs bind the sampling frame without persisting candidate
   * prose.
   */
  candidateUniverseFactIds: string[]
  /** Selected facts rendered as F1, F2, ... in the Session Digest. */
  selectedFactIds: string[]
  /** Union of selected facts and the seeded uniform evaluation sample. */
  factMap: string[]
  snapshotFingerprints: string[]
  snapshotPayloads: string[]
  /** Randomized, selection-blind mapping and bounded reviewer prose/evidence. */
  reviewMap: string[]
  reviewPayloads: string[]
}

export interface ParsedCalibrationCaptureFact {
  reference: string
  factId: string
  fingerprint: string
  payload: Record<string, unknown>
  payloadRaw: string
  reviewReference: string
  review: CalibrationReviewPayload
}

export interface ParsedCalibrationCaptureBundle {
  schema:
    | typeof CALIBRATION_CAPTURE_SCHEMA
    | typeof LEGACY_CALIBRATION_CAPTURE_SCHEMA
  producer: typeof CALIBRATION_CAPTURE_PRODUCER
  sessionId: string
  modelVersion: string
  sampleSeed: string
  integrity: string
  /** Null only for legacy V2 captures, whose sampling frame was not bound. */
  candidateUniverseFactIds: string[] | null
  selectedFactIds: string[]
  facts: ParsedCalibrationCaptureFact[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedOpaque(value: unknown, field: string, maxLength = 180): string {
  if (typeof value !== 'string') throw new Error(`${field} muss ein String sein`)
  const text = value.normalize('NFC').trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} ist keine gültige opake ID`)
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(text)) {
    throw new Error(`${field} ist keine gültige opake ID`)
  }
  return text
}

function stringArray(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; maxItemLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} muss ein Array sein`)
  const minimum = options.min ?? 0
  const maximum = options.max ?? MAX_CAPTURE_FACTS
  if (value.length < minimum || value.length > maximum) {
    throw new Error(`${field} muss ${minimum} bis ${maximum} Einträge enthalten`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${field}[${index}] muss ein String sein`)
    if (item.length === 0 || item.length > (options.maxItemLength ?? 32_000)) {
      throw new Error(`${field}[${index}] hat eine ungültige Länge`)
    }
    return item
  })
}

function canonicalPayload(input: CalibrationCaptureBundleInput): string {
  return JSON.stringify({
    schema: CALIBRATION_CAPTURE_SCHEMA,
    producer: CALIBRATION_CAPTURE_PRODUCER,
    sessionId: input.sessionId,
    modelVersion: input.modelVersion,
    sampleSeed: input.sampleSeed,
    candidateUniverseFactIds: input.candidateUniverseFactIds,
    selectedFactIds: input.selectedFactIds,
    factMap: input.factMap,
    snapshotFingerprints: input.snapshotFingerprints,
    snapshotPayloads: input.snapshotPayloads,
    reviewMap: input.reviewMap,
    reviewPayloads: input.reviewPayloads,
  })
}

export interface LegacyCalibrationCaptureBundleInput {
  sessionId: string
  modelVersion: string
  sampleSeed: string
  selectedFactIds: string[]
  factMap: string[]
  snapshotFingerprints: string[]
  snapshotPayloads: string[]
  reviewMap: string[]
  reviewPayloads: string[]
}

function legacyCanonicalPayload(input: LegacyCalibrationCaptureBundleInput): string {
  return JSON.stringify({
    schema: LEGACY_CALIBRATION_CAPTURE_SCHEMA,
    producer: CALIBRATION_CAPTURE_PRODUCER,
    sessionId: input.sessionId,
    modelVersion: input.modelVersion,
    sampleSeed: input.sampleSeed,
    selectedFactIds: input.selectedFactIds,
    factMap: input.factMap,
    snapshotFingerprints: input.snapshotFingerprints,
    snapshotPayloads: input.snapshotPayloads,
    reviewMap: input.reviewMap,
    reviewPayloads: input.reviewPayloads,
  })
}

/**
 * Reproduces the V2 attestation for read-only migration and exploratory
 * evaluation. New captures must use calibrationCaptureIntegrity (V3).
 */
export function legacyCalibrationCaptureIntegrityV2(
  input: LegacyCalibrationCaptureBundleInput,
): string {
  return createHash('sha256').update(legacyCanonicalPayload(input)).digest('hex')
}

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function calibrationSampleOrder(sampleSeed: string, factId: string): string {
  return createHash('sha256')
    .update(`${sampleSeed}\0${factId}\0calibration-evaluation-v1`)
    .digest('hex')
}

function boundedReviewText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} muss ein String sein`)
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} ist ungültig`)
  }
  return text
}

export function serializeCalibrationReviewPayload(
  value: CalibrationReviewPayload,
): string {
  const reviewId = boundedReviewText(value.reviewId, 'review.reviewId', 16)
  if (!/^R[1-9]\d*$/.test(reviewId)) throw new Error('review.reviewId ist ungültig')
  const statement = boundedReviewText(value.statement, 'review.statement', 500)
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) {
    throw new Error('review.evidence muss 1 bis 8 Einträge enthalten')
  }
  const evidence = value.evidence.map((item, index) => {
    const ref = boundedReviewText(item.ref, `review.evidence[${index}].ref`, 200)
    if (!PROVENANCE_REF.test(ref)) {
      throw new Error(`review.evidence[${index}].ref ist ungültig`)
    }
    const hash = boundedReviewText(item.hash, `review.evidence[${index}].hash`, 64)
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`review.evidence[${index}].hash ist ungültig`)
    }
    const excerpt = typeof item.excerpt === 'string'
      ? item.excerpt.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 180)
      : ''
    return { ref, hash, excerpt }
  })
  return JSON.stringify({ reviewId, statement, evidence })
}

function parseReviewPayload(value: string, expectedReviewId: string): CalibrationReviewPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error(`Review-Payload ${expectedReviewId} ist kein gültiges JSON`)
  }
  if (!isRecord(parsed)) throw new Error(`Review-Payload ${expectedReviewId} muss ein Objekt sein`)
  const keys = Object.keys(parsed).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['evidence', 'reviewId', 'statement'])) {
    throw new Error(`Review-Payload ${expectedReviewId} enthält unerlaubte Felder`)
  }
  const canonical = serializeCalibrationReviewPayload(
    parsed as unknown as CalibrationReviewPayload,
  )
  const review = JSON.parse(canonical) as CalibrationReviewPayload
  if (review.reviewId !== expectedReviewId || canonical !== value) {
    throw new Error(`Review-Payload ${expectedReviewId} ist nicht kanonisch`)
  }
  return review
}

export function calibrationCaptureIntegrity(input: CalibrationCaptureBundleInput): string {
  return createHash('sha256').update(canonicalPayload(input)).digest('hex')
}

export function calibrationObservationId(
  sessionId: string,
  factId: string,
  fingerprint: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, factId, fingerprint]))
    .digest('hex')
    .slice(0, 24)
  return `ko-${digest}`
}

/**
 * Opaque selector for the blind review surface. It is deliberately derived
 * from attested, high-entropy capture material so callers never need the
 * production note path or internal fact id to record a judgement.
 */
export function calibrationReviewToken(
  captureIntegrity: string,
  reviewReference: string,
  fingerprint: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(captureIntegrity)) {
    throw new Error('captureIntegrity muss ein SHA-256-Hash sein')
  }
  if (!/^R[1-9]\d*$/.test(reviewReference)) {
    throw new Error('reviewReference muss eine kanonische R-Referenz sein')
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('fingerprint muss ein SHA-256-Hash sein')
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'brain-calibration-review-token-v1',
      captureIntegrity,
      reviewReference,
      fingerprint,
    ]))
    .digest('hex')
    .slice(0, 32)
  return `brt-${digest}`
}

/**
 * Pseudonymous grouping key used by project-level evaluation. The clear path
 * remains local in the source snapshot and is never returned by evaluation.
 */
export function calibrationProjectGroupId(sourcePath: string): string {
  const parts = sourcePath.normalize('NFC').split('/').filter(Boolean)
  const scope = parts[0] === 'Kunden' && parts.length >= 2
    ? parts.slice(0, 2).join('/')
    : parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/')
  return `pg-${createHash('sha256').update(scope || 'vault-root').digest('hex').slice(0, 20)}`
}

export function parseCalibrationCaptureBundle(
  frontmatter: Record<string, unknown>,
): ParsedCalibrationCaptureBundle {
  if (frontmatter.quelle !== CALIBRATION_CAPTURE_PRODUCER) {
    throw new Error('Quelle ist kein Knowledge-Harvester-Capture')
  }
  const schema = frontmatter.calibration_capture_schema
  if (
    schema !== CALIBRATION_CAPTURE_SCHEMA
    && schema !== LEGACY_CALIBRATION_CAPTURE_SCHEMA
  ) {
    throw new Error(
      `calibration_capture_schema muss ${CALIBRATION_CAPTURE_SCHEMA} oder `
        + `${LEGACY_CALIBRATION_CAPTURE_SCHEMA} sein`,
    )
  }
  const producer = frontmatter.calibration_capture_producer
  if (producer !== CALIBRATION_CAPTURE_PRODUCER) {
    throw new Error('calibration_capture_producer ist ungültig')
  }
  const sessionId = boundedOpaque(frontmatter.session_id, 'capture.session_id')
  const modelVersion = boundedOpaque(frontmatter.importance_model, 'capture.importance_model', 120)
  const sampleSeed = boundedOpaque(
    frontmatter.calibration_sample_seed,
    'capture.calibration_sample_seed',
    35,
  )
  if (!/^cs-[a-f0-9]{32}$/.test(sampleSeed)) {
    throw new Error('capture.calibration_sample_seed ist ungültig')
  }
  const selectedFactIds = stringArray(
    frontmatter.knowledge_fact_ids,
    'capture.knowledge_fact_ids',
    { min: 1, maxItemLength: 24 },
  )
  if (selectedFactIds.some(id => !FACT_ID.test(id))) {
    throw new Error('capture.knowledge_fact_ids enthält eine ungültige Fakt-ID')
  }
  if (new Set(selectedFactIds).size !== selectedFactIds.length) {
    throw new Error('capture.knowledge_fact_ids darf keine Duplikate enthalten')
  }

  let candidateUniverseFactIds: string[] | null = null
  let candidateUniverseSet: Set<string> | null = null
  let expectedEvaluationSample = new Set<string>()
  if (schema === CALIBRATION_CAPTURE_SCHEMA) {
    candidateUniverseFactIds = stringArray(
      frontmatter.calibration_candidate_universe_fact_ids,
      'capture.calibration_candidate_universe_fact_ids',
      {
        min: 1,
        max: MAX_CANDIDATE_UNIVERSE_FACTS,
        maxItemLength: 24,
      },
    )
    if (candidateUniverseFactIds.some(id => !FACT_ID.test(id))) {
      throw new Error(
        'capture.calibration_candidate_universe_fact_ids enthält eine ungültige Fakt-ID',
      )
    }
    if (new Set(candidateUniverseFactIds).size !== candidateUniverseFactIds.length) {
      throw new Error(
        'capture.calibration_candidate_universe_fact_ids darf keine Duplikate enthalten',
      )
    }
    const sortedUniverse = [...candidateUniverseFactIds].sort(compareUtf8Bytes)
    if (
      candidateUniverseFactIds.some((factId, index) => factId !== sortedUniverse[index])
    ) {
      throw new Error(
        'capture.calibration_candidate_universe_fact_ids muss byteweise sortiert sein',
      )
    }
    const universe = new Set(candidateUniverseFactIds)
    candidateUniverseSet = universe
    if (selectedFactIds.some(factId => !universe.has(factId))) {
      throw new Error(
        'capture.knowledge_fact_ids muss eine Teilmenge des Kandidatenuniversums sein',
      )
    }
    const expectedSampleSize = Math.min(
      CALIBRATION_EVALUATION_SAMPLE_SIZE,
      candidateUniverseFactIds.length,
    )
    expectedEvaluationSample = new Set(
      [...candidateUniverseFactIds]
        .sort((left, right) =>
          compareUtf8Bytes(
            calibrationSampleOrder(sampleSeed, left),
            calibrationSampleOrder(sampleSeed, right),
          ) || compareUtf8Bytes(left, right))
        .slice(0, expectedSampleSize),
    )
  }

  const factMap = stringArray(frontmatter.calibration_fact_map, 'capture.calibration_fact_map', {
    min: 1,
    maxItemLength: 32,
  })
  const snapshotFingerprints = stringArray(
    frontmatter.calibration_snapshot_fingerprints,
    'capture.calibration_snapshot_fingerprints',
    { min: 1, maxItemLength: 96 },
  )
  const snapshotPayloads = stringArray(
    frontmatter.calibration_snapshot_payloads,
    'capture.calibration_snapshot_payloads',
    { min: 1 },
  )
  const reviewMap = stringArray(
    frontmatter.calibration_review_map,
    'capture.calibration_review_map',
    { min: 1, maxItemLength: 32 },
  )
  const reviewPayloads = stringArray(
    frontmatter.calibration_review_payloads,
    'capture.calibration_review_payloads',
    { min: 1 },
  )
  if (
    factMap.length !== snapshotFingerprints.length
    || factMap.length !== snapshotPayloads.length
    || factMap.length !== reviewMap.length
    || factMap.length !== reviewPayloads.length
  ) {
    throw new Error(
      'Kalibrierungs-Map, Fingerprints, Snapshot- und Review-Payloads müssen gleich lang sein',
    )
  }

  let selectedIndex = 0
  let candidateIndex = 0
  let candidateSectionStarted = false
  const seenFactIds = new Set<string>()
  const seenReferences = new Set<string>()
  const baseFacts: Array<Omit<
    ParsedCalibrationCaptureFact,
    'reviewReference' | 'review'
  >> = []
  let sharedGeneratedAt: string | null = null
  let sharedEvidenceModelVersion: string | null = null
  let sharedPopulationCount: number | null = null
  let evaluationSampleCount = 0
  for (let index = 0; index < factMap.length; index++) {
    const mapMatch = factMap[index].match(FACT_REF)
    if (!mapMatch) throw new Error(`capture.calibration_fact_map[${index}] ist ungültig`)
    const [, prefix, rawPosition, factId] = mapMatch
    const position = Number(rawPosition)
    if (prefix === 'F') {
      if (candidateSectionStarted) {
        throw new Error('F-Referenzen müssen vor allen C-Referenzen stehen')
      }
      selectedIndex++
      if (position !== selectedIndex || selectedFactIds[selectedIndex - 1] !== factId) {
        throw new Error('F-Referenzen müssen eine exakte Bijektion zu knowledge_fact_ids bilden')
      }
    } else {
      candidateSectionStarted = true
      candidateIndex++
      if (position !== candidateIndex || selectedFactIds.includes(factId)) {
        throw new Error('C-Referenzen müssen fortlaufende, nicht ausgewählte Fakten bezeichnen')
      }
    }
    const reference = `${prefix}${position}`
    if (seenFactIds.has(factId) || seenReferences.has(reference)) {
      throw new Error('Kalibrierungs-Map darf weder Fakten noch Referenzen duplizieren')
    }
    seenFactIds.add(factId)
    seenReferences.add(reference)
    if (
      candidateUniverseSet !== null
      && !candidateUniverseSet.has(factId)
    ) {
      throw new Error(
        `capture.calibration_fact_map[${index}] liegt außerhalb des Kandidatenuniversums`,
      )
    }

    const fingerprintMatch = snapshotFingerprints[index].match(FINGERPRINT)
    if (!fingerprintMatch || fingerprintMatch[1] !== factId) {
      throw new Error(`Fingerprint und Fakt-ID stimmen an Position ${index} nicht überein`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(snapshotPayloads[index]) as unknown
    } catch {
      throw new Error(`Kalibrierungs-Payload ${index} ist kein gültiges JSON`)
    }
    if (!isRecord(payload) || payload.factId !== factId) {
      throw new Error(`Payload und Fakt-ID stimmen an Position ${index} nicht überein`)
    }
    if (JSON.stringify(payload) !== snapshotPayloads[index]) {
      throw new Error(`Kalibrierungs-Payload ${index} ist nicht kanonisch serialisiert`)
    }
    const computedFingerprint = createHash('sha256')
      .update(snapshotPayloads[index])
      .digest('hex')
    if (computedFingerprint !== fingerprintMatch[2]) {
      throw new Error(`Snapshot-Fingerprint ist an Position ${index} nicht reproduzierbar`)
    }
    if (payload.modelVersion !== modelVersion) {
      throw new Error(`Payload-Modell stimmt an Position ${index} nicht mit dem Capture überein`)
    }
    if (
      typeof payload.evidenceModelVersion !== 'string'
      || !payload.evidenceModelVersion
    ) {
      throw new Error(`Payload-Evidenzmodell ist an Position ${index} ungültig`)
    }
    if (sharedEvidenceModelVersion === null) {
      sharedEvidenceModelVersion = payload.evidenceModelVersion
    } else if (sharedEvidenceModelVersion !== payload.evidenceModelVersion) {
      throw new Error('Alle Payloads eines Bundles müssen dasselbe Evidenzmodell tragen')
    }
    if (
      typeof payload.generatedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.generatedAt)
    ) {
      throw new Error(`Payload generatedAt ist an Position ${index} ungültig`)
    }
    if (sharedGeneratedAt === null) sharedGeneratedAt = payload.generatedAt
    else if (sharedGeneratedAt !== payload.generatedAt) {
      throw new Error('Alle Payloads eines Bundles müssen dasselbe generatedAt tragen')
    }
    if (
      typeof payload.candidatePopulationCount !== 'number'
      || !Number.isInteger(payload.candidatePopulationCount)
      || payload.candidatePopulationCount < 1
      || payload.candidatePopulationCount > 10_000
    ) {
      throw new Error(`candidatePopulationCount ist an Position ${index} ungültig`)
    }
    if (sharedPopulationCount === null) {
      sharedPopulationCount = payload.candidatePopulationCount
    } else if (sharedPopulationCount !== payload.candidatePopulationCount) {
      throw new Error('Alle Payloads eines Bundles müssen dieselbe Kandidatenpopulation tragen')
    }
    const evaluationSample = payload.evaluationSample === true
    if (
      candidateUniverseFactIds !== null
      && evaluationSample !== expectedEvaluationSample.has(factId)
    ) {
      throw new Error(
        `evaluationSample ist für ${factId} nicht aus Seed und Kandidatenuniversum reproduzierbar`,
      )
    }
    const expectedSampleSize = Math.min(
      CALIBRATION_EVALUATION_SAMPLE_SIZE,
      candidateUniverseFactIds?.length ?? payload.candidatePopulationCount,
    )
    const expectedProbability = expectedSampleSize
      / (candidateUniverseFactIds?.length ?? payload.candidatePopulationCount)
    if (evaluationSample) evaluationSampleCount++
    if (
      typeof payload.samplingProbability !== 'number'
      || Math.abs(
        payload.samplingProbability - (evaluationSample ? expectedProbability : 0),
      ) > 1e-12
    ) {
      throw new Error(`samplingProbability ist an Position ${index} nicht reproduzierbar`)
    }
    if (prefix === 'F') {
      if (payload.selectionStatus !== 'selected' || payload.productionRank !== position) {
        throw new Error(`F${position} trägt inkonsistente Auswahlmetadaten`)
      }
    } else if (
      payload.selectionStatus !== 'sampled_unselected'
      || payload.productionRank !== null
      || !evaluationSample
    ) {
      throw new Error(`C${position} trägt inkonsistente Stichprobenmetadaten`)
    }
    baseFacts.push({
      reference,
      factId,
      fingerprint: fingerprintMatch[2],
      payload,
      payloadRaw: snapshotPayloads[index],
    })
  }
  if (selectedIndex !== selectedFactIds.length) {
    throw new Error('Nicht jede ausgewählte Fakt-ID besitzt genau eine F-Referenz')
  }
  if (
    candidateUniverseFactIds !== null
    && sharedPopulationCount !== candidateUniverseFactIds.length
  ) {
    throw new Error(
      'candidatePopulationCount stimmt nicht mit dem attestierten Kandidatenuniversum überein',
    )
  }
  if (candidateUniverseFactIds !== null) {
    const selected = new Set(selectedFactIds)
    for (const factId of expectedEvaluationSample) {
      if (!selected.has(factId) && !seenFactIds.has(factId)) {
        throw new Error(
          `Gesampelter nicht ausgewählter Fakt ${factId} fehlt in calibration_fact_map`,
        )
      }
    }
  }
  if (
    sharedPopulationCount === null
    || baseFacts.length > sharedPopulationCount
    || evaluationSampleCount
      !== Math.min(CALIBRATION_EVALUATION_SAMPLE_SIZE, sharedPopulationCount)
  ) {
    throw new Error('Evaluationsstichprobe stimmt nicht mit der Kandidatenpopulation überein')
  }

  const reviewByFact = new Map<string, {
    reviewReference: string
    review: CalibrationReviewPayload
  }>()
  for (let index = 0; index < reviewMap.length; index++) {
    const match = reviewMap[index].match(REVIEW_REF)
    if (!match || Number(match[1]) !== index + 1) {
      throw new Error(`capture.calibration_review_map[${index}] ist ungültig`)
    }
    const factId = match[2]
    if (!seenFactIds.has(factId) || reviewByFact.has(factId)) {
      throw new Error('Review-Map muss eine exakte Permutation aller Fakten bilden')
    }
    const reviewReference = `R${index + 1}`
    reviewByFact.set(factId, {
      reviewReference,
      review: parseReviewPayload(reviewPayloads[index], reviewReference),
    })
  }
  if (reviewByFact.size !== baseFacts.length) {
    throw new Error('Review-Map muss jeden Fakt genau einmal enthalten')
  }
  const facts: ParsedCalibrationCaptureFact[] = baseFacts.map(fact => ({
    ...fact,
    ...(reviewByFact.get(fact.factId) ?? (() => {
      throw new Error(`Review-Payload für ${fact.factId} fehlt`)
    })()),
  }))
  for (const fact of facts) {
    const snapshotSources = Array.isArray(fact.payload.sourceTypes)
      ? [...new Set(fact.payload.sourceTypes.map(String))].sort()
      : []
    const reviewSources = [...new Set(
      fact.review.evidence.map(item => item.ref.split(':', 1)[0]),
    )].sort()
    if (JSON.stringify(snapshotSources) !== JSON.stringify(reviewSources)) {
      throw new Error(
        `Review-Evidenz und numerische Provenienzklassen stimmen für ${fact.factId} nicht überein`,
      )
    }
  }

  const integrity = frontmatter.calibration_capture_integrity
  if (typeof integrity !== 'string' || !/^[a-f0-9]{64}$/.test(integrity)) {
    throw new Error('calibration_capture_integrity ist ungültig')
  }
  const commonIntegrityInput = {
    sessionId,
    modelVersion,
    sampleSeed,
    selectedFactIds,
    factMap,
    snapshotFingerprints,
    snapshotPayloads,
    reviewMap,
    reviewPayloads,
  }
  const expected = schema === CALIBRATION_CAPTURE_SCHEMA
    ? calibrationCaptureIntegrity({
        ...commonIntegrityInput,
        candidateUniverseFactIds: candidateUniverseFactIds ?? [],
      })
    : legacyCalibrationCaptureIntegrityV2(commonIntegrityInput)
  if (integrity !== expected) {
    throw new Error('Kalibrierungs-Capture-Bundle stimmt nicht mit seiner Attestation überein')
  }

  return {
    schema,
    producer: CALIBRATION_CAPTURE_PRODUCER,
    sessionId,
    modelVersion,
    sampleSeed,
    integrity,
    candidateUniverseFactIds,
    selectedFactIds,
    facts,
  }
}
