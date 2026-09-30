/**
 * Replay CLI — measure the pod's sleep tracking against Apple Watch nights
 * (docs/sleep-tracking-plan.md, A0.4).
 *
 *   pnpm replay fetch --pod <host|url> [--out .replay] [--limit 30] [--side left|right] [--raw] [--force]
 *   pnpm replay score [--dir .replay] [--save <report.json>] [--baseline <report.json>] [--json]
 *
 * `fetch` pulls replay bundles (and with --raw the nights' raw frames) over
 * the pod's LAN API; `score` re-stages them with this working tree and
 * prints agreement with the watch. `.replay/` holds personal health data and
 * is gitignored — never commit it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fetchCorpus } from './fetch'
import { formatReport } from './format'
import { parseReport, scoreCorpus } from './score'

export interface ParsedArgs {
  command: string | null
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = null, ...rest] = argv
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) flags[key] = inline
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[key] = rest[++i]
    else flags[key] = true
  }
  return { command, flags }
}

const USAGE = `Usage:
  pnpm replay fetch --pod <host|url> [--out .replay] [--limit 30] [--side left|right] [--raw] [--force]
  pnpm replay score [--dir .replay] [--save <report.json>] [--baseline <report.json>] [--json]`

function str(flags: ParsedArgs['flags'], key: string, fallback?: string): string | undefined {
  const v = flags[key]
  if (v === true) throw new Error(`--${key} needs a value`)
  return v ?? fallback
}

function gitRef(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
    return dirty ? `${sha}+dirty` : sha
  }
  catch {
    return null
  }
}

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const { command, flags } = parseArgs(argv)
  if (command === 'fetch') {
    const pod = str(flags, 'pod', process.env.SLEEPYPOD_POD)
    if (!pod) throw new Error('--pod <host|url> is required (or set SLEEPYPOD_POD)')
    const side = str(flags, 'side')
    if (side !== undefined && side !== 'left' && side !== 'right') throw new Error('--side must be left or right')
    const limit = Number(str(flags, 'limit', '30'))
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100')
    const result = await fetchCorpus({
      pod,
      out: str(flags, 'out', '.replay') as string,
      limit,
      side,
      raw: flags.raw === true,
      force: flags.force === true,
      log: out,
    })
    out(`Saved ${result.bundles.length} bundle(s)${flags.raw ? ` and ${result.raw.length} raw archive(s)` : ''}.`)
    return 0
  }
  if (command === 'score') {
    const report = scoreCorpus(str(flags, 'dir', '.replay') as string, gitRef())
    const baselinePath = str(flags, 'baseline')
    const baseline = baselinePath ? parseReport(readFileSync(baselinePath, 'utf8')) : undefined
    const savePath = str(flags, 'save')
    if (savePath) writeFileSync(savePath, JSON.stringify(report, null, 2) + '\n')
    out(flags.json ? JSON.stringify(report, null, 2) : formatReport(report, baseline))
    return 0
  }
  out(USAGE)
  return command === null || command === 'help' ? 0 : 1
}

// Run when executed directly (tsx scripts/replay/cli.ts …), not when imported by tests.
if (process.argv[1] && /replay[\\/]cli\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    (error: unknown) => {
      console.error(`replay: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    },
  )
}
