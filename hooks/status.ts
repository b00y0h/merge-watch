// Shared status helpers: icons and words for every CI state, rollups, sorting, concurrency.

import type { MergeWatchCiState, MergeWatchJob, MergeWatchPipeline, MergeWatchRequest } from '../types'

/** Each state has an icon and a word, so status reads without colour. */
export const STATE_ICON: Record<MergeWatchCiState, string> = {
  passed: '✓',
  warning: '⚠',
  failed: '✕',
  running: '▶',
  pending: '○',
  manual: '◆',
  blocked: '⊘',
  skipped: '–',
  cancelled: '⊗',
  'no-pipeline': '·',
  'no-checks': '·',
  unknown: '?',
  unavailable: '!',
}

export const STATE_WORD: Record<MergeWatchCiState, string> = {
  passed: 'Passed',
  warning: 'Passed with warnings',
  failed: 'Failed',
  running: 'Running',
  pending: 'Pending',
  manual: 'Manual',
  blocked: 'Blocked',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  'no-pipeline': 'No pipeline',
  'no-checks': 'No checks',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
}

/** Theme colour per state; the icon and word carry the meaning on their own. */
export const STATE_COLOR: Record<MergeWatchCiState, string | undefined> = {
  passed: 'success',
  warning: 'warning',
  failed: 'error',
  running: 'suggestion',
  pending: undefined,
  manual: 'permission',
  blocked: 'warning',
  skipped: undefined,
  cancelled: undefined,
  'no-pipeline': undefined,
  'no-checks': undefined,
  unknown: 'warning',
  unavailable: 'warning',
}

// Higher wins when several results roll up into one.
const SEVERITY: Record<MergeWatchCiState, number> = {
  failed: 100,
  unavailable: 90,
  unknown: 85,
  blocked: 80,
  running: 70,
  pending: 60,
  manual: 50,
  cancelled: 45,
  warning: 30,
  passed: 20,
  skipped: 10,
  'no-checks': 5,
  'no-pipeline': 4,
}

export function job(
  id: string,
  name: string,
  state: MergeWatchCiState,
  options: { label?: string; isAllowedFailure?: boolean; url?: string | null; stage?: string | null } = {},
): MergeWatchJob {
  return {
    id,
    name,
    state,
    label: options.label ?? STATE_WORD[state],
    isAllowedFailure: options.isAllowedFailure ?? false,
    url: options.url ?? null,
    stage: options.stage ?? null,
  }
}

/**
 * The overall state of several pipelines/check groups. A failed job that is allowed to fail
 * does not fail the rollup, and nothing missing ever becomes Passed.
 */
export function rollup(pipelines: readonly MergeWatchPipeline[]): MergeWatchCiState {
  if (pipelines.length === 0) {
    return 'unknown'
  }

  let worst: MergeWatchCiState = pipelines[0]!.state

  for (const p of pipelines) {
    const state = p.isPreviousRevision ? 'unknown' : p.isIncomplete && p.state === 'passed' ? 'unknown' : p.state

    if (SEVERITY[state] > SEVERITY[worst]) {
      worst = state
    }
  }

  return worst
}

/** Rolls jobs up into a state for a group that has no overall status of its own (GitHub checks). */
export function rollupJobs(jobs: readonly MergeWatchJob[]): MergeWatchCiState {
  if (jobs.length === 0) {
    return 'no-checks'
  }

  let worst: MergeWatchCiState = 'skipped'
  let hasAllowedFailure = false

  for (const j of jobs) {
    if (j.state === 'failed' && j.isAllowedFailure) {
      hasAllowedFailure = true
      continue
    }

    // A manual job that is optional does not hold the group.
    const state: MergeWatchCiState = j.state === 'manual' && !j.label.includes('blocking') ? 'skipped' : j.state

    if (SEVERITY[state] > SEVERITY[worst]) {
      worst = state
    }
  }

  if (worst === 'skipped' && jobs.every(j => j.state === 'skipped' || j.state === 'manual')) {
    return 'skipped'
  }

  return hasAllowedFailure && worst === 'passed' ? 'warning' : worst
}

export function ciLabel(state: MergeWatchCiState, pipelines: readonly MergeWatchPipeline[]): string {
  if (pipelines.some(p => p.isPreviousRevision) && pipelines.every(p => p.isPreviousRevision)) {
    return 'Previous revision only'
  }

  return STATE_WORD[state]
}

/** Most recently updated first; the request number breaks ties so the order never flickers. */
export function sortRequests(requests: readonly MergeWatchRequest[]): MergeWatchRequest[] {
  return [...requests].sort((a, b) => {
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)

    if (Number.isFinite(byTime) && byTime !== 0) {
      return byTime
    }

    return b.number - a.number
  })
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await fn(items[index]!, index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))

  return out
}

/** Thrown by an adapter when the provider asks us to slow down. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/** Thrown by an adapter when no usable credential exists; `help` is shown as setup instructions. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly help: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * The jobs worth a row of their own: whatever is running, failed (allowed failures too),
 * blocked, cancelled-out-of-reach or unknown, and manual jobs that hold the pipeline.
 * Passed, pending, skipped and optional manual jobs are only counted.
 */
export function jobsNeedingAttention(jobs: readonly MergeWatchJob[]): MergeWatchJob[] {
  return jobs.filter(
    j =>
      j.state === 'failed' ||
      j.state === 'running' ||
      j.state === 'blocked' ||
      j.state === 'unknown' ||
      j.state === 'unavailable' ||
      (j.state === 'manual' && j.label.includes('blocking')),
  )
}

const COUNT_ORDER: readonly MergeWatchCiState[] = ['passed', 'warning', 'failed', 'running', 'pending', 'manual', 'blocked', 'skipped', 'cancelled', 'unknown', 'unavailable']

/** "26 passed · 1 failed · 3 pending": every job counted, in a fixed order, zeros left out. */
export function jobCounts(jobs: readonly MergeWatchJob[]): string {
  const counts = new Map<MergeWatchCiState, number>()

  for (const j of jobs) {
    counts.set(j.state, (counts.get(j.state) ?? 0) + 1)
  }

  return COUNT_ORDER.filter(s => (counts.get(s) ?? 0) > 0)
    .map(s => `${counts.get(s)} ${STATE_WORD[s].toLowerCase()}`)
    .join(' · ')
}
