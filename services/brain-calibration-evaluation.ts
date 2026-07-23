import { createHash } from 'node:crypto'
import type { Vault } from '../vault.ts'
import {
  KNOWLEDGE_SALIENCE_MODEL,
  type KnowledgeFactFactors,
  type KnowledgeProvenanceSource,
} from './knowledge-salience.ts'
import {
  calibrationObservationId,
  parseCalibrationCaptureBundle,
} from './calibration-capture.ts'
import {
  readBrainCalibrationDataset,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationEntry,
  type BrainCalibrationLabel,
  type BrainCalibrationTargetSnapshot,
} from './brain-calibration.ts'

export const BRAIN_CALIBRATION_EVALUATION_VERSION = 'brain-calibration-evaluation-v2'
export const BRAIN_CALIBRATION_HOLDOUT_POLICY = {
  version: 'strict-chronological-group-embargo-v2',
  holdoutFraction: 0.2,
  minimumTrainPerClass: 30,
  minimumTrainGroups: 30,
  minimumEffectiveTrainTargets: 60,
  minimumDistinctScores: 4,
  minimumTestPerClassForValidation: 30,
  minimumTestGroupsForValidation: 30,
  minimumEffectiveTestTargetsForValidation: 60,
  minimumPromotedPredictionsForValidation: 30,
  minimumValidBootstrapShare: 0.9,
  minimumResponseCoverageForValidation: 0.9,
  minimumResponseCoveragePerSelectionStratum: 0.8,
  minimumRelevantBrierImprovement: 0.005,
  logLossNonInferiorityMargin: 0.01,
  falsePromotionNonInferiorityMargin: 0.02,
  falsePositiveRateNonInferiorityMargin: 0.02,
  promotionCoverageNonInferiorityMargin: 0.02,
  promotionThreshold: 0.75,
  defaultBootstrapSamples: 5_000,
} as const

export type BrainCalibrationEvaluationLabel = Extract<
  BrainCalibrationLabel,
  'useful' | 'supported'
>
export type BrainCalibrationEvaluationGroupBy = 'session' | 'project'
export type BrainCalibrationEvaluationStatus =
  | 'collecting'
  | 'exploratory'
  | 'shadow_validation_eligible'

export interface BrainCalibrationEvaluationOptions {
  label?: BrainCalibrationEvaluationLabel | 'all'
  groupBy?: BrainCalibrationEvaluationGroupBy
  bootstrapSamples?: number
}

export interface ProbabilityInterval {
  low: number
  high: number
}

export interface ReliabilityBin {
  lower: number
  upper: number
  count: number
  weightedCount: number
  meanPrediction: number
  observedRate: number
}

export interface ProbabilityMetrics {
  count: number
  /** Hájek denominator: sum of inverse inclusion-probability weights. */
  weightedCount: number
  effectiveSampleSize: number
  brier: number
  logLoss: number
  meanBias: number
  expectedCalibrationError: number | null
  calibrationIntercept: number | null
  calibrationSlope: number | null
  brierSkillVsPrevalence: number | null
  /** False discoveries among promoted predictions: FP / (TP + FP). */
  falsePromotionRate: number | null
  /** Classical false-positive rate: FP / (FP + TN). */
  falsePositiveRate: number | null
  promotedCount: number
  promotedEffectiveSampleSize: number | null
  promotionCoverage: number
  macroGroupBrier: number
  reliability: ReliabilityBin[]
}

export interface BrainCalibrationModelEvaluation {
  version: string
  probabilityScale: 'probability_0_1'
  metrics: ProbabilityMetrics
  featureNames: string[]
  /** Standardized coefficients; diagnostic only, never production weights. */
  standardizedCoefficients: number[]
  intercept: number
  /** True only when probability is guaranteed non-decreasing in the ordinal score. */
  monotonicOrdinalScore: boolean | null
}

export interface BrainCalibrationComparison {
  deltaBrier: number
  deltaLogLoss: number
  deltaFalsePromotionRate: number | null
  deltaFalsePositiveRate: number | null
  deltaPromotionCoverage: number
  brier95: ProbabilityInterval
  logLoss95: ProbabilityInterval
  falsePromotion95: ProbabilityInterval | null
  falsePositiveRate95: ProbabilityInterval | null
  promotionCoverage95: ProbabilityInterval
  /** Worst-case identification interval under arbitrary missing outcomes. */
  mnarBrier95: ProbabilityInterval | null
  bootstrapSamples: number
  falsePromotionBootstrapSamples: number
  falsePositiveRateBootstrapSamples: number
  baselinePromotedCount: number
  candidatePromotedCount: number
  clusterBootstrap: true
  pairedCoverage: number
}

export interface BrainCalibrationCoverageBand {
  band: string
  eligibleTargets: number
  labeledTargets: number
  responseRate: number | null
  weightedEligibleTargets: number
  weightedLabeledTargets: number
  weightedResponseRate: number | null
}

export interface BrainCalibrationResponseCoverage {
  frame: 'currently_indexed_attested_captures'
  eligibleTargets: number
  labeledTargets: number
  unlabeledTargets: number
  responseRate: number | null
  weightedEligibleTargets: number
  weightedLabeledTargets: number
  weightedUnlabeledTargets: number
  weightedResponseRate: number | null
  completeUsefulSupportedTargets: number
  completeUsefulSupportedRate: number | null
  weightedCompleteUsefulSupportedTargets: number
  weightedCompleteUsefulSupportedRate: number | null
  selected: {
    eligibleTargets: number
    labeledTargets: number
    responseRate: number | null
    weightedEligibleTargets: number
    weightedLabeledTargets: number
    weightedResponseRate: number | null
  }
  sampledUnselected: {
    eligibleTargets: number
    labeledTargets: number
    responseRate: number | null
    weightedEligibleTargets: number
    weightedLabeledTargets: number
    weightedResponseRate: number | null
  }
  holdoutEra: {
    startsAt: string | null
    eligibleTargets: number
    labeledTargets: number
    responseRate: number | null
    weightedEligibleTargets: number
    weightedLabeledTargets: number
    weightedResponseRate: number | null
    selected: {
      eligibleTargets: number
      labeledTargets: number
      responseRate: number | null
      weightedEligibleTargets: number
      weightedLabeledTargets: number
      weightedResponseRate: number | null
    }
    sampledUnselected: {
      eligibleTargets: number
      labeledTargets: number
      responseRate: number | null
      weightedEligibleTargets: number
      weightedLabeledTargets: number
      weightedResponseRate: number | null
    }
    labelsOutsideFrame: number
    assessment:
      | 'frame_unavailable'
      | 'coverage_below_validation_gate'
      | 'coverage_gate_met_mnar_unresolved'
  }
  scoreBands: BrainCalibrationCoverageBand[]
  candidatePopulationBands: BrainCalibrationCoverageBand[]
  labelsOutsideFrame: number
  invalidCaptureBundles: number
  mnarIdentifiable: false
  assessment:
    | 'frame_unavailable'
    | 'coverage_below_validation_gate'
    | 'coverage_gate_met_mnar_unresolved'
}

export interface BrainCalibrationLabelEvaluation {
  label: BrainCalibrationEvaluationLabel
  status: BrainCalibrationEvaluationStatus
  recommendation:
    | 'collect_more'
    | 'continue_shadow'
    | 'preregistered_validation_candidate'
    | 'shadow_candidate_not_better'
  reasons: string[]
  modelVersion: string
  evidenceModelVersion: string
  samplePolicy: 'seeded_uniform_candidate_sample_v2'
  split: {
    policyVersion: typeof BRAIN_CALIBRATION_HOLDOUT_POLICY.version
    groupBy: BrainCalibrationEvaluationGroupBy
    chronological: true
    trainTargets: number
    testTargets: number
    trainGroups: number
    testGroups: number
    trainPositive: number
    trainNegative: number
    testPositive: number
    testNegative: number
    cutoffAt: string | null
    trainLatestAt: string | null
    testEarliestAt: string | null
    strictTemporalOrder: boolean
    embargoedTargets: number
    embargoedGroups: number
    abstainedTies: number
    excludedOutsideEvaluationSample: number
    excludedOtherModelVersions: number
  }
  ordinalScoreSupport: {
    trainMin: number | null
    trainMax: number | null
    distinctTrainValues: number
    testOutsideTrainShare: number | null
  }
  prevalence: number | null
  prevalenceBaseline: ProbabilityMetrics | null
  calibratedProductionScore: BrainCalibrationModelEvaluation | null
  shadowCandidate: BrainCalibrationModelEvaluation | null
  comparison: BrainCalibrationComparison | null
  responseCoverage: BrainCalibrationResponseCoverage
  weightChangeAllowed: false
  releaseDecisionAllowed: false
}

export interface BrainCalibrationValidityDiagnostic {
  label: 'still_valid'
  status: 'descriptive_only'
  entries: number
  uniqueObservations: number
  repeatedObservations: number
  reason: string
}

export interface BrainCalibrationEvaluationResult {
  evaluationVersion: typeof BRAIN_CALIBRATION_EVALUATION_VERSION
  runId: string
  generatedAt: string
  dataFingerprint: string
  reports: BrainCalibrationLabelEvaluation[]
  stillValid: BrainCalibrationValidityDiagnostic | null
  activeWeightsChanged: false
  releaseDecisionAllowed: false
  limitations: string[]
}

