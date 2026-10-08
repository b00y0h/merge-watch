// GitHub adapter: the documented REST API over the mods network API, mapped to the shared
// display model, plus the two write actions the pane offers after a confirm press.

import type { MergeWatchCiState, MergeWatchJob, MergeWatchPipeline, MergeWatchRepo, MergeWatchRequest } from '../types'
import { cleanError, cleanText, safeUrl } from './safe'
import { AuthError, RateLimitError, STATE_WORD, ciLabel, job, mapLimit, rollup, rollupJobs } from './status'

export type HttpResponse = { status: number; ok: boolean; headers: Record<string, string>; text: string }

/** Performs one GET with the given headers. The caller adds timeouts and the credential. */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>

/** Performs one request of any method; only the write actions use it. */
export type HttpSend = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>

type Json = Record<string, unknown>

const PR_CONCURRENCY = 4
const RELEVANT_EVENTS = new Set(['pull_request', 'pull_request_target', 'push', 'merge_group'])

function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

export function apiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`
}

export function authHelp(host: string): string {
  return (
    `Merge Watch needs a GitHub token for ${host} with read access to pull requests, checks, actions and commit statuses. ` +
    'Enter it in the plugin\'s github_token option (stored in your system keychain), or start Claude Code with GITHUB_TOKEN set in its environment. ' +
    'Never paste a token into the chat. Then run /merge-watch refresh.'
  )
}

/** The `rel="next"` URL of a Link header, if any. */
export function nextLink(header: string | undefined): string | null {
  if (header === undefined) {
    return null
  }

  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)

    if (match !== null) {
      return match[1]!
    }
  }

  return null
}

type Ctx = { repo: MergeWatchRepo; get: HttpGet; token: string; now: number }

async function request(ctx: Ctx, url: string): Promise<HttpResponse> {
  const response = await ctx.get(url, {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${ctx.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'merge-watch-claude-code-mod',
  })

  if (response.status === 401) {
    throw new AuthError(`GitHub rejected the token for ${ctx.repo.host}`, authHelp(ctx.repo.host))
  }

  const retryAfter = Number(response.headers['retry-after'])
  const remaining = response.headers['x-ratelimit-remaining']

  if (response.status === 429 || ((response.status === 403 || response.status === 429) && (remaining === '0' || Number.isFinite(retryAfter)))) {
    const reset = Number(response.headers['x-ratelimit-reset'])
    const retryAt = Number.isFinite(retryAfter) && retryAfter > 0
      ? ctx.now + retryAfter * 1000
      : Number.isFinite(reset) && reset > 0
        ? reset * 1000
        : ctx.now + 60_000

    throw new RateLimitError(`GitHub rate limit reached for ${ctx.repo.host}`, retryAt)
  }

  if (!response.ok) {
    let message = ''

    try {
      message = str(asRecord(JSON.parse(response.text)).message)
    } catch {
      message = ''
    }

    throw new Error(`GitHub answered ${response.status}${message === '' ? '' : `: ${cleanText(message, 120)}`}`)
  }

  return response
}

async function getJson(ctx: Ctx, url: string): Promise<unknown> {
  return JSON.parse((await request(ctx, url)).text)
}

/** Follows every `next` link; `field` names the list inside a wrapped response (check_runs, jobs, ...). */
async function getAll(ctx: Ctx, firstUrl: string, field?: string): Promise<Json[]> {
  const out: Json[] = []
  const seen = new Set<string>()
  const base = new URL(apiBase(ctx.repo.host))
  let url: string | null = firstUrl

  while (url !== null && !seen.has(url)) {
    seen.add(url)
    const response = await request(ctx, url)
    const body: unknown = JSON.parse(response.text)
    const items = field === undefined ? body : asRecord(body)[field]

    if (Array.isArray(items)) {
      out.push(...items.map(asRecord))
    }

    const next = nextLink(response.headers.link)
    // Only follow pages on the same API host.
    url = next !== null && new URL(next).host === base.host ? next : null
  }

  return out
}

/** A check run, Actions job or workflow run (all share status + conclusion) → shared state. */
export function mapCheckState(status: string, conclusion: string): { state: MergeWatchCiState; label: string } {
  if (status !== 'completed') {
    if (status === 'in_progress') {
      return { state: 'running', label: STATE_WORD.running }
    }

    if (status === 'queued' || status === 'requested' || status === 'waiting' || status === 'pending') {
      return { state: 'pending', label: status === 'waiting' ? 'Waiting' : status === 'queued' ? 'Queued' : STATE_WORD.pending }
    }

    return { state: 'unknown', label: STATE_WORD.unknown }
  }

  switch (conclusion) {
    case 'success':
      return { state: 'passed', label: STATE_WORD.passed }
    case 'failure':
      return { state: 'failed', label: STATE_WORD.failed }
    case 'timed_out':
      return { state: 'failed', label: 'Timed out' }
    case 'startup_failure':
      return { state: 'failed', label: 'Startup failure' }
    case 'cancelled':
      return { state: 'cancelled', label: STATE_WORD.cancelled }
    case 'skipped':
      return { state: 'skipped', label: STATE_WORD.skipped }
    case 'neutral':
      return { state: 'skipped', label: 'Neutral' }
    case 'action_required':
      return { state: 'blocked', label: 'Action required' }
    case 'stale':
      return { state: 'unknown', label: 'Stale' }
    default:
      return { state: 'unknown', label: STATE_WORD.unknown }
  }
}

export function mapCommitStatus(state: string): { state: MergeWatchCiState; label: string } {
  switch (state) {
    case 'success':
      return { state: 'passed', label: STATE_WORD.passed }
    case 'failure':
      return { state: 'failed', label: STATE_WORD.failed }
    case 'error':
      return { state: 'failed', label: 'Error' }
    case 'pending':
      return { state: 'pending', label: STATE_WORD.pending }
    default:
      return { state: 'unknown', label: STATE_WORD.unknown }
  }
}

/** Latest review per reviewer decides; comments alone do not change a decision. */
export function githubReview(detail: Json, reviews: readonly Json[] | null): string {
  if (reviews === null) {
    return 'Review status unavailable'
  }

  const latest = new Map<string, string>()

  for (const review of reviews) {
    const user = str(asRecord(review.user).login)
    const state = str(review.state)

    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') {
      latest.set(user, state)
    }
  }

  const states = [...latest.values()]

  if (states.includes('CHANGES_REQUESTED')) {
    return 'Changes requested'
  }

  const pending = Array.isArray(detail.requested_reviewers) ? detail.requested_reviewers.length : 0
  const teams = Array.isArray(detail.requested_teams) ? detail.requested_teams.length : 0

  if (states.includes('APPROVED')) {
    return pending + teams > 0 ? 'Approved, more reviews requested' : 'Approved'
  }

  return pending + teams > 0 ? 'Awaiting review' : 'No reviews yet'
}

export function githubReadiness(detail: Json): { readiness: string; blockers: string[] } {
  const blockers: string[] = []
  const state = str(detail.mergeable_state)

  if (detail.draft === true) {
    blockers.push('Draft')
  }

  if (detail.mergeable === false || state === 'dirty') {
    blockers.push('Merge conflicts')
  }

  if (state === 'blocked') {
    blockers.push('Blocked by branch protection or required reviews')
  }

  if (state === 'behind') {
    blockers.push('Branch is behind the base branch')
  }

  if (detail.mergeable === null || detail.mergeable === undefined || state === 'unknown' || state === '') {
    return { readiness: 'Checking mergeability', blockers }
  }

  if (blockers.length > 0) {
    return { readiness: 'Not ready to merge', blockers }
  }

  if (state === 'clean' || state === 'has_hooks') {
    return { readiness: 'Ready to merge', blockers }
  }

  if (state === 'unstable') {
    return { readiness: 'Mergeable, but some checks are not passing', blockers }
  }

  return { readiness: 'Unknown', blockers }
}

/**
 * Keeps workflow runs that verifiably belong to this PR's current head: same commit, and
 * either GitHub lists the PR on the run or the run came from the PR's own head repository.
 * A run is never picked just because its branch name matches. Re-runs keep only the newest.
 */
export function relevantRuns(runs: readonly Json[], pr: { number: number; headSha: string; headRepo: string | null; baseRepo: string }): Json[] {
  const kept = new Map<string, Json>()

  for (const run of runs) {
    if (str(run.head_sha) !== pr.headSha || !RELEVANT_EVENTS.has(str(run.event))) {
      continue
    }

    const listed = Array.isArray(run.pull_requests) && run.pull_requests.some(p => Number(asRecord(p).number) === pr.number)
    const runHeadRepo = str(asRecord(run.head_repository).full_name)
    const fromHeadRepo = pr.headRepo !== null && runHeadRepo === pr.headRepo

    if (!listed && !fromHeadRepo) {
      continue
    }

    const key = `${str(run.workflow_id)}:${str(run.event)}`
    const seen = kept.get(key)
    const newer =
      seen === undefined ||
      Number(run.run_number) > Number(seen.run_number) ||
      (Number(run.run_number) === Number(seen.run_number) && Number(run.run_attempt) > Number(seen.run_attempt))

    if (newer) {
      kept.set(key, run)
    }
  }

  return [...kept.values()].sort((a, b) => str(a.name).localeCompare(str(b.name)))
}

function jobFromCheck(raw: Json, preferDetails: boolean): MergeWatchJob {
  const { state, label } = mapCheckState(str(raw.status), str(raw.conclusion))
  const url = preferDetails ? safeUrl(raw.details_url) ?? safeUrl(raw.html_url) : safeUrl(raw.html_url) ?? safeUrl(raw.details_url)

  return job(str(raw.id), cleanText(raw.name) || 'Unnamed check', state, { label, url })
}

async function loadCi(ctx: Ctx, pr: { number: number; headSha: string; headRepo: string | null; baseRepo: string }): Promise<MergeWatchPipeline[]> {
  const repoApi = `${apiBase(ctx.repo.host)}/repos/${ctx.repo.path}`
  const sha = encodeURIComponent(pr.headSha)
  const pipelines: MergeWatchPipeline[] = []
  const jobIds = new Set<string>()
  let runsFailed: string | null = null

  try {
    const runs = await getAll(ctx, `${repoApi}/actions/runs?head_sha=${sha}&per_page=100`, 'workflow_runs')

    for (const run of relevantRuns(runs, pr)) {
      const mapped = mapCheckState(str(run.status), str(run.conclusion))
      const pipeline: MergeWatchPipeline = {
        title: `${cleanText(run.name) || 'Workflow'} (${cleanText(run.event)})`,
        ...mapped,
        url: safeUrl(run.html_url),
        isPreviousRevision: false,
        isIncomplete: false,
        notes: Number(run.run_attempt) > 1 ? [`Attempt ${Number(run.run_attempt)}`] : [],
        jobs: [],
        children: [],
        projectId: null,
        runId: str(run.id) || null,
      }

      try {
        const jobs = await getAll(ctx, `${repoApi}/actions/runs/${str(run.id)}/jobs?filter=latest&per_page=100`, 'jobs')

        for (const j of jobs) {
          jobIds.add(str(j.id))
        }

        pipeline.jobs = jobs.map(j => jobFromCheck(j, false))
      } catch (error) {
        if (error instanceof AuthError || error instanceof RateLimitError) {
          throw error
        }

        pipeline.isIncomplete = true
        pipeline.notes.push(`Jobs unavailable: ${cleanError(error)}`)
      }

      pipelines.push(pipeline)
    }
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }

    runsFailed = cleanError(error)
  }

  try {
    const checks = await getAll(ctx, `${repoApi}/commits/${sha}/check-runs?filter=latest&per_page=100`, 'check_runs')
    // An Actions job is also a check run with the same id: show it once, under its workflow.
    const extra = checks.filter(c => !jobIds.has(str(c.id)))

    if (extra.length > 0) {
      const jobs = extra.map(c => jobFromCheck(c, true))
      const state = rollupJobs(jobs)
      pipelines.push({
        title: 'Checks',
        state,
        label: STATE_WORD[state],
        url: null,
        isPreviousRevision: false,
        isIncomplete: runsFailed !== null,
        notes: runsFailed === null ? [] : [`Workflow runs unavailable: ${runsFailed}`],
        jobs,
        children: [],
        projectId: null,
        runId: null,
      })
    } else if (runsFailed !== null) {
      pipelines.push(unavailableGroup('Workflow runs', runsFailed))
    }
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }

    pipelines.push(unavailableGroup('Checks', cleanError(error)))
  }

  try {
    const combined = asRecord(await getJson(ctx, `${repoApi}/commits/${sha}/status`))
    const statuses = Array.isArray(combined.statuses) ? combined.statuses.map(asRecord) : []

    if (statuses.length > 0) {
      const jobs = statuses.map(s => {
        const mapped = mapCommitStatus(str(s.state))

        return job(str(s.id) || str(s.context), cleanText(s.context) || 'Status', mapped.state, {
          label: mapped.label,
          url: safeUrl(s.target_url),
        })
      })
      const state = rollupJobs(jobs)
      pipelines.push({ title: 'Commit statuses', state, label: STATE_WORD[state], url: null, isPreviousRevision: false, isIncomplete: false, notes: [], jobs, children: [], projectId: null, runId: null })
    }
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }

    pipelines.push(unavailableGroup('Commit statuses', cleanError(error)))
  }

  return pipelines
}

function unavailableGroup(title: string, reason: string): MergeWatchPipeline {
  return { title, state: 'unavailable', label: 'Unavailable', url: null, isPreviousRevision: false, isIncomplete: true, notes: [reason], jobs: [], children: [], projectId: null, runId: null }
}

async function loadRequest(ctx: Ctx, listed: Json): Promise<MergeWatchRequest> {
  const number = Number(listed.number)
  const repoApi = `${apiBase(ctx.repo.host)}/repos/${ctx.repo.path}`
  const detail = { ...listed, ...asRecord(await getJson(ctx, `${repoApi}/pulls/${number}`)) }
  let reviews: Json[] | null = null

  try {
    reviews = await getAll(ctx, `${repoApi}/pulls/${number}/reviews?per_page=100`)
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }
  }

  const head = asRecord(detail.head)
  const base = asRecord(detail.base)
  const headRepo = str(asRecord(head.repo).full_name) || null
  const baseRepo = str(asRecord(base.repo).full_name) || ctx.repo.path
  const pipelines = await loadCi(ctx, { number, headSha: str(head.sha), headRepo, baseRepo })
  const state = pipelines.length === 0 ? 'no-checks' : rollup(pipelines)
  const { readiness, blockers } = githubReadiness(detail)
  const review = githubReview(detail, reviews)
  const mergeState = str(detail.mergeable_state)

  return {
    key: String(number),
    number,
    ref: `#${number}`,
    title: cleanText(detail.title) || '(untitled)',
    url: safeUrl(detail.html_url),
    author: cleanText(asRecord(detail.user).login) || 'unknown',
    sourceBranch: cleanText(head.ref, 120),
    targetBranch: cleanText(base.ref, 120),
    sourceProject: headRepo === null ? 'deleted fork' : headRepo.toLowerCase() === baseRepo.toLowerCase() ? null : cleanText(headRepo),
    isDraft: detail.draft === true,
    review,
    readiness,
    blockers,
    ci: { state, label: pipelines.length === 0 ? 'No checks' : ciLabel(state, pipelines), pipelines },
    updatedAt: str(detail.updated_at),
    headSha: str(head.sha),
    canMerge: detail.mergeable === true && detail.draft !== true && (mergeState === 'clean' || mergeState === 'has_hooks'),
    needsReview: review === 'Awaiting review',
    error: null,
    staleSince: null,
  }
}

