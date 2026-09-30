/**
 * Raw-archive keep-list: pod-clock time windows whose gzipped RAW frames the
 * archive pruner (modules/biometrics-archiver/sleepypod-biometrics-pruner)
 * deletes last, so nights that have a reference recording can still be
 * replayed through the processors (docs/sleep-tracking-plan.md, A0.2).
 *
 * The pruner matches a frame by its archive mtime, which the archiver copies
 * from the frame's last write (its end). A ~15 min frame ending at mtime m
 * overlaps [start, end] when start <= m <= end + frame length, and archives
 * written before that fix carry the archive time instead (up to ~30 min
 * later), so each window is padded on both sides.
 *
 * File format, one window per line: `<startEpochSec> <endEpochSec>`; lines
 * starting with `#` are comments.
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Most recent reference nights whose frames are kept. */
export const RAW_KEEP_NIGHTS = 14
export const KEEP_PAD_BEFORE_MS = 30 * 60_000
export const KEEP_PAD_AFTER_MS = 45 * 60_000

export const DEFAULT_ARCHIVE_DIR = '/persistent/biometrics-archive'
export const KEEP_LIST_NAME = 'keep.list'

export interface KeepWindow {
  /** Pod-clock unix ms. */
  start: number
  end: number
}

export function formatKeepList(windows: KeepWindow[]): string {
  const lines = ['# Raw-archive windows kept for replay (written by sleepypod-core; see src/lib/rawKeepList.ts)']
  for (const w of windows) {
    const start = Math.floor((w.start - KEEP_PAD_BEFORE_MS) / 1000)
    const end = Math.ceil((w.end + KEEP_PAD_AFTER_MS) / 1000)
    lines.push(`${start} ${end}`)
  }
  return lines.join('\n') + '\n'
}

export function archiveDir(): string {
  return process.env.BIOMETRICS_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR
}

/**
 * Atomically replace the keep-list. Returns false (and writes nothing) when
 * the archive directory doesn't exist — dev machines and firmware without the
 * archiver module.
 */
export function writeKeepList(windows: KeepWindow[], dir: string = archiveDir()): boolean {
  if (!existsSync(dir)) return false
  const path = join(dir, KEEP_LIST_NAME)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, formatKeepList(windows))
  renameSync(tmp, path)
  return true
}
