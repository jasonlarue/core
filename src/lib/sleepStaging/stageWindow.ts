/**
 * Stage one in-bed window the way `biometrics.getSleepStages` does: the
 * heart-rhythm model when it can score the night, else the rule-based stager.
 * Shared by the endpoint, the replay CLI (scripts/replay) and the reference
 * scoring, so they can never disagree about which path ran.
 */
import { classifySleepStages, type SleepEpoch } from '@/src/lib/sleep-stages'
import { stageNight, type StageNightInput } from './stageNight'

export interface StageWindowInput extends Omit<StageNightInput, 'vitals'> {
  vitals: Array<{
    timestamp: Date
    heartRate: number | null
    hrv: number | null
    breathingRate: number | null
  }>
}

export interface StagedWindow {
  epochs: SleepEpoch[]
  method: 'model' | 'rules'
  /** Why the rule-based stager ran; null when the model did. */
  fallbackReason: 'profile' | 'coverage' | null
}

export function stageWindow(input: StageWindowInput): StagedWindow {
  const staged = stageNight(input)
  if (staged.ok) return { epochs: staged.epochs, method: 'model', fallbackReason: null }
  return {
    epochs: classifySleepStages(input.vitals, input.movement),
    method: 'rules',
    fallbackReason: staged.reason,
  }
}