function unavailableRequest(listed: Json, error: unknown): MergeWatchRequest {
  const number = Number(listed.number)

  return {
    key: String(number),
    number,
    ref: `#${number}`,
    title: cleanText(listed.title) || '(untitled)',
    url: safeUrl(listed.html_url),
    author: cleanText(asRecord(listed.user).login) || 'unknown',
    sourceBranch: cleanText(asRecord(listed.head).ref, 120),
    targetBranch: cleanText(asRecord(listed.base).ref, 120),
    sourceProject: null,
    isDraft: listed.draft === true,
    review: 'Review status unavailable',
    readiness: 'Unknown',
    blockers: [],
    ci: { state: 'unavailable', label: 'Unavailable', pipelines: [] },
    updatedAt: str(listed.updated_at),
    headSha: str(asRecord(listed.head).sha),
    canMerge: false,
    needsReview: false,
    error: cleanError(error),
    staleSince: null,
  }
}

/** Every open PR (all pages) with its reviews, mergeability, workflows, checks and statuses. */
export async function fetchGitHub(repo: MergeWatchRepo, get: HttpGet, token: string | undefined, now: number): Promise<MergeWatchRequest[]> {
  if (token === undefined || token.trim() === '') {
    throw new AuthError(`No GitHub token for ${repo.host}`, authHelp(repo.host))
  }

  const ctx: Ctx = { repo, get, token: token.trim(), now }
  const listed = await getAll(ctx, `${apiBase(repo.host)}/repos/${repo.path}/pulls?state=open&sort=updated&direction=desc&per_page=100`)

  return mapLimit(listed, PR_CONCURRENCY, async pr => {
    try {
      return await loadRequest(ctx, pr)
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error
      }

      return unavailableRequest(pr, error)
    }
  })
}

