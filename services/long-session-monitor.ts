import type { BrainPolicy } from './policy.ts'
import type { SessionState } from './session-state.ts'

export interface LongSessionDecision {
  shouldCheckpoint: boolean
  reasons: string[]
  elapsedMinutes: number
  minutesSinceCheckpoint: number | null
  commandsSinceCheckpoint: number
}

function minutesBetween(left: string | null, right: Date): number | null {
  if (!left) return null
  const time = new Date(left).getTime()
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.floor((right.getTime() - time) / 60000))
}

export function evaluateLongSessionCheckpoint(state: SessionState, policy: BrainPolicy, now: Date = new Date()): LongSessionDecision {
  const during = policy.automation.duringSession
  const elapsedMinutes = minutesBetween(state.startedAt, now) ?? 0
  const minutesSinceCheckpoint = minutesBetween(state.lastCheckpointAt, now)
  const commandsSinceCheckpoint = Math.max(0, state.commandCount - state.lastCheckpointCommandCount)
  const reasons: string[] = []

  if (!during.autoCheckpoint) {
    return { shouldCheckpoint: false, reasons: ['auto checkpoint disabled by policy'], elapsedMinutes, minutesSinceCheckpoint, commandsSinceCheckpoint }
  }

  if (policy.automation.mode === 'off') {
    return { shouldCheckpoint: false, reasons: ['automation disabled by policy'], elapsedMinutes, minutesSinceCheckpoint, commandsSinceCheckpoint }
  }

  if (state.checkpointCount >= during.maxCheckpointsPerSession) {
    return { shouldCheckpoint: false, reasons: [`checkpoint limit reached (${state.checkpointCount}/${during.maxCheckpointsPerSession})`], elapsedMinutes, minutesSinceCheckpoint, commandsSinceCheckpoint }
  }

  if (minutesSinceCheckpoint !== null && minutesSinceCheckpoint < during.minMinutesBetweenCheckpoints) {
    return { shouldCheckpoint: false, reasons: [`debounce active (${minutesSinceCheckpoint}/${during.minMinutesBetweenCheckpoints} minutes)`], elapsedMinutes, minutesSinceCheckpoint, commandsSinceCheckpoint }
  }

  if (elapsedMinutes >= during.minMinutesBetweenCheckpoints) {
    reasons.push(`elapsed ${elapsedMinutes} minutes`)
  }
  if (commandsSinceCheckpoint >= during.minCommandsBetweenCheckpoints) {
    reasons.push(`${commandsSinceCheckpoint} commands since checkpoint`)
  }

  return {
    shouldCheckpoint: reasons.length > 0,
    reasons: reasons.length > 0 ? reasons : ['thresholds not reached'],
    elapsedMinutes,
    minutesSinceCheckpoint,
    commandsSinceCheckpoint,
  }
}
