/**
 * Minimal tRPC-over-HTTP query client for the pod (no batching): the replay
 * CLI only needs a couple of GET queries, and taking `fetch` as a parameter
 * lets tests route requests straight into a tRPC fetch handler.
 */
import superjson from 'superjson'

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export class PodRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'PodRequestError'
  }
}

/** Base URL without a trailing slash; a bare host gets `http://` and port 3000. */
export function normalizePodUrl(pod: string): string {
  const trimmed = pod.trim().replace(/\/+$/, '')
  if (/^https?:\/\//.test(trimmed)) return trimmed
  return trimmed.includes(':') ? `http://${trimmed}` : `http://${trimmed}:3000`
}

export function createPodClient(pod: string, fetchImpl: FetchImpl = fetch) {
  const base = normalizePodUrl(pod)
  return {
    base,
    async query<T>(procedure: string, input: unknown): Promise<T> {
      const url = `${base}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`
      const res = await fetchImpl(url)
      const body = await res.json().catch(() => null) as
        | { result?: { data?: Parameters<typeof superjson.deserialize>[0] }, error?: { json?: { message?: string } } }
        | null
      if (!res.ok || !body?.result?.data) {
        const message = body?.error?.json?.message ?? `HTTP ${res.status}`
        throw new PodRequestError(`${procedure}: ${message}`, res.status)
      }
      return superjson.deserialize<T>(body.result.data)
    },
  }
}