// ---------------------------------------------------------------------------
// Write actions. Only ever run after the person confirms in the pane.
// ---------------------------------------------------------------------------

async function write(repo: MergeWatchRepo, send: HttpSend, token: string | undefined, now: number, url: string, method: string, body?: unknown): Promise<void> {
  if (token === undefined || token.trim() === '') {
    throw new AuthError(`No GitHub token for ${repo.host}`, authHelp(repo.host))
  }

  const init = {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.trim()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'merge-watch-claude-code-mod',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  const response = await send(url, init)

  if (response.status === 401) {
    throw new AuthError(`GitHub rejected the token for ${repo.host}`, authHelp(repo.host))
  }

  if (response.status === 429 || (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0')) {
    throw new RateLimitError(`GitHub rate limit reached for ${repo.host}`, now + 60_000)
  }

  if (!response.ok) {
    let message = ''

    try {
      message = str(asRecord(JSON.parse(response.text)).message)
    } catch {
      message = ''
    }

    throw new Error(`GitHub answered ${response.status}${message === '' ? '' : `: ${cleanText(message, 160)}`}`)
  }
}

/** Re-runs the failed jobs of every workflow run that has a failure that is not allowed. */
export async function retryFailedGitHub(repo: MergeWatchRepo, send: HttpSend, token: string | undefined, request: MergeWatchRequest, now: number): Promise<number> {
  let count = 0

  for (const pipeline of request.ci.pipelines) {
    if (!pipeline.runId || !pipeline.jobs.some(j => j.state === 'failed' && !j.isAllowedFailure)) {
      continue
    }

    await write(repo, send, token, now, `${apiBase(repo.host)}/repos/${repo.path}/actions/runs/${pipeline.runId}/rerun-failed-jobs`, 'POST')
    count += pipeline.jobs.filter(j => j.state === 'failed' && !j.isAllowedFailure).length
  }

  return count
}

/** Merges the PR, pinned to the head commit the pane showed. */
export async function mergeGitHub(repo: MergeWatchRepo, send: HttpSend, token: string | undefined, request: MergeWatchRequest, now: number): Promise<void> {
  await write(repo, send, token, now, `${apiBase(repo.host)}/repos/${repo.path}/pulls/${request.number}/merge`, 'PUT', request.headSha === '' ? {} : { sha: request.headSha })
}