interface GoldSample {
  observationId: string
  factId: string
  snapshot: BrainCalibrationTargetSnapshot
  target: 0 | 1
  ordinalScore: number
  samplingWeight: number
  groupId: string
}

interface PredictionRow {
  target: 0 | 1
  probability: number
  groupId: string
  samplingWeight?: number
}

interface PairedPredictionRow {
  target: 0 | 1
  baseline: number
  candidate: number
  groupId: string
  samplingWeight?: number
}

interface LogisticFit {
  featureNames: string[]
  means: number[]
  standardDeviations: number[]
  coefficients: number[]
  intercept: number
  converged: boolean
}

interface AggregatedSamples {
  samples: GoldSample[]
  abstainedTies: number
  excludedOutsideEvaluationSample: number
  excludedOtherModelVersions: number
}

interface EvaluationFrameTarget {
  observationId: string
  selectionStatus: 'selected' | 'sampled_unselected'
  samplingProbability: number
  samplingWeight: number
  generatedAt: string
  salienceScore: number
  evidenceScore: number
  candidatePopulationCount: number
}

interface EvaluationResponseFrame {
  targets: Map<string, EvaluationFrameTarget>
  invalidCaptureBundles: number
}

interface ChronologicalSplit {
  train: GoldSample[]
  test: GoldSample[]
  embargoed: GoldSample[]
  trainGroups: number
  testGroups: number
  embargoedGroups: number
  cutoffAt: string | null
  trainLatestAt: string | null
  testEarliestAt: string | null
  strictTemporalOrder: boolean
}

const SOURCES: readonly KnowledgeProvenanceSource[] = [
  'assistant_summary',
  'bash_pair',
  'error_fix',
  'phase',
]

export const BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY = {
  useful: {
    baseline: 'salience-score-monotone-beta-ipw-v2',
    candidate: 'salience-factors-logistic-ipw-shadow-v2',
    featureNames: [
      'taskRelevance',
      'decisionOutcomeUtility',
      'noveltyInformativeness',
      'reusability',
      'specificity',
    ],
  },
  supported: {
    baseline: 'evidence-score-monotone-beta-ipw-v2',
    candidate: 'evidence-features-logistic-ipw-shadow-v2',
    featureNames: [
      ...SOURCES.map(source => `source:${source}`),
      'logIndependentUnitCount',
      'evidenceConflict',
    ],
  },
} as const

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function samplingWeight(value: number | undefined): number {
  const weight = value ?? 1
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('samplingWeight muss endlich und größer als null sein')
  }
  return weight
}

function sumWeights(rows: readonly { samplingWeight?: number }[]): number {
  return rows.reduce((sum, row) => sum + samplingWeight(row.samplingWeight), 0)
}

function effectiveSampleSize(rows: readonly { samplingWeight?: number }[]): number {
  const total = sumWeights(rows)
  const squared = rows.reduce(
    (sum, row) => sum + samplingWeight(row.samplingWeight) ** 2,
    0,
  )
  return squared <= 0 ? 0 : total ** 2 / squared
}

function weightedMean<T extends { samplingWeight?: number }>(
  rows: readonly T[],
  value: (row: T) => number,
): number {
  const denominator = sumWeights(rows)
  if (denominator <= 0) throw new Error('Gewichteter Mittelwert braucht positives Gewicht')
  return rows.reduce(
    (sum, row) => sum + samplingWeight(row.samplingWeight) * value(row),
    0,
  ) / denominator
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Vorhersage muss eine Wahrscheinlichkeit zwischen 0 und 1 sein')
  }
  return Math.max(1e-6, Math.min(1 - 1e-6, value))
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-Math.min(value, 40))
    return 1 / (1 + exp)
  }
  const exp = Math.exp(Math.max(value, -40))
  return exp / (1 + exp)
}

function logit(value: number): number {
  const probability = clampProbability(value)
  return Math.log(probability / (1 - probability))
}

function betaScoreFeatures(score: number): number[] {
  const scaled = (score + 0.5) / 101
  return [Math.log(scaled), -Math.log(1 - scaled)]
}

function usefulFeatures(factors: KnowledgeFactFactors): number[] {
  return [
    factors.taskRelevance,
    factors.decisionOutcomeUtility,
    factors.noveltyInformativeness,
    factors.reusability,
    factors.specificity,
  ]
}

function supportedFeatures(snapshot: BrainCalibrationTargetSnapshot): number[] {
  const sourceSet = new Set(snapshot.sourceTypes)
  return [
    ...SOURCES.map(source => sourceSet.has(source) ? 1 : 0),
    Math.log1p(snapshot.independentUnitCount),
    snapshot.evidenceConflict ? 1 : 0,
  ]
}

function shadowFeatures(
  label: BrainCalibrationEvaluationLabel,
  snapshot: BrainCalibrationTargetSnapshot,
): number[] {
  return label === 'useful'
    ? usefulFeatures(snapshot.factors)
    : supportedFeatures(snapshot)
}

function modelFeatureNames(label: BrainCalibrationEvaluationLabel): string[] {
  return [...BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY[label].featureNames]
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length
  const augmented = matrix.map((row, index) => [...row, vector[index]])
  for (let column = 0; column < size; column++) {
    let pivot = column
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    for (let item = column; item <= size; item++) augmented[column][item] /= divisor
    for (let row = 0; row < size; row++) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let item = column; item <= size; item++) {
        augmented[row][item] -= factor * augmented[column][item]
      }
    }
  }
  return augmented.map(row => row[size])
}

function fitLogistic(
  features: number[][],
  targets: Array<0 | 1>,
  featureNames: string[],
  options: {
    l2?: number
    sampleWeights?: readonly number[]
    nonNegativeCoefficients?: boolean
  } = {},
): LogisticFit {
  if (features.length === 0 || features.length !== targets.length) {
    throw new Error('Logistic-Fit braucht gleich viele Features und Targets')
  }
  const dimensions = featureNames.length
  if (features.some(row =>
    row.length !== dimensions || row.some(value => !Number.isFinite(value)))) {
    throw new Error('Logistic-Features sind ungültig')
  }
  const rawWeights = options.sampleWeights ?? features.map(() => 1)
  if (
    rawWeights.length !== features.length
    || rawWeights.some(weight => !Number.isFinite(weight) || weight <= 0)
  ) {
    throw new Error('Logistic-Fit braucht gültige positive Stichprobengewichte')
  }
  const rawWeightSum = rawWeights.reduce((sum, weight) => sum + weight, 0)
  // Normalizing to mean one preserves the IPW estimating equation while
  // keeping the fixed L2 penalty comparable across candidate populations.
  const sampleWeights = rawWeights.map(weight => weight * features.length / rawWeightSum)
  const l2 = options.l2 ?? 1
  const means = Array.from({ length: dimensions }, (_, column) =>
    features.reduce(
      (sum, row, index) => sum + sampleWeights[index] * row[column],
      0,
    ) / features.length)
  const standardDeviations = Array.from({ length: dimensions }, (_, column) => {
    const variance = features.reduce(
      (sum, row, index) =>
        sum + sampleWeights[index] * (row[column] - means[column]) ** 2,
      0,
    ) / features.length
    const value = Math.sqrt(variance)
    return value > 1e-9 ? value : 1
  })
  const standardized = features.map(row =>
    row.map((value, column) => (value - means[column]) / standardDeviations[column]))
  const positives = targets.reduce<number>(
    (sum, value, index) => sum + sampleWeights[index] * value,
    0,
  )
  let intercept = logit((positives + 0.5) / (features.length + 1))
  const coefficients = Array.from({ length: dimensions }, () => 0)
  let converged = false

  for (let iteration = 0; iteration < 100; iteration++) {
    const gradient = Array.from({ length: dimensions + 1 }, () => 0)
    const hessian = Array.from(
      { length: dimensions + 1 },
      () => Array.from({ length: dimensions + 1 }, () => 0),
    )
    for (let row = 0; row < standardized.length; row++) {
      const design = [1, ...standardized[row]]
      const linear = intercept + coefficients.reduce(
        (sum, coefficient, column) => sum + coefficient * standardized[row][column],
        0,
      )
      const probability = clampProbability(sigmoid(linear))
      const residual = targets[row] - probability
      const rowWeight = sampleWeights[row]
      const weight = rowWeight * Math.max(1e-6, probability * (1 - probability))
      for (let left = 0; left < design.length; left++) {
        gradient[left] += rowWeight * design[left] * residual
        for (let right = 0; right < design.length; right++) {
          hessian[left][right] += design[left] * weight * design[right]
        }
      }
    }
    for (let index = 1; index <= dimensions; index++) {
      gradient[index] -= l2 * coefficients[index - 1]
      hessian[index][index] += l2
    }
    hessian[0][0] += 1e-6
    const delta = solveLinearSystem(hessian, gradient)
    if (!delta) break
    const nextIntercept = intercept + delta[0]
    const nextCoefficients = coefficients.map((coefficient, index) => {
      const proposed = coefficient + delta[index + 1]
      return options.nonNegativeCoefficients ? Math.max(0, proposed) : proposed
    })
    const change = Math.max(
      Math.abs(nextIntercept - intercept),
      ...nextCoefficients.map(
        (coefficient, index) => Math.abs(coefficient - coefficients[index]),
      ),
    )
    intercept = nextIntercept
    for (let index = 0; index < dimensions; index++) coefficients[index] = nextCoefficients[index]
    if (change < 1e-8) {
      converged = true
      break
    }
  }
  return {
    featureNames,
    means,
    standardDeviations,
    coefficients,
    intercept,
    converged,
  }
}

