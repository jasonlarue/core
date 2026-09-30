/**
 * `replay fetch`: pull every stored reference night from the pod as a replay
 * bundle (biometrics.getReplayBundle) into `<out>/nights/`, and optionally the
 * raw frames for each night's window (the pod's /api/export/archive tarball)
 * into `<out>/raw/`, for reprocessing. Everything goes over the pod's LAN API.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { KEEP_PAD_AFTER_MS, KEEP_PAD_BEFORE_MS } from '@/src/lib/rawKeepList'
import { replayBundleSchema, type ReplayBundle } from '@/src/lib/sleepStaging/replayBundle'
import { createPodClient, PodRequestError, type FetchImpl } from './client'

export interface FetchOptions {
  pod: string
  out: string
  limit: number
  side?: 'left' | 'right'
  raw: boolean
  /** Re-download raw tarballs that already exist. */
  force?: boolean
  fetchImpl?: FetchImpl
  /** Waits between retries of a busy export (the pod runs one at a time). */
  retryDelayMs?: number
  log?: (line: string) => void
}

export interface FetchResult {
  bundles: string[]
  raw: string[]
}

/** `<local date>-<side>-<id>`, e.g. `2026-09-28-left-3`. */
export function bundleName(bundle: ReplayBundle): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: bundle.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(bundle.window.start))
  return `${date}-${bundle.reference.side}-${bundle.reference.id}`
}

/** The export-archive query for a bundle's window, padded like the keep-list. */
export function rawArchiveUrl(base: string, bundle: ReplayBundle): string {
  const startTs = Math.floor((bundle.window.start - KEEP_PAD_BEFORE_MS) / 1000)
  const endTs = Math.ceil((bundle.window.end + KEEP_PAD_AFTER_MS) / 1000)
  return `${base}/api/export/archive?startTs=${startTs}&endTs=${endTs}&include=raw`
}

async function downloadRaw(url: string, dest: string, fetchImpl: FetchImpl, retryDelayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url)
    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, retryDelayMs))
      continue
    }
    if (!res.ok || !res.body) throw new PodRequestError(`raw export: HTTP ${res.status}`, res.status)
    const tmp = `${dest}.part`
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp))
    renameSync(tmp, dest)
    return
  }
}

export async function fetchCorpus(options: FetchOptions): Promise<FetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const client = createPodClient(options.pod, fetchImpl)
  const nightsDir = join(options.out, 'nights')
  const rawDir = join(options.out, 'raw')
  mkdirSync(nightsDir, { recursive: true })
  if (options.raw) mkdirSync(rawDir, { recursive: true })

  const nights = await client.query<Array<{ id: number }>>('biometrics.getReferenceNights', {
    ...(options.side ? { side: options.side } : {}),
    limit: options.limit,
  })
  log(`${nights.length} reference night(s) on ${client.base}`)

  const result: FetchResult = { bundles: [], raw: [] }
  for (const { id } of nights) {
    const bundle = replayBundleSchema.parse(await client.query('biometrics.getReplayBundle', { referenceNightId: id }))
    const name = bundleName(bundle)
    const file = join(nightsDir, `${name}.json`)
    writeFileSync(file, JSON.stringify(bundle) + '\n')
    result.bundles.push(file)

    let rawNote = ''
    if (options.raw) {
      const dest = join(rawDir, `${name}.tar.gz`)
      if (options.force || !existsSync(dest)) {
        await downloadRaw(rawArchiveUrl(client.base, bundle), dest, fetchImpl, options.retryDelayMs ?? 60_000)
        rawNote = ', raw frames'
      }
      else {
        rawNote = ', raw frames (kept)'
      }
      result.raw.push(dest)
    }
    const source = bundle.window.sleepRecordId === null ? 'no pod sleep record — using the watch span' : `sleep record ${bundle.window.sleepRecordId}`
    log(`  ${name}: ${source}, ${bundle.heartbeats.length} heartbeat chunk(s)${rawNote}`)
  }
  return result
}
