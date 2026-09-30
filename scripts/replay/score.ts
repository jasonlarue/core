/**
 * `replay score`: re-stage every fetched bundle with the working tree's code
 * and score it against its reference night (src/lib/sleepStaging/agreement.ts).
 * The report is plain JSON so it can be saved as a baseline and diffed, or
 * shared by volunteers without any health data in it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  poolAgreement,
  scoreNight,
  type NightAgreement,
  type PooledAgreement,
} from '@/src/lib/sleepStaging/agreement'
import { podNightFromBundle, replayBundleSchema } from '@/src/lib/sleepStaging/replayBundle'

export const REPORT_VERSION = 1

export interface NightResult {
  /** Bundle file name without `.json` (`<local date>-<side>-<id>`). */
  name: string
  referenceNightId: number
  side: 'left' | 'right'
  agreement: NightAgreement
}

export interface ScoreReport {
  version: typeof REPORT_VERSION
  generatedAt: string
  gitRef: string | null
  nights: NightResult[]
  pooled: PooledAgreement
}

export function scoreCorpus(dir: string, gitRef: string | null = null): ScoreReport {
  const nightsDir = join(dir, 'nights')
  if (!existsSync(nightsDir)) throw new Error(`no bundles in ${nightsDir} — run \`pnpm replay fetch --pod <host>\` first`)
  const files = readdirSync(nightsDir).filter(f => f.endsWith('.json')).sort()
  const nights: NightResult[] = files.map((file) => {
    const bundle = replayBundleSchema.parse(JSON.parse(readFileSync(join(nightsDir, file), 'utf8')))
    return {
      name: file.replace(/\.json$/, ''),
      referenceNightId: bundle.reference.id,
      side: bundle.reference.side,
      agreement: scoreNight(podNightFromBundle(bundle), bundle.reference),
    }
  })
  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    gitRef,
    nights,
    pooled: poolAgreement(nights.map(n => n.agreement)),
  }
}

export function parseReport(text: string): ScoreReport {
  const report = JSON.parse(text) as ScoreReport
  if (report.version !== REPORT_VERSION || !Array.isArray(report.nights) || !report.pooled) {
    throw new Error('not a replay score report (version 1)')
  }
  return report
}