function predictLogistic(fit: LogisticFit, features: number[]): number {
  if (features.length !== fit.coefficients.length) {
    throw new Error('Featurezahl stimmt nicht mit dem Kalibrator überein')
  }
  const standardized = features.map(
    (value, index) => (value - fit.means[index]) / fit.standardDeviations[index],
  )
  return clampProbability(sigmoid(
    fit.intercept + fit.coefficients.reduce(
      (sum, coefficient, index) => sum + coefficient * standardized[index],
      0,
    ),
  ))
}

function reliabilityBins(rows: readonly PredictionRow[]): ReliabilityBin[] {
  const binCount = Math.min(10, Math.floor(effectiveSampleSize(rows) / 20))
  if (binCount < 1) return []
  const sorted = [...rows].sort((left, right) =>
    left.probability - right.probability || left.groupId.localeCompare(right.groupId, 'en'))
  const totalWeight = sumWeights(sorted)
  const partitioned = Array.from({ length: binCount }, () => [] as PredictionRow[])
  let cumulativeWeight = 0
  for (const row of sorted) {
    const weight = samplingWeight(row.samplingWeight)
    const midpoint = cumulativeWeight + weight / 2
    const bin = Math.min(binCount - 1, Math.floor(midpoint / totalWeight * binCount))
    partitioned[bin].push(row)
    cumulativeWeight += weight
  }
  const bins: ReliabilityBin[] = []
  for (const items of partitioned) {
    if (items.length === 0) continue
    bins.push({
      lower: round(items[0].probability),
      upper: round(items[items.length - 1].probability),
      count: items.length,
      weightedCount: round(sumWeights(items)),
      meanPrediction: round(weightedMean(items, item => item.probability)),
      observedRate: round(weightedMean(items, item => item.target)),
    })
  }
  return bins
}

function calibrationLine(rows: readonly PredictionRow[]): {
  intercept: number | null
  slope: number | null
} {
  const positives = rows.filter(row => row.target === 1).length
  if (rows.length < 20 || positives === 0 || positives === rows.length) {
    return { intercept: null, slope: null }
  }
  const fit = fitLogistic(
    rows.map(row => [logit(row.probability)]),
    rows.map(row => row.target),
    ['predictionLogit'],
    {
      l2: 0.001,
      sampleWeights: rows.map(row => samplingWeight(row.samplingWeight)),
    },
  )
  if (!fit.converged) return { intercept: null, slope: null }
  const slope = fit.coefficients[0] / fit.standardDeviations[0]
  const intercept = fit.intercept - slope * fit.means[0]
  return { intercept: round(intercept), slope: round(slope) }
}

/**
 * Accepts probabilities only. Ordinal production scores are transformed by a
 * train-only versioned calibrator before they can reach this function.
 */
export function evaluateProbabilityPredictions(
  rows: readonly PredictionRow[],
  trainPrevalence: number,
): ProbabilityMetrics {
  if (rows.length === 0) throw new Error('Mindestens eine Wahrscheinlichkeitsvorhersage ist nötig')
  const normalized = rows.map(row => ({
    ...row,
    probability: clampProbability(row.probability),
    samplingWeight: samplingWeight(row.samplingWeight),
  }))
  const totalWeight = sumWeights(normalized)
  const brier = weightedMean(
    normalized,
    row => (row.probability - row.target) ** 2,
  )
  const logLoss = weightedMean(
    normalized,
    row => -(
      row.target * Math.log(row.probability)
      + (1 - row.target) * Math.log(1 - row.probability)
    ),
  )
  const meanPrediction = weightedMean(normalized, row => row.probability)
  const meanTarget = weightedMean(normalized, row => row.target)
  const reliability = reliabilityBins(normalized)
  const expectedCalibrationError = reliability.length === 0
    ? null
    : reliability.reduce(
      (sum, bin) =>
        sum + bin.weightedCount / totalWeight
          * Math.abs(bin.meanPrediction - bin.observedRate),
      0,
    )
  const prevalenceProbability = clampProbability(trainPrevalence)
  const prevalenceBrier = weightedMean(
    normalized,
    row => (prevalenceProbability - row.target) ** 2,
  )
  const promoted = normalized.filter(
    row => row.probability >= BRAIN_CALIBRATION_HOLDOUT_POLICY.promotionThreshold,
  )
  const negatives = normalized.filter(row => row.target === 0)
  const falsePromoted = promoted.filter(row => row.target === 0)
  const groupBrier = new Map<string, PredictionRow[]>()
  for (const row of normalized) {
    const values = groupBrier.get(row.groupId) ?? []
    values.push(row)
    groupBrier.set(row.groupId, values)
  }
  const macroGroupBrier = [...groupBrier.values()].reduce(
    (sum, values) =>
      sum + weightedMean(values, row => (row.probability - row.target) ** 2),
    0,
  ) / groupBrier.size
  const line = calibrationLine(normalized)
  return {
    count: normalized.length,
    weightedCount: round(totalWeight),
    effectiveSampleSize: round(effectiveSampleSize(normalized)),
    brier: round(brier),
    logLoss: round(logLoss),
    meanBias: round(meanPrediction - meanTarget),
    expectedCalibrationError: expectedCalibrationError === null
      ? null
      : round(expectedCalibrationError),
    calibrationIntercept: line.intercept,
    calibrationSlope: line.slope,
    brierSkillVsPrevalence: prevalenceBrier <= 1e-12
      ? null
      : round(1 - brier / prevalenceBrier),
    falsePromotionRate: promoted.length === 0
      ? null
      : round(sumWeights(falsePromoted) / sumWeights(promoted)),
    falsePositiveRate: negatives.length === 0
      ? null
      : round(sumWeights(falsePromoted) / sumWeights(negatives)),
    promotedCount: promoted.length,
    promotedEffectiveSampleSize: promoted.length === 0
      ? null
      : round(effectiveSampleSize(promoted)),
    promotionCoverage: round(sumWeights(promoted) / totalWeight),
    macroGroupBrier: round(macroGroupBrier),
    reliability,
  }
}

function hashSeed(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16)
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new Error('Perzentil braucht Werte')
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * Conservative identification interval under arbitrary missing outcomes.
 * An individual Brier-loss difference is bounded by [-1, 1]. If r is the
 * IPW response share and q=1-r is missing, the unidentified population mean
 * is therefore bounded by r * observed + q * [-1, 1].
 */
export function mnarBrierIdentificationInterval(
  observed95: ProbabilityInterval,
  weightedResponseRate: number,
): ProbabilityInterval {
  if (
    !Number.isFinite(weightedResponseRate)
    || weightedResponseRate < 0
    || weightedResponseRate > 1
  ) {
    throw new Error('weightedResponseRate muss zwischen 0 und 1 liegen')
  }
  const missingShare = 1 - weightedResponseRate
  return {
    low: round(Math.max(-1, weightedResponseRate * observed95.low - missingShare)),
    high: round(Math.min(1, weightedResponseRate * observed95.high + missingShare)),
  }
}

interface PairedStatistics {
  weightedCount: number
  brierDeltaSum: number
  logLossDeltaSum: number
  negativeWeight: number
  baselinePromotedWeight: number
  baselineFalsePromotedWeight: number
  baselinePromotedCount: number
  candidatePromotedWeight: number
  candidateFalsePromotedWeight: number
  candidatePromotedCount: number
}

function emptyPairedStatistics(): PairedStatistics {
  return {
    weightedCount: 0,
    brierDeltaSum: 0,
    logLossDeltaSum: 0,
    negativeWeight: 0,
    baselinePromotedWeight: 0,
    baselineFalsePromotedWeight: 0,
    baselinePromotedCount: 0,
    candidatePromotedWeight: 0,
    candidateFalsePromotedWeight: 0,
    candidatePromotedCount: 0,
  }
}

function addPairedStatistics(
  target: PairedStatistics,
  source: PairedStatistics,
): void {
  for (const key of Object.keys(target) as Array<keyof PairedStatistics>) {
    target[key] += source[key]
  }
}

function summarizePaired(rows: readonly PairedPredictionRow[]): PairedStatistics {
  const summary = emptyPairedStatistics()
  for (const row of rows) {
    const weight = samplingWeight(row.samplingWeight)
    const candidate = clampProbability(row.candidate)
    const baseline = clampProbability(row.baseline)
    const candidateLoss = -(
      row.target * Math.log(candidate)
      + (1 - row.target) * Math.log(1 - candidate)
    )
    const baselineLoss = -(
      row.target * Math.log(baseline)
      + (1 - row.target) * Math.log(1 - baseline)
    )
    const baselinePromoted =
      baseline >= BRAIN_CALIBRATION_HOLDOUT_POLICY.promotionThreshold
    const candidatePromoted =
      candidate >= BRAIN_CALIBRATION_HOLDOUT_POLICY.promotionThreshold
    summary.weightedCount += weight
    summary.brierDeltaSum += weight * (
      (candidate - row.target) ** 2 - (baseline - row.target) ** 2
    )
    summary.logLossDeltaSum += weight * (candidateLoss - baselineLoss)
    if (row.target === 0) summary.negativeWeight += weight
    if (baselinePromoted) {
      summary.baselinePromotedWeight += weight
      summary.baselinePromotedCount++
      if (row.target === 0) summary.baselineFalsePromotedWeight += weight
    }
    if (candidatePromoted) {
      summary.candidatePromotedWeight += weight
      summary.candidatePromotedCount++
      if (row.target === 0) summary.candidateFalsePromotedWeight += weight
    }
  }
  return summary
}

