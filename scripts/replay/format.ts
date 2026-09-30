/** Plain-text rendering of a replay score report, optionally against a baseline. */
import { STAGE_ORDER } from '@/src/lib/sleepStaging/agreement'
import type { ScoreReport } from './score'

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)
const num = (x: number | null, digits = 2) => (x === null ? '—' : x.toFixed(digits))
const signedMin = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${Math.round(x)}m`)

/** ` (+0.03)`-style change against a baseline value; empty without one. */
function delta(now: number | null, before: number | null | undefined, scale = 1, digits = 2, unit = ''): string {
  if (now === null || before === null || before === undefined) return ''
  const d = (now - before) * scale
  return ` (${d >= 0 ? '+' : ''}${d.toFixed(digits)}${unit})`
}

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
}

export function formatReport(report: ScoreReport, baseline?: ScoreReport): string {
  const p = report.pooled
  const b = baseline?.pooled
  const lines: string[] = []
  const models = `${p.modelNights} model, ${p.nights - p.modelNights} rules`
  lines.push(`Replay score — ${p.nights} night(s) (${models})${report.gitRef ? ` at ${report.gitRef}` : ''}`)
  if (baseline) lines.push(`Baseline: ${baseline.nights.length} night(s)${baseline.gitRef ? ` at ${baseline.gitRef}` : ''}`)
  lines.push('')

  const header = ['Night', 'Method', 'Sleep/wake', 'κ (4)', 'κ Δ', 'Total sleep Δ', 'Beat HR cov', 'HR MAE', 'Beats matched', 'IBI RMSE']
  const widths = [24, 6, 10, 6, 6, 13, 11, 6, 13, 8]
  lines.push(pad(header, widths))
  const baseById = new Map(baseline?.nights.map(n => [n.referenceNightId, n]) ?? [])
  for (const n of report.nights) {
    const a = n.agreement
    const before = baseById.get(n.referenceNightId)?.agreement
    lines.push(pad([
      n.name,
      a.method,
      pct(a.stages.sleepWakeAccuracy),
      num(a.stages.kappa),
      before ? delta(a.stages.kappa, before.stages.kappa).replace(/[()\s]/g, '') || '—' : '',
      signedMin(a.window.totalSleepDiffMin),
      pct(a.heart.beatHrCoverage),
      num(a.heart.beatHrMaeBpm, 1),
      pct(a.beatTiming.matchedShare),
      a.beatTiming.ibiRmseMs === null ? '—' : `${a.beatTiming.ibiRmseMs.toFixed(0)} ms`,
    ], widths))
  }

  lines.push('')
  lines.push('Pooled')
  lines.push(`  Stages       accuracy ${pct(p.stages.accuracy)}${delta(p.stages.accuracy, b?.stages.accuracy, 100, 1, 'pt')}`
    + `  κ ${num(p.stages.kappa)}${delta(p.stages.kappa, b?.stages.kappa)}`
    + `  sleep/wake ${pct(p.stages.sleepWakeAccuracy)}${delta(p.stages.sleepWakeAccuracy, b?.stages.sleepWakeAccuracy, 100, 1, 'pt')}`
    + ` (κ ${num(p.stages.sleepWakeKappa)}${delta(p.stages.sleepWakeKappa, b?.stages.sleepWakeKappa)})`)
  const minutes = (m: Record<string, number>) => STAGE_ORDER.map(s => `${s} ${Math.round(m[s])}`).join(' ')
  lines.push(`  Minutes      pod   ${minutes(p.stages.podMinutesPerNight)}  (per night)`)
  lines.push(`               watch ${minutes(p.stages.refMinutesPerNight)}`)
  lines.push(`  Window MAE   onset ${num(p.window.onsetMaeMin, 0)}m  final wake ${num(p.window.finalWakeMaeMin, 0)}m`
    + `  total sleep ${num(p.window.totalSleepMaeMin, 0)}m${delta(p.window.totalSleepMaeMin, b?.window.totalSleepMaeMin, 1, 0, 'm')}`
    + `  wake after onset ${num(p.window.wasoMaeMin, 0)}m`)
  lines.push(`  Heart rate   beat HR for ${pct(p.heart.beatHrCoverage)} of ${p.heart.readings} watch readings${delta(p.heart.beatHrCoverage, b?.heart.beatHrCoverage, 100, 1, 'pt')}`
    + `, MAE ${num(p.heart.beatHrMaeBpm, 1)} bpm${delta(p.heart.beatHrMaeBpm, b?.heart.beatHrMaeBpm, 1, 1)}`
    + `, within 5 bpm ${pct(p.heart.beatHrWithin5Share)}; vitals HR MAE ${num(p.heart.vitalsHrMaeBpm, 1)} bpm`)
  lines.push(`  Beats        matched ${pct(p.beatTiming.matchedShare)} of ${p.beatTiming.watchBeats} watch beats${delta(p.beatTiming.matchedShare, b?.beatTiming.matchedShare, 100, 1, 'pt')}`
    + `, IBI RMSE ${num(p.beatTiming.ibiRmseMs, 0)} ms${delta(p.beatTiming.ibiRmseMs, b?.beatTiming.ibiRmseMs, 1, 0, ' ms')}`
    + `, SDNN Δ ${num(p.beatTiming.sdnnMeanDiffMs, 0)} ms (|Δ| ${num(p.beatTiming.sdnnMeanAbsDiffMs, 0)} ms)`)
  return lines.join('\n')
}
