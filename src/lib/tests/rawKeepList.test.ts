import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archiveDir,
  DEFAULT_ARCHIVE_DIR,
  formatKeepList,
  KEEP_LIST_NAME,
  KEEP_PAD_AFTER_MS,
  KEEP_PAD_BEFORE_MS,
  writeKeepList,
} from '../rawKeepList'

describe('formatKeepList', () => {
  it('writes a comment header and one padded window per line in epoch seconds', () => {
    const text = formatKeepList([
      { start: 1_000_000_000_500, end: 1_000_028_800_500 },
      { start: 2_000_000_000_000, end: 2_000_000_000_000 },
    ])
    const [header, ...lines] = text.split('\n')
    expect(header.startsWith('# ')).toBe(true)
    // Start rounds down and end rounds up, so padding never shrinks a window.
    expect(lines).toEqual([
      `${Math.floor((1_000_000_000_500 - KEEP_PAD_BEFORE_MS) / 1000)} ${Math.ceil((1_000_028_800_500 + KEEP_PAD_AFTER_MS) / 1000)}`,
      `${(2_000_000_000_000 - KEEP_PAD_BEFORE_MS) / 1000} ${(2_000_000_000_000 + KEEP_PAD_AFTER_MS) / 1000}`,
      '',
    ])
    expect(lines[0]).toBe('999998200 1000031501')
  })

  it('writes only the header for no windows', () => {
    expect(formatKeepList([]).split('\n').filter(l => l && !l.startsWith('#'))).toEqual([])
  })
})

describe('writeKeepList', () => {
  let dir: string
  const original = process.env.BIOMETRICS_ARCHIVE_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-list-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (original === undefined) Reflect.deleteProperty(process.env, 'BIOMETRICS_ARCHIVE_DIR')
    else process.env.BIOMETRICS_ARCHIVE_DIR = original
  })

  it('replaces the file and leaves no temp file behind', () => {
    expect(writeKeepList([{ start: 0, end: 1000 }], dir)).toBe(true)
    expect(writeKeepList([], dir)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([KEEP_LIST_NAME])
    expect(fs.readFileSync(path.join(dir, KEEP_LIST_NAME), 'utf8')).toBe(formatKeepList([]))
  })

  it('returns false and writes nothing when the directory is missing', () => {
    expect(writeKeepList([{ start: 0, end: 1 }], path.join(dir, 'nope'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'nope'))).toBe(false)
  })

  it('defaults to BIOMETRICS_ARCHIVE_DIR, then the pod path', () => {
    process.env.BIOMETRICS_ARCHIVE_DIR = dir
    expect(archiveDir()).toBe(dir)
    expect(writeKeepList([])).toBe(true)
    expect(fs.existsSync(path.join(dir, KEEP_LIST_NAME))).toBe(true)
    process.env.BIOMETRICS_ARCHIVE_DIR = ''
    expect(archiveDir()).toBe(DEFAULT_ARCHIVE_DIR)
  })
})