function pairedDelta(summary: PairedStatistics): {
  brier: number
  logLoss: number
  falsePromotion: number | null
  falsePositiveRate: number | null
  promotionCoverage: number
} {
  if (summary.weightedCount <= 0) {
    throw new Error('Gepaarte Statistik braucht positives Stichprobengewicht')
  }
  const baselineFalsePromotion = summary.baselinePromotedWeight <= 0
    ? null
    : summary.baselineFalsePromotedWeight / summary.baselinePromotedWeight
  const candidateFalsePromotion = summary.candidatePromotedWeight <= 0
    ? null
    : summary.candidateFalsePromotedWeight / summary.candidatePromotedWeight
  const falsePromotion = baselineFalsePromotion === null || candidateFalsePromotion === null
    ? null
    : candidateFalsePromotion - baselineFalsePromotion
  const falsePositiveRate = summary.negativeWeight <= 0
    ? null
    : (
      summary.candidateFalsePromotedWeight - summary.baselineFalsePromotedWeight
    ) / summary.negativeWeight
  return {
    brier: summary.brierDeltaSum / summary.weightedCount,
    logLoss: summary.logLossDeltaSum / summary.weightedCount,
    falsePromotion,
    falsePositiveRate,
    promotionCoverage: (
      summary.candidatePromotedWeight - summary.baselinePromotedWeight
    ) / summary.weightedCount,
  }
}

export function clusterBootstrapComparison(
  rows: readonly PairedPredictionRow[],
  samples: number,
  seed: string,
): Pick<
  BrainCalibrationComparison,
  | 'deltaBrier'
  | 'deltaLogLoss'
  | 'deltaFalsePromotionRate'
  | 'deltaFalsePositiveRate'
  | 'deltaPromotionCoverage'
  | 'brier95'
  | 'logLoss95'
  | 'falsePromotion95'
  | 'falsePositiveRate95'
  | 'promotionCoverage95'
  | 'bootstrapSamples'
  | 'falsePromotionBootstrapSamples'
  | 'falsePositiveRateBootstrapSamples'
  | 'baselinePromotedCount'
  | 'candidatePromotedCount'
> {
  if (rows.length === 0) throw new Error('Bootstrap braucht gepaarte Vorhersagen')
  if (!Number.isInteger(samples) || samples < 100 || samples > 5_000) {
    throw new Error('bootstrapSamples muss eine Ganzzahl zwischen 100 und 5000 sein')
  }
  const byGroup = new Map<string, PairedPredictionRow[]>()
  for (const row of rows) {
    const group = byGroup.get(row.groupId) ?? []
    group.push(row)
    byGroup.set(row.groupId, group)
  }
  const groups = [...byGroup.keys()].sort()
  const groupStatistics = new Map<string, PairedStatistics>()
  for (const group of groups) {
    groupStatistics.set(group, summarizePaired(byGroup.get(group) ?? []))
  }
  const random = seededRandom(hashSeed(seed))
  const brierValues: number[] = []
  const logLossValues: number[] = []
  const falsePromotionValues: number[] = []
  const falsePositiveRateValues: number[] = []
  const promotionCoverageValues: number[] = []
  for (let iteration = 0; iteration < samples; iteration++) {
    const replicate = emptyPairedStatistics()
    for (let draw = 0; draw < groups.length; draw++) {
      const group = groups[Math.floor(random() * groups.length)]
      const statistics = groupStatistics.get(group)
      if (statistics) addPairedStatistics(replicate, statistics)
    }
    const delta = pairedDelta(replicate)
    brierValues.push(delta.brier)
    logLossValues.push(delta.logLoss)
    promotionCoverageValues.push(delta.promotionCoverage)
    if (delta.falsePromotion !== null) falsePromotionValues.push(delta.falsePromotion)
    if (delta.falsePositiveRate !== null) {
      falsePositiveRateValues.push(delta.falsePositiveRate)
    }
  }
  brierValues.sort((left, right) => left - right)
  logLossValues.sort((left, right) => left - right)
  falsePromotionValues.sort((left, right) => left - right)
  falsePositiveRateValues.sort((left, right) => left - right)
  promotionCoverageValues.sort((left, right) => left - right)
  const pointSummary = summarizePaired(rows)
  const point = pairedDelta(pointSummary)
  const minimumValidBootstrap = Math.ceil(
    samples * BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumValidBootstrapShare,
  )
  return {
    deltaBrier: round(point.brier),
    deltaLogLoss: round(point.logLoss),
    deltaFalsePromotionRate: point.falsePromotion === null
      ? null
      : round(point.falsePromotion),
    deltaFalsePositiveRate: point.falsePositiveRate === null
      ? null
      : round(point.falsePositiveRate),
    deltaPromotionCoverage: round(point.promotionCoverage),
    brier95: {
      low: round(percentile(brierValues, 0.025)),
      high: round(percentile(brierValues, 0.975)),
    },
    logLoss95: {
      low: round(percentile(logLossValues, 0.025)),
      high: round(percentile(logLossValues, 0.975)),
    },
    falsePromotion95: falsePromotionValues.length < minimumValidBootstrap
      ? null
      : {
        low: round(percentile(falsePromotionValues, 0.025)),
        high: round(percentile(falsePromotionValues, 0.975)),
      },
    falsePositiveRate95: falsePositiveRateValues.length < minimumValidBootstrap
      ? null
      : {
        low: round(percentile(falsePositiveRateValues, 0.025)),
        high: round(percentile(falsePositiveRateValues, 0.975)),
      },
    promotionCoverage95: {
      low: round(percentile(promotionCoverageValues, 0.025)),
      high: round(percentile(promotionCoverageValues, 0.975)),
    },
    bootstrapSamples: samples,
    falsePromotionBootstrapSamples: falsePromotionValues.length,
    falsePositiveRateBootstrapSamples: falsePositiveRateValues.length,
    baselinePromotedCount: pointSummary.baselinePromotedCount,
    candidatePromotedCount: pointSummary.candidatePromotedCount,
  }
}

class UnionFind {
  private readonly parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(index: number): number {
    if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index])
    return this.parent[index]
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot
  }
}

function leakageGroups(
  samples: GoldSample[],
  groupBy: BrainCalibrationEvaluationGroupBy,
): Map<string, GoldSample[]> {
  const unionFind = new UnionFind(samples.length)
  const seen = new Map<string, number>()
  for (const [index, sample] of samples.entries()) {
    const keys = [
      `fact:${sample.factId}`,
      `session:${sample.snapshot.sessionId}`,
      `source:${sample.snapshot.sourcePath}`,
    ]
    if (groupBy === 'project') keys.push(`project:${sample.snapshot.projectGroupId}`)
    for (const key of keys) {
      const previous = seen.get(key)
      if (previous === undefined) seen.set(key, index)
      else unionFind.union(previous, index)
    }
  }
  const components = new Map<number, GoldSample[]>()
  for (const [index, sample] of samples.entries()) {
    const root = unionFind.find(index)
    const component = components.get(root) ?? []
    component.push(sample)
    components.set(root, component)
  }
  const groups = new Map<string, GoldSample[]>()
  for (const component of components.values()) {
    const id = `lg-${createHash('sha256')
      .update(component.map(sample => sample.observationId).sort().join('\0'))
      .digest('hex')
      .slice(0, 20)}`
    for (const sample of component) sample.groupId = id
    groups.set(id, component)
  }
  return groups
}

