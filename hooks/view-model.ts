// What the redesigned pane shows for each request: its group, cleaned title, reason line,
// pipeline mix and failure lists. Pure functions over the shared display model.

import type { MergeWatchJob, MergeWatchPipeline, MergeWatchRequest } from '../types'

export type Group = 'ready' | 'failing' | 'draft'

export const GROUP_ORDER: readonly Group[] = ['ready', 'failing', 'draft']

export const GROUP_LABEL: Record<Group, string> = {
  ready: 'READY TO MERGE',
  failing: 'PIPELINE FAILING',
  draft: 'DRAFTS',
}

/** Requests not updated for this long are hidden until "show all". */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/** How many real failures the expanded table lists before "+N more failed". */
export const FAILURES_SHOWN = 5

function flatten(pipelines: readonly MergeWatchPipeline[]): MergeWatchPipeline[] {
  return pipelines.flatMap(p => [p, ...flatten(p.children)])
}

/** Jobs of the current revision only: a previous revision's results never count. */
export function currentJobs(r: MergeWatchRequest): MergeWatchJob[] {
  return flatten(r.ci.pipelines)
    .filter(p => !p.isPreviousRevision)
    .flatMap(p => p.jobs)
}

export function realFailures(r: MergeWatchRequest): MergeWatchJob[] {
  return currentJobs(r).filter(j => j.state === 'failed' && !j.isAllowedFailure)
}

export function allowedFailures(r: MergeWatchRequest): MergeWatchJob[] {
  return currentJobs(r).filter(j => j.state === 'failed' && j.isAllowedFailure)
}

const PASSING_CI = new Set(['passed', 'warning', 'no-pipeline', 'no-checks', 'skipped'])

/**
 * Drafts are drafts whatever their pipeline. Ready means the provider says mergeable and the
 * pipeline passed ("passed with warnings" counts). Everything else is failing, including a
 * pipeline that is still running or a request that is waiting for approval.
 */
export function groupOf(r: MergeWatchRequest): Group {
  if (r.isDraft) {
    return 'draft'
  }

  return r.readiness === 'Ready to merge' && PASSING_CI.has(r.ci.state) && r.staleSince === null ? 'ready' : 'failing'
}

/** "feat(design-importer): source-agnostic …" → "source-agnostic …"; also drops "Draft:". */
export function stripPrefix(title: string): string {
  const stripped = title
    .replace(/^\s*(?:draft|wip)\s*:\s*/i, '')
    .replace(/^\s*\[(?:draft|wip)\]\s*/i, '')
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s+/i, '')
    .trim()

  return stripped === '' ? title : stripped
}

/** The coloured line under a title: why it is in its group, in a few words. */
export function reasonLine(r: MergeWatchRequest): string {
  const group = groupOf(r)
  const allowed = allowedFailures(r).length
  const allowedText = allowed === 0 ? '' : `${allowed} allowed failure${allowed === 1 ? '' : 's'}`

  if (r.error !== null && r.staleSince === null) {
    return `! details unavailable: ${r.error}`
  }

  if (group === 'ready') {
    const parts = [r.needsReview ? 'needs review' : '', allowedText].filter(Boolean)

    return `✓ ${parts.length === 0 ? 'ready' : parts.join(' · ')}`
  }

  const failed = realFailures(r)

  if (failed.length > 5) {
    const names = failed.slice(0, 3).map(j => j.name)

    return `✕ ${failed.length} jobs failing — ${names.join(', ')}…`
  }

  if (failed.length > 0) {
    return `✕ ${failed.map(j => j.name).join(', ')}`
  }

  if (r.ci.pipelines.some(p => p.isPreviousRevision) && r.ci.pipelines.every(p => p.isPreviousRevision)) {
    return '↺ pipeline is for a previous revision'
  }

  const running = currentJobs(r).filter(j => j.state === 'running')

  if (r.ci.state === 'running' || running.length > 0) {
    return `▶ running${running.length > 0 ? ` — ${running.map(j => j.name).join(', ')}` : ''}`
  }

  if (r.ci.state === 'pending') {
    return '○ pipeline pending'
  }

  if (r.ci.state === 'unknown' || r.ci.state === 'unavailable') {
    return `? ${r.ci.label.toLowerCase()}`
  }

  const why = r.blockers.length > 0 ? r.blockers.join(' · ') : r.readiness

  return `· ${why.charAt(0).toLowerCase()}${why.slice(1)}`
}

export type JobMix = { passed: number; failed: number; allowed: number; manual: number; other: number }

/** Counts for the mini pipeline bar. */
export function jobMix(r: MergeWatchRequest): JobMix {
  const mix: JobMix = { passed: 0, failed: 0, allowed: 0, manual: 0, other: 0 }

  for (const j of currentJobs(r)) {
    if (j.state === 'passed' || j.state === 'warning') {
      mix.passed += 1
    } else if (j.state === 'failed') {
      mix[j.isAllowedFailure ? 'allowed' : 'failed'] += 1
    } else if (j.state === 'manual') {
      mix.manual += 1
    } else {
      mix.other += 1
    }
  }

  return mix
}

/** Splits `cells` among the mix's segments in proportion; every non-empty segment gets at least one cell. */
export function splitCells(mix: JobMix, cells: number): JobMix {
  const keys: (keyof JobMix)[] = ['passed', 'failed', 'allowed', 'manual', 'other']
  const total = keys.reduce((n, k) => n + mix[k], 0)
  const out: JobMix = { passed: 0, failed: 0, allowed: 0, manual: 0, other: 0 }

  if (total === 0) {
    out.other = cells

    return out
  }

  let used = 0

  for (const k of keys) {
    out[k] = mix[k] === 0 ? 0 : Math.max(1, Math.floor((mix[k] / total) * cells))
    used += out[k]
  }

  // Give or take the rounding difference on the largest segment.
  const largest = keys.reduce((a, b) => (out[b] > out[a] ? b : a))
  out[largest] = Math.max(1, out[largest] + cells - used)

  return out
}

/** "#1470130 · 35 passed · 2 failed · 8 manual" for the head pipeline. */
export function pipelineSummary(p: MergeWatchPipeline, counts: string): string {
  const id = /#\d+/.exec(p.title)?.[0] ?? p.title

  return counts === '' ? id : `${id} · ${counts}`
}

export function isStale(r: MergeWatchRequest, now: number): boolean {
  const t = Date.parse(r.updatedAt)

  return Number.isFinite(t) && now - t > STALE_AFTER_MS
}
