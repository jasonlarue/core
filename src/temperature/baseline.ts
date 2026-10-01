import { parseExpression } from 'cron-parser'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { timeToDate } from '@/src/scheduler/timeUtils'
import type { TemperatureRequest } from './controller'

export interface WeeklyTarget {
  id: string
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
}

export type RecurringOccurrenceCache = Map<string, { startsAt: number, expiresAt: number }>

/** Use node-schedule's cron parser and timezone semantics for both engines. */
export function recurringTarget(rows: WeeklyTarget[], timezone: string, now: number, cache: RecurringOccurrenceCache = new Map()): TemperatureRequest | null {
  const activeKeys = new Set<string>()
  let latest: TemperatureRequest | null = null
  for (const row of rows) {
    const key = JSON.stringify([timezone, row.dayOfWeek, row.time])
    activeKeys.add(key)
    let occurrence = cache.get(key)
    if (!occurrence || now < occurrence.startsAt || now >= occurrence.expiresAt) {
      const [hour, minute] = row.time.split(':').map(Number)
      const cron = `${minute} ${hour} * * ${DAYS_OF_WEEK.indexOf(row.dayOfWeek)}`
      // Forward iteration matches node-schedule through missing/repeated DST
      // hours. cron-parser.prev() is not the inverse of next() in a spring gap.
      // Cache each weekly interval, not just the winning target for one minute:
      // recomputing hundreds of unchanged cron rows can saturate a Pod CPU.
      const occurrences = parseExpression(cron, { currentDate: new Date(now - 15 * 86_400_000), tz: timezone })
      let startsAt = occurrences.next().getTime()
      let expiresAt = occurrences.next().getTime()
      while (expiresAt <= now) {
        startsAt = expiresAt
        expiresAt = occurrences.next().getTime()
      }
      occurrence = { startsAt, expiresAt }
      cache.set(key, occurrence)
    }
    const { startsAt, expiresAt } = occurrence
    const candidate: TemperatureRequest = {
      id: row.id, source: 'schedule', temperature: row.temperature,
      startsAt, expiresAt, createdAt: startsAt, priority: 0,
    }
    if (!latest || startsAt > latest.startsAt || (startsAt === latest.startsAt && row.id < latest.id)) latest = candidate
  }
  for (const key of cache.keys()) {
    if (!activeKeys.has(key)) cache.delete(key)
  }
  return latest
}

/** Minutes before an alarm its temperature takes over, so the bed is there by wake time. */
export const ALARM_WARMUP_MIN = 30

export interface AlarmWarmup extends WeeklyTarget {
  /** The alarm's wake window (minutes); the warm-up covers it when longer. */
  wakeWindow: number
}

export type AlarmOccurrenceCache = Map<string, number>

/** Warm-up lead for an alarm: ALARM_WARMUP_MIN, or its wake window when longer. */
export function alarmWarmupMinutes(wakeWindow: number): number {
  return Math.max(ALARM_WARMUP_MIN, wakeWindow)
}

/**
 * Alarm temperatures in their warm-up. An alarm's temperature is a set point
 * at the alarm time, but the water needs a while to get there, so from
 * alarmWarmupMinutes before the next occurrence until the alarm it is
 * requested at priority 1, ahead of the night's schedule points. At the alarm
 * time the alarm's own set point takes over.
 */
export function alarmWarmupTargets(rows: AlarmWarmup[], timezone: string, now: number, cache: AlarmOccurrenceCache = new Map()): TemperatureRequest[] {
  const out: TemperatureRequest[] = []
  const activeKeys = new Set<string>()
  for (const row of rows) {
    const key = JSON.stringify([timezone, row.dayOfWeek, row.time])
    activeKeys.add(key)
    let alarmAt = cache.get(key)
    if (alarmAt === undefined || now >= alarmAt) {
      const [hour, minute] = row.time.split(':').map(Number)
      const cron = `${minute} ${hour} * * ${DAYS_OF_WEEK.indexOf(row.dayOfWeek)}`
      alarmAt = parseExpression(cron, { currentDate: new Date(now), tz: timezone }).next().getTime()
      cache.set(key, alarmAt)
    }
    const startsAt = alarmAt - alarmWarmupMinutes(row.wakeWindow) * 60_000
    if (now < startsAt) continue
    out.push({
      id: `alarm-warmup:${row.id.replace(/^alarm:/, '')}`, source: 'schedule', temperature: row.temperature,
      startsAt, expiresAt: alarmAt, createdAt: startsAt, priority: 1,
    })
  }
  for (const key of cache.keys()) {
    if (!activeKeys.has(key)) cache.delete(key)
  }
  return out
}

export interface SessionTarget {
  id: number
  startedAt: Date
  expiresAt: Date
  setPoints: Array<{ time: string, temperature: number }>
}

/** The first point applies immediately; subsequent points keep the session's original clock. */
export function sessionTarget(session: SessionTarget, timezone: string, now: number): TemperatureRequest | null {
  if (session.startedAt.getTime() > now || session.expiresAt.getTime() <= now || !session.setPoints.length) return null
  let temperature = session.setPoints[0].temperature
  let lastPointAt = session.startedAt.getTime()
  for (const point of session.setPoints.slice(1)) {
    const at = timeToDate(point.time, timezone, session.startedAt).getTime()
    if (at <= now && at >= lastPointAt) {
      temperature = point.temperature
      lastPointAt = at
    }
  }
  return {
    id: `run-once:${session.id}`, source: 'run-once', temperature,
    startsAt: session.startedAt.getTime(), expiresAt: session.expiresAt.getTime(),
    createdAt: session.startedAt.getTime(), priority: 0,
  }
}