function chronologicalSplit(
  samples: GoldSample[],
  groupBy: BrainCalibrationEvaluationGroupBy,
): ChronologicalSplit {
  const groups = leakageGroups(samples, groupBy)
  if (groups.size < 2) {
    return {
      train: [],
      test: [],
      embargoed: [...samples],
      trainGroups: 0,
      testGroups: 0,
      embargoedGroups: groups.size,
      cutoffAt: null,
      trainLatestAt: null,
      testEarliestAt: null,
      strictTemporalOrder: false,
    }
  }

  const windows = [...groups.entries()].map(([id, groupSamples]) => {
    const timestamps = groupSamples.map(sample => Date.parse(sample.snapshot.generatedAt))
    if (timestamps.some(timestamp => !Number.isFinite(timestamp))) {
      throw new Error('generatedAt enthält einen ungültigen Zeitstempel')
    }
    return {
      id,
      samples: groupSamples,
      min: Math.min(...timestamps),
      max: Math.max(...timestamps),
      weight: groupSamples.reduce((sum, sample) => sum + sample.samplingWeight, 0),
    }
  })
  const uniqueTimestamps = [...new Set(
    samples.map(sample => Date.parse(sample.snapshot.generatedAt)),
  )].sort((left, right) => left - right)
  const targetTestWeight = samples.reduce(
    (sum, sample) => sum + sample.samplingWeight,
    0,
  ) * BRAIN_CALIBRATION_HOLDOUT_POLICY.holdoutFraction
  let best: {
    cutoff: number
    trainIds: Set<string>
    testIds: Set<string>
    embargoIds: Set<string>
    distance: number
    embargoWeight: number
  } | null = null

  // A cutoff is the earliest permitted test timestamp. Components spanning
  // that boundary are embargoed instead of contaminating either partition.
  for (const cutoff of uniqueTimestamps.slice(1)) {
    const trainIds = new Set<string>()
    const testIds = new Set<string>()
    const embargoIds = new Set<string>()
    let testWeight = 0
    let embargoWeight = 0
    for (const window of windows) {
      if (window.max < cutoff) {
        trainIds.add(window.id)
      } else if (window.min >= cutoff) {
        testIds.add(window.id)
        testWeight += window.weight
      } else {
        embargoIds.add(window.id)
        embargoWeight += window.weight
      }
    }
    if (trainIds.size === 0 || testIds.size === 0) continue
    const candidate = {
      cutoff,
      trainIds,
      testIds,
      embargoIds,
      distance: Math.abs(testWeight - targetTestWeight),
      embargoWeight,
    }
    if (
      best === null
      || candidate.distance < best.distance - 1e-12
      || (
        Math.abs(candidate.distance - best.distance) <= 1e-12
        && candidate.embargoWeight < best.embargoWeight - 1e-12
      )
      || (
        Math.abs(candidate.distance - best.distance) <= 1e-12
        && Math.abs(candidate.embargoWeight - best.embargoWeight) <= 1e-12
        && candidate.cutoff > best.cutoff
      )
    ) {
      best = candidate
    }
  }

  if (best === null) {
    return {
      train: [],
      test: [],
      embargoed: [...samples],
      trainGroups: 0,
      testGroups: 0,
      embargoedGroups: groups.size,
      cutoffAt: null,
      trainLatestAt: null,
      testEarliestAt: null,
      strictTemporalOrder: false,
    }
  }

  const train: GoldSample[] = []
  const test: GoldSample[] = []
  const embargoed: GoldSample[] = []
  for (const [groupId, groupSamples] of groups) {
    if (best.trainIds.has(groupId)) train.push(...groupSamples)
    else if (best.testIds.has(groupId)) test.push(...groupSamples)
    else embargoed.push(...groupSamples)
  }
  const trainLatest = Math.max(
    ...train.map(sample => Date.parse(sample.snapshot.generatedAt)),
  )
  const testEarliest = Math.min(
    ...test.map(sample => Date.parse(sample.snapshot.generatedAt)),
  )
  const strictTemporalOrder = trainLatest < testEarliest
  if (!strictTemporalOrder) {
    throw new Error('Interner Fehler: strikter chronologischer Split wurde verletzt')
  }
  return {
    train,
    test,
    embargoed,
    trainGroups: best.trainIds.size,
    testGroups: best.testIds.size,
    embargoedGroups: best.embargoIds.size,
    cutoffAt: new Date(best.cutoff).toISOString(),
    trainLatestAt: new Date(trainLatest).toISOString(),
    testEarliestAt: new Date(testEarliest).toISOString(),
    strictTemporalOrder,
  }
}

function aggregateGoldSamples(
  entries: readonly BrainCalibrationEntry[],
  label: BrainCalibrationEvaluationLabel,
): AggregatedSamples {
  const labelEntries = entries.filter(entry => entry.label === label)
  const byObservation = new Map<string, BrainCalibrationEntry[]>()
  for (const entry of labelEntries) {
    const observationId = entry.baseObservationId ?? entry.observationId
    const rows = byObservation.get(observationId) ?? []
    rows.push(entry)
    byObservation.set(observationId, rows)
  }
  const samples: GoldSample[] = []
  let abstainedTies = 0
  let excludedOutsideEvaluationSample = 0
  let excludedOtherModelVersions = 0
  for (const rows of byObservation.values()) {
    const snapshot = rows[0].snapshot
    if (
      snapshot.modelVersion !== KNOWLEDGE_SALIENCE_MODEL.version
      || snapshot.evidenceModelVersion !== KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion
    ) {
      excludedOtherModelVersions++
      continue
    }
    if (!snapshot.evaluationSample) {
      excludedOutsideEvaluationSample++
      continue
    }
    if (
      !Number.isFinite(snapshot.samplingProbability)
      || snapshot.samplingProbability <= 0
      || snapshot.samplingProbability > 1
    ) {
      excludedOtherModelVersions++
      continue
    }
    if (!snapshot.sessionId || !snapshot.sourcePath || !snapshot.projectGroupId) {
      excludedOtherModelVersions++
      continue
    }
    const core = serializeCalibrationSnapshotCore(snapshot)
    if (rows.some(row => serializeCalibrationSnapshotCore(row.snapshot) !== core)) {
      excludedOtherModelVersions++
      continue
    }
    const positive = rows.filter(row => row.value).length
    const negative = rows.length - positive
    if (positive === negative) {
      abstainedTies++
      continue
    }
    samples.push({
      observationId: rows[0].baseObservationId ?? rows[0].observationId,
      factId: snapshot.factId,
      snapshot,
      target: positive > negative ? 1 : 0,
      ordinalScore: label === 'useful' ? snapshot.salienceScore : snapshot.evidenceScore,
      samplingWeight: 1 / snapshot.samplingProbability,
      groupId: '',
    })
  }
  return {
    samples,
    abstainedTies,
    excludedOutsideEvaluationSample,
    excludedOtherModelVersions,
  }
}

function counts(samples: readonly GoldSample[]): { positive: number; negative: number } {
  const positive = samples.filter(sample => sample.target === 1).length
  return { positive, negative: samples.length - positive }
}

function collectEvaluationResponseFrame(vault: Vault): EvaluationResponseFrame {
  const targets = new Map<string, EvaluationFrameTarget>()
  let invalidCaptureBundles = 0
  for (const note of vault.notes.values()) {
    if (note.frontmatter.calibration_capture_schema === undefined) continue
    let bundle
    try {
      bundle = parseCalibrationCaptureBundle(note.frontmatter)
    } catch {
      invalidCaptureBundles++
      continue
    }
    for (const fact of bundle.facts) {
      const payload = fact.payload
      if (
        payload.evaluationSample !== true
        || payload.modelVersion !== KNOWLEDGE_SALIENCE_MODEL.version
        || payload.evidenceModelVersion !== KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion
        || (
          payload.selectionStatus !== 'selected'
          && payload.selectionStatus !== 'sampled_unselected'
        )
        || typeof payload.samplingProbability !== 'number'
        || !Number.isFinite(payload.samplingProbability)
        || payload.samplingProbability <= 0
        || payload.samplingProbability > 1
        || typeof payload.generatedAt !== 'string'
        || !Number.isFinite(Date.parse(payload.generatedAt))
        || typeof payload.salienceScore !== 'number'
        || !Number.isFinite(payload.salienceScore)
        || typeof payload.evidenceScore !== 'number'
        || !Number.isFinite(payload.evidenceScore)
        || typeof payload.candidatePopulationCount !== 'number'
        || !Number.isInteger(payload.candidatePopulationCount)
        || payload.candidatePopulationCount < 1
      ) {
        continue
      }
      const observationId = calibrationObservationId(
        bundle.sessionId,
        fact.factId,
        fact.fingerprint,
      )
      const target: EvaluationFrameTarget = {
        observationId,
        selectionStatus: payload.selectionStatus,
        samplingProbability: payload.samplingProbability,
        samplingWeight: 1 / payload.samplingProbability,
        generatedAt: payload.generatedAt,
        salienceScore: payload.salienceScore,
        evidenceScore: payload.evidenceScore,
        candidatePopulationCount: payload.candidatePopulationCount,
      }
      const previous = targets.get(observationId)
      if (
        previous
        && (
          previous.selectionStatus !== target.selectionStatus
          || Math.abs(previous.samplingProbability - target.samplingProbability) > 1e-12
        )
      ) {
        invalidCaptureBundles++
        targets.delete(observationId)
        continue
      }
      targets.set(observationId, target)
    }
  }
  return { targets, invalidCaptureBundles }
}

function responseCoverageForLabel(
  entries: readonly BrainCalibrationEntry[],
  label: BrainCalibrationEvaluationLabel,
  frame: EvaluationResponseFrame,
  holdoutStartsAt: string | null,
): BrainCalibrationResponseCoverage {
  const labelsByObservation = new Map<string, Set<BrainCalibrationLabel>>()
  const generatedAtByObservation = new Map<string, string>()
  for (const entry of entries) {
    if (
      !entry.snapshot.evaluationSample
      || entry.snapshot.modelVersion !== KNOWLEDGE_SALIENCE_MODEL.version
      || entry.snapshot.evidenceModelVersion !== KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion
    ) {
      continue
    }
    const observationId = entry.baseObservationId ?? entry.observationId
    const labels = labelsByObservation.get(observationId) ?? new Set<BrainCalibrationLabel>()
    labels.add(entry.label)
    labelsByObservation.set(observationId, labels)
    generatedAtByObservation.set(observationId, entry.snapshot.generatedAt)
  }
  const labeledForTarget = new Set(
    [...labelsByObservation.entries()]
      .filter(([, labels]) => labels.has(label))
      .map(([observationId]) => observationId),
  )
  const completeUsefulSupported = new Set(
    [...labelsByObservation.entries()]
      .filter(([, labels]) => labels.has('useful') && labels.has('supported'))
      .map(([observationId]) => observationId),
  )
  const frameTargets = [...frame.targets.values()]
  const completeTargets = frameTargets.filter(
    target => completeUsefulSupported.has(target.observationId),
  ).length
  const frameWeight = frameTargets.reduce(
    (sum, target) => sum + target.samplingWeight,
    0,
  )
  const completeWeight = frameTargets.reduce(
    (sum, target) =>
      sum + (completeUsefulSupported.has(target.observationId) ? target.samplingWeight : 0),
    0,
  )
  const stratum = (eligible: EvaluationFrameTarget[]) => {
    const labeled = eligible.filter(
      target => labeledForTarget.has(target.observationId),
    ).length
    const eligibleWeight = eligible.reduce(
      (sum, target) => sum + target.samplingWeight,
      0,
    )
    const stratumLabeledWeight = eligible.reduce(
      (sum, target) =>
        sum + (labeledForTarget.has(target.observationId) ? target.samplingWeight : 0),
      0,
    )
    return {
      eligibleTargets: eligible.length,
      labeledTargets: labeled,
      responseRate: eligible.length === 0 ? null : round(labeled / eligible.length),
      weightedEligibleTargets: round(eligibleWeight),
      weightedLabeledTargets: round(stratumLabeledWeight),
      weightedResponseRate: eligibleWeight <= 0
        ? null
        : round(stratumLabeledWeight / eligibleWeight),
    }
  }
  const slice = (targets: EvaluationFrameTarget[]) => {
    const summary = stratum(targets)
    return {
      ...summary,
      selected: stratum(targets.filter(target => target.selectionStatus === 'selected')),
      sampledUnselected: stratum(
        targets.filter(target => target.selectionStatus === 'sampled_unselected'),
      ),
    }
  }
  const band = (
    name: string,
    targets: EvaluationFrameTarget[],
  ): BrainCalibrationCoverageBand => ({
    band: name,
    ...stratum(targets),
  })
  const overall = slice(frameTargets)
  const labelsOutsideFrame = [...labeledForTarget].filter(
    observationId => !frame.targets.has(observationId),
  ).length
  const cutoff = holdoutStartsAt === null ? null : Date.parse(holdoutStartsAt)
  const holdoutTargets = cutoff === null
    ? []
    : frameTargets.filter(target => Date.parse(target.generatedAt) >= cutoff)
  const holdout = slice(holdoutTargets)
  const holdoutLabelsOutsideFrame = cutoff === null
    ? 0
    : [...labeledForTarget].filter(observationId => {
      if (frame.targets.has(observationId)) return false
      const generatedAt = generatedAtByObservation.get(observationId)
      return generatedAt !== undefined && Date.parse(generatedAt) >= cutoff
    }).length
  const coverageAssessment = (
    coverage: ReturnType<typeof slice>,
    outsideFrame: number,
    frameAvailable: boolean,
  ): BrainCalibrationResponseCoverage['assessment'] => {
    const stratumSufficient = [coverage.selected, coverage.sampledUnselected].every(item =>
      item.weightedResponseRate === null
      || item.weightedResponseRate
        >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumResponseCoveragePerSelectionStratum)
    const sufficient = coverage.weightedResponseRate !== null
      && coverage.weightedResponseRate
        >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumResponseCoverageForValidation
      && stratumSufficient
      && outsideFrame === 0
      && frame.invalidCaptureBundles === 0
    return !frameAvailable || coverage.weightedResponseRate === null
      ? 'frame_unavailable'
      : sufficient
        ? 'coverage_gate_met_mnar_unresolved'
        : 'coverage_below_validation_gate'
  }
  const score = (target: EvaluationFrameTarget) => label === 'useful'
    ? target.salienceScore
    : target.evidenceScore
  const scoreBands = [
    { name: '0-24', minimum: 0, maximum: 25 },
    { name: '25-49', minimum: 25, maximum: 50 },
    { name: '50-74', minimum: 50, maximum: 75 },
    { name: '75-100', minimum: 75, maximum: 101 },
  ].map(item => band(
    item.name,
    frameTargets.filter(target =>
      score(target) >= item.minimum && score(target) < item.maximum),
  ))
  const candidatePopulationBands = [
    { name: '1-6', minimum: 1, maximum: 7 },
    { name: '7-24', minimum: 7, maximum: 25 },
    { name: '25-99', minimum: 25, maximum: 100 },
    { name: '100+', minimum: 100, maximum: Number.POSITIVE_INFINITY },
  ].map(item => band(
    item.name,
    frameTargets.filter(target =>
      target.candidatePopulationCount >= item.minimum
      && target.candidatePopulationCount < item.maximum),
  ))
  return {
    frame: 'currently_indexed_attested_captures',
    eligibleTargets: overall.eligibleTargets,
    labeledTargets: overall.labeledTargets,
    unlabeledTargets: overall.eligibleTargets - overall.labeledTargets,
    responseRate: overall.responseRate,
    weightedEligibleTargets: overall.weightedEligibleTargets,
    weightedLabeledTargets: overall.weightedLabeledTargets,
    weightedUnlabeledTargets: round(
      overall.weightedEligibleTargets - overall.weightedLabeledTargets,
    ),
    weightedResponseRate: overall.weightedResponseRate,
    completeUsefulSupportedTargets: completeTargets,
    completeUsefulSupportedRate: frameTargets.length === 0
      ? null
      : round(completeTargets / frameTargets.length),
    weightedCompleteUsefulSupportedTargets: round(completeWeight),
    weightedCompleteUsefulSupportedRate: frameWeight <= 0
      ? null
      : round(completeWeight / frameWeight),
    selected: overall.selected,
    sampledUnselected: overall.sampledUnselected,
    holdoutEra: {
      startsAt: holdoutStartsAt,
      ...holdout,
      labelsOutsideFrame: holdoutLabelsOutsideFrame,
      assessment: coverageAssessment(
        holdout,
        holdoutLabelsOutsideFrame,
        cutoff !== null,
      ),
    },
    scoreBands,
    candidatePopulationBands,
    labelsOutsideFrame,
    invalidCaptureBundles: frame.invalidCaptureBundles,
    mnarIdentifiable: false,
    assessment: coverageAssessment(overall, labelsOutsideFrame, frameTargets.length > 0),
  }
}

function responseCoverageSufficient(
  diagnostic: BrainCalibrationResponseCoverage,
): boolean {
  return diagnostic.assessment === 'coverage_gate_met_mnar_unresolved'
    && diagnostic.holdoutEra.assessment === 'coverage_gate_met_mnar_unresolved'
}

function responseCoverageReason(
  diagnostic: BrainCalibrationResponseCoverage,
): string {
  const rate = (value: number | null) => value === null
    ? 'nicht bestimmbar'
    : `${round(value * 100, 1)} %`
  const bands = (items: BrainCalibrationCoverageBand[]) => items
    .map(item => `${item.band}:${rate(item.weightedResponseRate)}`)
    .join(', ')
  return [
    `Response-Coverage im aktuell attestierten Capture-Frame: roh ${diagnostic.labeledTargets}/${diagnostic.eligibleTargets} (${rate(diagnostic.responseRate)}), IPW ${diagnostic.weightedLabeledTargets}/${diagnostic.weightedEligibleTargets} (${rate(diagnostic.weightedResponseRate)})`,
    `selected roh ${diagnostic.selected.labeledTargets}/${diagnostic.selected.eligibleTargets}, IPW ${rate(diagnostic.selected.weightedResponseRate)}`,
    `sampled_unselected roh ${diagnostic.sampledUnselected.labeledTargets}/${diagnostic.sampledUnselected.eligibleTargets}, IPW ${rate(diagnostic.sampledUnselected.weightedResponseRate)}`,
    `Holdout-Ära ab ${diagnostic.holdoutEra.startsAt ?? 'nicht bestimmbar'}: IPW gesamt ${rate(diagnostic.holdoutEra.weightedResponseRate)}, selected ${rate(diagnostic.holdoutEra.selected.weightedResponseRate)}, sampled_unselected ${rate(diagnostic.holdoutEra.sampledUnselected.weightedResponseRate)}`,
    `vollständig useful+supported roh ${diagnostic.completeUsefulSupportedTargets}/${diagnostic.eligibleTargets} (${rate(diagnostic.completeUsefulSupportedRate)}), IPW ${rate(diagnostic.weightedCompleteUsefulSupportedRate)}`,
    `Score-Bänder IPW ${bands(diagnostic.scoreBands)}`,
    `Kandidatenpopulation-Bänder IPW ${bands(diagnostic.candidatePopulationBands)}`,
    `ungültige Captures ${diagnostic.invalidCaptureBundles}`,
    `Labels außerhalb des Frames ${diagnostic.labelsOutsideFrame}; MNAR bleibt nicht identifizierbar.`,
  ].join('; ')
}

function emptyEvaluation(
  label: BrainCalibrationEvaluationLabel,
  groupBy: BrainCalibrationEvaluationGroupBy,
  aggregate: AggregatedSamples,
  responseCoverage: BrainCalibrationResponseCoverage,
  reasons: string[],
): BrainCalibrationLabelEvaluation {
  return {
    label,
    status: 'collecting',
    recommendation: 'collect_more',
    reasons: [...reasons, responseCoverageReason(responseCoverage)],
    modelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    evidenceModelVersion: KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion,
    samplePolicy: 'seeded_uniform_candidate_sample_v2',
    split: {
      policyVersion: BRAIN_CALIBRATION_HOLDOUT_POLICY.version,
      groupBy,
      chronological: true,
      trainTargets: 0,
      testTargets: aggregate.samples.length,
      trainGroups: 0,
      testGroups: aggregate.samples.length > 0 ? 1 : 0,
      trainPositive: 0,
      trainNegative: 0,
      testPositive: counts(aggregate.samples).positive,
      testNegative: counts(aggregate.samples).negative,
      cutoffAt: null,
      trainLatestAt: null,
      testEarliestAt: null,
      strictTemporalOrder: false,
      embargoedTargets: 0,
      embargoedGroups: 0,
      abstainedTies: aggregate.abstainedTies,
      excludedOutsideEvaluationSample: aggregate.excludedOutsideEvaluationSample,
      excludedOtherModelVersions: aggregate.excludedOtherModelVersions,
    },
    ordinalScoreSupport: {
      trainMin: null,
      trainMax: null,
      distinctTrainValues: 0,
      testOutsideTrainShare: null,
    },
    prevalence: null,
    prevalenceBaseline: null,
    calibratedProductionScore: null,
    shadowCandidate: null,
    comparison: null,
    responseCoverage,
    weightChangeAllowed: false,
    releaseDecisionAllowed: false,
  }
}

function evaluateLabel(
  entries: readonly BrainCalibrationEntry[],
  label: BrainCalibrationEvaluationLabel,
  groupBy: BrainCalibrationEvaluationGroupBy,
  bootstrapSamples: number,
  responseFrame: EvaluationResponseFrame,
  bootstrapSeed: string,
): BrainCalibrationLabelEvaluation {
  const aggregate = aggregateGoldSamples(entries, label)
  if (aggregate.samples.length < 2) {
    const responseCoverage = responseCoverageForLabel(
      entries,
      label,
      responseFrame,
      null,
    )
    return emptyEvaluation(label, groupBy, aggregate, responseCoverage, [
      'Mindestens zwei unabhängige, nicht unentschiedene Evaluationsbeobachtungen sind nötig.',
    ])
  }
  const split = chronologicalSplit(aggregate.samples, groupBy)
  const responseCoverage = responseCoverageForLabel(
    entries,
    label,
    responseFrame,
    split.testEarliestAt,
  )
  const trainCounts = counts(split.train)
  const testCounts = counts(split.test)
  const distinctScores = new Set(split.train.map(sample => sample.ordinalScore)).size
  const trainMin = split.train.length > 0
    ? Math.min(...split.train.map(sample => sample.ordinalScore))
    : null
  const trainMax = split.train.length > 0
    ? Math.max(...split.train.map(sample => sample.ordinalScore))
    : null
  const outsideShare = trainMin === null || trainMax === null || split.test.length === 0
    ? null
    : weightedMean(
      split.test,
      sample => sample.ordinalScore < trainMin || sample.ordinalScore > trainMax ? 1 : 0,
    )
  const trainEffectiveTargets = effectiveSampleSize(split.train)
  const testEffectiveTargets = effectiveSampleSize(split.test)
  const reasons: string[] = []
  if (!split.strictTemporalOrder) {
    reasons.push(
      'Kein strikt chronologischer, leakage-freier Train/Test-Schnitt war identifizierbar.',
    )
  }
  if (trainCounts.positive < BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainPerClass) {
    reasons.push(
      `Training braucht mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainPerClass} positive Targets.`,
    )
  }
  if (trainCounts.negative < BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainPerClass) {
    reasons.push(
      `Training braucht mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainPerClass} negative Targets.`,
    )
  }
  if (split.trainGroups < BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainGroups) {
    reasons.push(
      `Training braucht mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTrainGroups} Leakage-Gruppen.`,
    )
  }
  if (
    trainEffectiveTargets
      < BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumEffectiveTrainTargets
  ) {
    reasons.push(
      `Training braucht nach IPW mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumEffectiveTrainTargets} effektive Targets.`,
    )
  }
  if (distinctScores < BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumDistinctScores) {
    reasons.push(
      `Training braucht mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumDistinctScores} verschiedene ordinale Scores.`,
    )
  }
  const base = emptyEvaluation(label, groupBy, aggregate, responseCoverage, reasons)
  base.split = {
    ...base.split,
    trainTargets: split.train.length,
    testTargets: split.test.length,
    trainGroups: split.trainGroups,
    testGroups: split.testGroups,
    trainPositive: trainCounts.positive,
    trainNegative: trainCounts.negative,
    testPositive: testCounts.positive,
    testNegative: testCounts.negative,
    cutoffAt: split.cutoffAt,
    trainLatestAt: split.trainLatestAt,
    testEarliestAt: split.testEarliestAt,
    strictTemporalOrder: split.strictTemporalOrder,
    embargoedTargets: split.embargoed.length,
    embargoedGroups: split.embargoedGroups,
  }
  base.ordinalScoreSupport = {
    trainMin,
    trainMax,
    distinctTrainValues: distinctScores,
    testOutsideTrainShare: outsideShare === null ? null : round(outsideShare),
  }
  if (split.embargoed.length > 0) {
    base.reasons.push(
      `${split.embargoed.length} Target(s) aus ${split.embargoedGroups} Leakage-Gruppe(n) überspannten den Cutoff und wurden embargoed.`,
    )
  }
  if (reasons.length > 0 || split.test.length === 0) return base

  const prevalence = weightedMean(split.train, sample => sample.target)
  const baselineFit = fitLogistic(
    split.train.map(sample => betaScoreFeatures(sample.ordinalScore)),
    split.train.map(sample => sample.target),
    ['logScore', 'negativeLogOneMinusScore'],
    {
      sampleWeights: split.train.map(sample => sample.samplingWeight),
      nonNegativeCoefficients: true,
    },
  )
  const shadowFit = fitLogistic(
    split.train.map(sample => shadowFeatures(label, sample.snapshot)),
    split.train.map(sample => sample.target),
    modelFeatureNames(label),
    { sampleWeights: split.train.map(sample => sample.samplingWeight) },
  )
  if (!baselineFit.converged || !shadowFit.converged) {
    base.reasons.push('Mindestens ein regulärisierter Kalibrator ist nicht konvergiert.')
    return base
  }
  const paired = split.test.map(sample => ({
    target: sample.target,
    baseline: predictLogistic(baselineFit, betaScoreFeatures(sample.ordinalScore)),
    candidate: predictLogistic(shadowFit, shadowFeatures(label, sample.snapshot)),
    groupId: sample.groupId,
    samplingWeight: sample.samplingWeight,
  }))
  const baselineRows = paired.map(row => ({
    target: row.target,
    probability: row.baseline,
    groupId: row.groupId,
    samplingWeight: row.samplingWeight,
  }))
  const shadowRows = paired.map(row => ({
    target: row.target,
    probability: row.candidate,
    groupId: row.groupId,
    samplingWeight: row.samplingWeight,
  }))
  const prevalenceRows = paired.map(row => ({
    target: row.target,
    probability: prevalence,
    groupId: row.groupId,
    samplingWeight: row.samplingWeight,
  }))
  const baselineMetrics = evaluateProbabilityPredictions(baselineRows, prevalence)
  const shadowMetrics = evaluateProbabilityPredictions(shadowRows, prevalence)
  const comparisonCore = clusterBootstrapComparison(
    paired,
    bootstrapSamples,
    `${BRAIN_CALIBRATION_EVALUATION_VERSION}:${label}:${groupBy}:${bootstrapSeed}`,
  )
  const comparison: BrainCalibrationComparison = {
    ...comparisonCore,
    mnarBrier95: responseCoverage.holdoutEra.weightedResponseRate === null
      ? null
      : mnarBrierIdentificationInterval(
        comparisonCore.brier95,
        responseCoverage.holdoutEra.weightedResponseRate,
      ),
    clusterBootstrap: true,
    pairedCoverage: 1,
  }
  const intervalText = (interval: ProbabilityInterval | null) => interval === null
    ? 'nicht bestimmbar'
    : `[${round(interval.low, 4)}, ${round(interval.high, 4)}]`
  base.reasons.push(
    `Cluster-Bootstrap: ΔFalse-Promotion 95 % ${intervalText(comparison.falsePromotion95)}, ΔFPR 95 % ${intervalText(comparison.falsePositiveRate95)}, ΔCoverage 95 % ${intervalText(comparison.promotionCoverage95)}, MNAR-ΔBrier 95 % ${intervalText(comparison.mnarBrier95)}; positive Vorhersagen baseline=${comparison.baselinePromotedCount}, shadow=${comparison.candidatePromotedCount}.`,
  )
  const shadowValidationEligible = split.strictTemporalOrder
    && split.testGroups
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTestGroupsForValidation
    && testCounts.positive
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTestPerClassForValidation
    && testCounts.negative
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumTestPerClassForValidation
    && testEffectiveTargets
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumEffectiveTestTargetsForValidation
    && (outsideShare ?? 1) <= 0.05
    && responseCoverageSufficient(responseCoverage)
  base.status = shadowValidationEligible ? 'shadow_validation_eligible' : 'exploratory'
  if (!shadowValidationEligible) {
    base.reasons.push(
      'Shadow-Holdout ist noch nicht für die Planung einer präregistrierten Validierung geeignet: benötigt strikte Zeitordnung, mindestens 30 Gruppen, je 30 positive/negative Targets, effektive Stichprobengröße 60, ausreichende Response-Coverage und stabilen Score-Support.',
    )
  }
  if ((outsideShare ?? 0) > 0.05) {
    base.reasons.push('Mehr als 5 % der Holdout-Scores liegen außerhalb des Trainingssupports.')
  }
  if (!responseCoverageSufficient(responseCoverage)) {
    base.reasons.push(
      'Die IPW-Response-Coverage der Holdout-Ära ist insgesamt oder in einem Auswahlstratum unvollständig bzw. nicht bestimmbar; MNAR bleibt nicht identifizierbar.',
    )
  }
  if (
    comparison.mnarBrier95 === null
    || comparison.mnarBrier95.high
      >= -BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumRelevantBrierImprovement
  ) {
    base.reasons.push(
      'Die konservative MNAR-Identifikationsgrenze belegt die minimale Brier-Verbesserung noch nicht.',
    )
  }
  const promotionsSufficient = comparison.baselinePromotedCount
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumPromotedPredictionsForValidation
    && comparison.candidatePromotedCount
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumPromotedPredictionsForValidation
    && (baselineMetrics.promotedEffectiveSampleSize ?? 0)
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumPromotedPredictionsForValidation
    && (shadowMetrics.promotedEffectiveSampleSize ?? 0)
      >= BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumPromotedPredictionsForValidation
  if (!promotionsSufficient) {
    base.reasons.push(
      `False-Promotion-Inferenz braucht je Modell mindestens ${BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumPromotedPredictionsForValidation} rohe und effektive positive Vorhersagen im Holdout.`,
    )
  }
  const falsePromotionNonInferior = comparison.falsePromotion95 !== null
    && comparison.falsePromotion95.high
      <= BRAIN_CALIBRATION_HOLDOUT_POLICY.falsePromotionNonInferiorityMargin
  const falsePositiveRateNonInferior = comparison.falsePositiveRate95 !== null
    && comparison.falsePositiveRate95.high
      <= BRAIN_CALIBRATION_HOLDOUT_POLICY.falsePositiveRateNonInferiorityMargin
  const coverageNonInferior = comparison.promotionCoverage95.low
    >= -BRAIN_CALIBRATION_HOLDOUT_POLICY.promotionCoverageNonInferiorityMargin
  const preregisteredCandidate = shadowValidationEligible
    && comparison.brier95.high
      < -BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumRelevantBrierImprovement
    && comparison.mnarBrier95 !== null
    && comparison.mnarBrier95.high
      < -BRAIN_CALIBRATION_HOLDOUT_POLICY.minimumRelevantBrierImprovement
    && comparison.logLoss95.high
      < BRAIN_CALIBRATION_HOLDOUT_POLICY.logLossNonInferiorityMargin
    && promotionsSufficient
    && falsePromotionNonInferior
    && falsePositiveRateNonInferior
    && coverageNonInferior
    && shadowMetrics.brierSkillVsPrevalence !== null
    && shadowMetrics.brierSkillVsPrevalence > 0
  base.recommendation = preregisteredCandidate
    ? 'preregistered_validation_candidate'
    : shadowValidationEligible
      ? 'shadow_candidate_not_better'
      : 'continue_shadow'
  base.prevalence = round(prevalence)
  base.prevalenceBaseline = evaluateProbabilityPredictions(prevalenceRows, prevalence)
  base.calibratedProductionScore = {
    version: BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY[label].baseline,
    probabilityScale: 'probability_0_1',
    metrics: baselineMetrics,
    featureNames: baselineFit.featureNames,
    standardizedCoefficients: baselineFit.coefficients.map(value => round(value)),
    intercept: round(baselineFit.intercept),
    monotonicOrdinalScore: true,
  }
  base.shadowCandidate = {
    version: BRAIN_CALIBRATION_SHADOW_MODEL_REGISTRY[label].candidate,
    probabilityScale: 'probability_0_1',
    metrics: shadowMetrics,
    featureNames: shadowFit.featureNames,
    standardizedCoefficients: shadowFit.coefficients.map(value => round(value)),
    intercept: round(shadowFit.intercept),
    monotonicOrdinalScore: null,
  }
  base.comparison = comparison
  return base
}

function validityDiagnostic(
  entries: readonly BrainCalibrationEntry[],
): BrainCalibrationValidityDiagnostic {
  const validity = entries.filter(entry => entry.label === 'still_valid')
  const unique = new Set(validity.map(entry => entry.observationId))
  return {
    label: 'still_valid',
    status: 'descriptive_only',
    entries: validity.length,
    uniqueObservations: unique.size,
    repeatedObservations: Math.max(0, validity.length - unique.size),
    reason:
      'Zeitliche Gültigkeit bleibt deskriptiv: Invalidierungszeitpunkte sind intervallzensiert und brauchen ein eigenes Survival-Protokoll.',
  }
}

function dataFingerprint(
  entries: readonly BrainCalibrationEntry[],
  responseFrame: EvaluationResponseFrame,
): string {
  const labelPayload = entries
    .map(entry => ({
      observationId: entry.observationId,
      baseObservationId: entry.baseObservationId ?? entry.observationId,
      label: entry.label,
      value: entry.value,
      recordedAt: entry.recordedAt,
      reviewerHash: createHash('sha256').update(entry.reviewer).digest('hex').slice(0, 16),
      snapshot: serializeCalibrationSnapshotCore(entry.snapshot),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
  const responseFramePayload = [...responseFrame.targets.values()]
    .map(target => ({
      observationId: target.observationId,
      selectionStatus: target.selectionStatus,
      samplingProbability: target.samplingProbability,
      generatedAt: target.generatedAt,
      salienceScore: target.salienceScore,
      evidenceScore: target.evidenceScore,
      candidatePopulationCount: target.candidatePopulationCount,
    }))
    .sort((left, right) =>
      left.observationId.localeCompare(right.observationId, 'en'))
  return createHash('sha256').update(JSON.stringify({
    labels: labelPayload,
    responseFrame: {
      targets: responseFramePayload,
      invalidCaptureBundles: responseFrame.invalidCaptureBundles,
    },
  })).digest('hex')
}

export function evaluateBrainCalibration(
  vault: Vault,
  options: BrainCalibrationEvaluationOptions = {},
): BrainCalibrationEvaluationResult {
  const dataset = readBrainCalibrationDataset(vault)
  const groupBy = options.groupBy ?? 'session'
  if (groupBy !== 'session' && groupBy !== 'project') {
    throw new Error('groupBy muss session oder project sein')
  }
  const bootstrapSamples = options.bootstrapSamples
    ?? BRAIN_CALIBRATION_HOLDOUT_POLICY.defaultBootstrapSamples
  if (
    !Number.isInteger(bootstrapSamples)
    || bootstrapSamples < 100
    || bootstrapSamples > 5_000
  ) {
    throw new Error('bootstrapSamples muss eine Ganzzahl zwischen 100 und 5000 sein')
  }
  const requested = options.label ?? 'all'
  if (!['all', 'useful', 'supported'].includes(requested)) {
    throw new Error('label muss all, useful oder supported sein')
  }
  const labels: BrainCalibrationEvaluationLabel[] = requested === 'all'
    ? ['useful', 'supported']
    : [requested]
  const responseFrame = collectEvaluationResponseFrame(vault)
  const fingerprint = dataFingerprint(dataset.entries, responseFrame)
  const reports = labels.map(label =>
    evaluateLabel(
      dataset.entries,
      label,
      groupBy,
      bootstrapSamples,
      responseFrame,
      fingerprint,
    ))
  const runId = `ce-${createHash('sha256').update(JSON.stringify({
    evaluationVersion: BRAIN_CALIBRATION_EVALUATION_VERSION,
    fingerprint,
    groupBy,
    bootstrapSamples,
    labels,
  })).digest('hex').slice(0, 24)}`
  return {
    evaluationVersion: BRAIN_CALIBRATION_EVALUATION_VERSION,
    runId,
    generatedAt: new Date().toISOString(),
    dataFingerprint: fingerprint,
    reports,
    stillValid: requested === 'all' ? validityDiagnostic(dataset.entries) : null,
    activeWeightsChanged: false,
    releaseDecisionAllowed: false,
    limitations: [
      'Nur menschlich gelabelte Evaluationsstichproben gehen in den Fit ein; inverse Ziehungswahrscheinlichkeiten werden als Hájek-IPW berücksichtigt.',
      'Response-Coverage wird insgesamt, in der Holdout-Ära und nach Auswahl-, Score- und Kandidatenpopulations-Strata IPW-gewichtet gegen aktuell indexierte, attestierte Captures geprüft; gelöschte oder nicht indexierte Captures bleiben außerhalb dieses Denominators.',
      'MNAR ist nicht punktidentifizierbar; ΔBrier erhält deshalb zusätzlich eine konservative Worst-Case-Identifikationsgrenze für alle fehlenden Holdout-Labels.',
      'Ordinale Produktionsscores werden ausschließlich auf Trainingsdaten monoton in Wahrscheinlichkeiten kalibriert.',
      'Leakage-Gruppen, die den zeitlichen Cutoff überspannen, werden embargoed; Train liegt garantiert strikt vor Test.',
      'Der Cluster-Bootstrap hält den Trainingsfit fest; Refit-/Nested-CV-Unsicherheit ist noch nicht enthalten.',
      'Der einsehbare Shadow-Holdout kann ausschließlich einen Kandidaten für eine spätere präregistrierte Validierung nominieren; er erteilt niemals eine Release-Freigabe.',
      'Mehrfachreviews werden pro Beobachtung mehrheitlich aggregiert; Gleichstände führen zu Abstention.',
      'still_valid ist wegen intervallzensierter Invalidierungszeiten noch kein Survival-Modell.',
    ],
  }
}
