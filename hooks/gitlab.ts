// GitLab adapter: `glab api` GET requests mapped to the shared display model, plus the two
// write actions the pane offers after a confirm press: retry failed jobs and merge.

import type { MergeWatchCiState, MergeWatchJob, MergeWatchPipeline, MergeWatchRepo, MergeWatchRequest } from '../types'
import { cleanError, cleanText, safeUrl } from './safe'
import { AuthError, RateLimitError, STATE_WORD, ciLabel, job, mapLimit, rollup } from './status'

/** Runs `glab` with an argument vector (never a shell string) and resolves its stdout; rejects with stderr. */
export type GlabRunner = (args: readonly string[]) => Promise<string>

type Json = Record<string, unknown>

const MR_CONCURRENCY = 4
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000

function asRecord(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function apiArgs(host: string, path: string, paginate: boolean): string[] {
  const args = ['api', '--hostname', host, '--method', 'GET', path]

  return paginate ? [...args, '--paginate', '--output', 'ndjson'] : args
}

/** Turns a glab failure into an auth, rate-limit or plain error. */
export function classifyGlabError(error: unknown, host: string, now: number): Error {
  const text = cleanError(error)

  if (/\b401\b|unauthori[sz]ed|not logged in|no token|authentication|glab auth login/i.test(text)) {
    return new AuthError(
      `GitLab sign-in missing for ${host}`,
      `Sign in to ${host} with the GitLab CLI in your own terminal: glab auth login --hostname ${host}. Then run /merge-watch refresh.`,
    )
  }

  if (/\b429\b|too many requests|rate limit/i.test(text)) {
    return new RateLimitError(`GitLab is rate limiting requests from ${host}`, now + RATE_LIMIT_BACKOFF_MS)
  }

  if (/ENOENT|not found: glab|command not found|cannot start|executable/i.test(text)) {
    return new AuthError(
      'The GitLab CLI (glab) is not installed',
      'Install the GitLab CLI (glab), sign in with glab auth login --hostname <your GitLab host>, then run /merge-watch refresh.',
    )
  }

  return new Error(text)
}

export function parseNdjson(text: string): Json[] {
  const out: Json[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '') {
      continue
    }

    const value: unknown = JSON.parse(trimmed)

    // Some glab versions print a page as one array per line.
    if (Array.isArray(value)) {
      out.push(...value.map(asRecord))
    } else {
      out.push(asRecord(value))
    }
  }

  return out
}

/** One GitLab job status → shared state and its word. */
export function mapGitLabJob(raw: Json): MergeWatchJob {
  const status = str(raw.status)
  const allowFailure = raw.allow_failure === true
  const url = safeUrl(raw.web_url)
  const name = cleanText(raw.name) || 'Unnamed job'
  const stage = cleanText(raw.stage) || null
  const id = str(raw.id)

  switch (status) {
    case 'success':
      return job(id, name, 'passed', { url, stage })
    case 'failed':
      return allowFailure
        ? job(id, name, 'failed', { label: 'Failed (allowed)', isAllowedFailure: true, url, stage })
        : job(id, name, 'failed', { url, stage })
    case 'running':
      return job(id, name, 'running', { url, stage })
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
      return job(id, name, 'pending', { url, stage })
    case 'scheduled':
      return job(id, name, 'pending', { label: 'Scheduled', url, stage })
    case 'manual':
      return job(id, name, 'manual', {
        label: allowFailure ? 'Manual (optional)' : 'Manual (blocking)',
        url,
        stage,
      })
    case 'skipped':
      return job(id, name, 'skipped', { url, stage })
    case 'canceled':
    case 'canceling':
      return job(id, name, 'cancelled', { url, stage })
    default:
      return job(id, name, 'unknown', { label: status === '' ? 'Unknown' : `Unknown (${cleanText(status, 30)})`, url, stage })
  }
}

/** A GitLab pipeline status → shared state. `manual` pipelines wait on a manual job and are Blocked. */
export function mapGitLabPipelineState(raw: Json): { state: MergeWatchCiState; label: string } {
  const status = str(raw.status)
  const group = str(asRecord(raw.detailed_status).group)

  switch (status) {
    case 'success':
      return group === 'success-with-warnings'
        ? { state: 'warning', label: STATE_WORD.warning }
        : { state: 'passed', label: STATE_WORD.passed }
    case 'failed':
      return { state: 'failed', label: STATE_WORD.failed }
    case 'running':
      return { state: 'running', label: STATE_WORD.running }
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'waiting_for_callback':
      return { state: 'pending', label: STATE_WORD.pending }
    case 'scheduled':
      return { state: 'pending', label: 'Scheduled' }
    case 'manual':
      return { state: 'blocked', label: 'Blocked (waiting for a manual job)' }
    case 'skipped':
      return { state: 'skipped', label: STATE_WORD.skipped }
    case 'canceled':
    case 'canceling':
      return { state: 'cancelled', label: STATE_WORD.cancelled }
    default:
      return { state: 'unknown', label: STATE_WORD.unknown }
  }
}

/** Keeps the newest attempt of each job name, so an older failed try never replaces a retry. */
export function latestAttempts(jobs: readonly Json[]): Json[] {
  const byName = new Map<string, Json>()

  for (const j of jobs) {
    const name = str(j.name)
    const seen = byName.get(name)

    if (seen === undefined || Number(j.id) > Number(seen.id)) {
      byName.set(name, j)
    }
  }

  return [...byName.values()].sort((a, b) => Number(a.id) - Number(b.id))
}

const MERGE_STATUS_BLOCKERS: Record<string, string> = {
  conflict: 'Merge conflicts',
  discussions_not_resolved: 'Unresolved discussions',
  need_rebase: 'Needs rebase',
  blocked_status: 'Blocked by another merge request',
  not_approved: 'Needs approval',
  ci_must_pass: 'Pipeline must pass',
  ci_still_running: 'Pipeline still running',
  draft_status: 'Draft',
  requested_changes: 'Changes requested',
  external_status_checks: 'External status checks pending',
  jira_association_missing: 'Jira issue missing',
  merge_time: 'Scheduled merge time not reached',
  security_policy_violations: 'Security policy violation',
  security_policy_pipeline_check: 'Security policy pipeline check',
  title_regex: 'Title does not match the required format',
  locked_paths: 'Locked paths',
  locked_lfs_files: 'Locked LFS files',
  commits_status: 'Commit status checks',
  not_open: 'Not open',
}

const CHECKING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing', 'cannot_be_merged_recheck'])

export function gitlabReadiness(detail: Json): { readiness: string; blockers: string[] } {
  const status = str(detail.detailed_merge_status)
  const blockers: string[] = []

  if (detail.has_conflicts === true || status === 'conflict') {
    blockers.push('Merge conflicts')
  }

  const known = MERGE_STATUS_BLOCKERS[status]

  if (known !== undefined && !blockers.includes(known) && status !== 'draft_status') {
    blockers.push(known)
  } else if (known === undefined && status !== '' && status !== 'mergeable' && !CHECKING.has(status)) {
    blockers.push(cleanText(status.replace(/_/g, ' '), 60))
  }

  if (status === 'mergeable' && blockers.length === 0) {
    return { readiness: 'Ready to merge', blockers }
  }

  if (CHECKING.has(status) || status === '') {
    return { readiness: 'Checking mergeability', blockers }
  }

  return { readiness: 'Not ready to merge', blockers }
}

export function gitlabReview(detail: Json, approvals: Json | null): string {
  if (str(detail.detailed_merge_status) === 'requested_changes') {
    return 'Changes requested'
  }

  if (approvals === null) {
    return 'Review status unavailable'
  }

  const left = Number(approvals.approvals_left ?? 0)
  const approvedBy = Array.isArray(approvals.approved_by) ? approvals.approved_by.length : 0
  const reviewers = Array.isArray(detail.reviewers) ? detail.reviewers.length : 0

  if (left > 0) {
    return `Awaiting review (${left} approval${left === 1 ? '' : 's'} needed)`
  }

  if (approvedBy > 0) {
    return 'Approved'
  }

  return reviewers > 0 ? 'Awaiting review' : 'No approval required'
}

export type Ctx = { repo: MergeWatchRepo; glab: GlabRunner; now: number }

async function getJson(ctx: Ctx, path: string): Promise<Json> {
  let text: string

  try {
    text = await ctx.glab(apiArgs(ctx.repo.host, path, false))
  } catch (error) {
    throw classifyGlabError(error, ctx.repo.host, ctx.now)
  }

  return asRecord(JSON.parse(text))
}

async function getAll(ctx: Ctx, path: string): Promise<Json[]> {
  let text: string

  try {
    text = await ctx.glab(apiArgs(ctx.repo.host, path, true))
  } catch (error) {
    throw classifyGlabError(error, ctx.repo.host, ctx.now)
  }

  return parseNdjson(text)
}

/** Loads one pipeline's jobs (newest attempts) and its downstream pipelines, one level deep. */
async function loadPipeline(ctx: Ctx, raw: Json, depth: number): Promise<MergeWatchPipeline> {
  const projectId = str(raw.project_id)
  const id = str(raw.id)
  const { state, label } = mapGitLabPipelineState(raw)
  const pipeline: MergeWatchPipeline = {
    title: depth === 0 ? `Pipeline #${id}` : `Downstream pipeline #${id}`,
    state,
    label,
    url: safeUrl(raw.web_url),
    isPreviousRevision: false,
    isIncomplete: false,
    notes: [],
    jobs: [],
    children: [],
    projectId: projectId === '' ? null : projectId,
    runId: null,
  }

  try {
    const jobs = await getAll(ctx, `projects/${projectId}/pipelines/${id}/jobs?per_page=100`)
    pipeline.jobs = latestAttempts(jobs).map(mapGitLabJob)
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }

    pipeline.isIncomplete = true
    pipeline.notes.push(`Jobs unavailable: ${cleanError(error)}`)
  }

  let bridges: Json[] = []

  try {
    bridges = await getAll(ctx, `projects/${projectId}/pipelines/${id}/bridges?per_page=100`)
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }

    pipeline.isIncomplete = true
    pipeline.notes.push('Downstream pipelines unavailable')
  }

  for (const bridge of latestAttempts(bridges)) {
    const downstream = asRecord(bridge.downstream_pipeline)

    if (str(downstream.id) === '') {
      continue
    }

    if (depth >= 1) {
      const mapped = mapGitLabPipelineState(downstream)
      pipeline.children.push({
        title: `Downstream pipeline #${str(downstream.id)} (${cleanText(bridge.name)})`,
        ...mapped,
        url: safeUrl(downstream.web_url),
        isPreviousRevision: false,
        isIncomplete: true,
        notes: ['Not loaded: nested deeper than one level'],
        jobs: [],
        children: [],
        projectId: str(downstream.project_id) || null,
        runId: null,
      })
      continue
    }

    try {
      // The downstream pipeline may live in another project; fetch it from its own.
      const full = await getJson(ctx, `projects/${str(downstream.project_id)}/pipelines/${str(downstream.id)}`)
      const child = await loadPipeline(ctx, full, depth + 1)
      child.title = `Downstream pipeline #${str(downstream.id)} (${cleanText(bridge.name)})`
      pipeline.children.push(child)
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error
      }

      pipeline.isIncomplete = true
      pipeline.children.push({
        title: `Downstream pipeline #${str(downstream.id)} (${cleanText(bridge.name)})`,
        state: 'unavailable',
        label: 'Not accessible',
        url: safeUrl(downstream.web_url),
        isPreviousRevision: false,
        isIncomplete: true,
        notes: ['Not accessible with your GitLab access'],
        jobs: [],
        children: [],
        projectId: null,
        runId: null,
      })
    }
  }

  return pipeline
}

/**
 * Decides whether the MR's head pipeline ran for the MR's current commit. A merged-result
 * pipeline runs on a merge commit, so it counts as current when that commit's parents
 * include the MR's head. When that cannot be checked the answer is "unconfirmed", never current.
 */
export async function revisionOf(
  ctx: Ctx,
  pipeline: Json,
  mrSha: string,
): Promise<{ revision: 'current' | 'previous' | 'unconfirmed'; note: string | null }> {
  const sha = str(pipeline.sha)
  const ref = str(pipeline.ref)

  if (mrSha === '' || sha === '') {
    return { revision: 'unconfirmed', note: 'Could not confirm which revision this pipeline tested' }
  }

  if (sha === mrSha) {
    return { revision: 'current', note: null }
  }

  if (/^refs\/merge-requests\/\d+\/(merge|train)$/.test(ref)) {
    try {
      const commit = await getJson(ctx, `projects/${str(pipeline.project_id)}/repository/commits/${encodeURIComponent(sha)}`)
      const parents = Array.isArray(commit.parent_ids) ? commit.parent_ids.map(str) : []

      return parents.includes(mrSha)
        ? { revision: 'current', note: ref.endsWith('/train') ? 'Merge train pipeline' : 'Merged result pipeline' }
        : { revision: 'previous', note: null }
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error
      }

      return { revision: 'unconfirmed', note: 'Could not confirm which revision this pipeline tested' }
    }
  }

  return { revision: 'previous', note: null }
}

async function loadRequest(ctx: Ctx, listed: Json): Promise<MergeWatchRequest> {
  const iid = str(listed.iid)
  const base = `projects/${encodeURIComponent(ctx.repo.path)}/merge_requests/${iid}`
  const detail = { ...listed, ...(await getJson(ctx, base)) }
  let approvals: Json | null = null

  try {
    approvals = await getJson(ctx, `${base}/approvals`)
  } catch (error) {
    if (error instanceof AuthError || error instanceof RateLimitError) {
      throw error
    }
  }

  let sourceProject: string | null = null

  if (str(detail.source_project_id) !== '' && str(detail.source_project_id) !== str(detail.target_project_id)) {
    try {
      const project = await getJson(ctx, `projects/${str(detail.source_project_id)}`)
      sourceProject = cleanText(project.path_with_namespace) || `project ${str(detail.source_project_id)}`
    } catch {
      sourceProject = `project ${str(detail.source_project_id)}`
    }
  }

  const head = asRecord(detail.head_pipeline)
  const pipelines: MergeWatchPipeline[] = []

  if (str(head.id) !== '') {
    const pipeline = await loadPipeline(ctx, head, 0)
    const mrSha = str(asRecord(detail.diff_refs).head_sha) || str(detail.sha)
    const revision = await revisionOf(ctx, head, mrSha)

    if (revision.revision === 'previous') {
      pipeline.isPreviousRevision = true
      pipeline.notes.unshift('Previous revision: this pipeline ran for an older commit')
    } else if (revision.revision === 'unconfirmed') {
      pipeline.isIncomplete = true
    }

    if (revision.note !== null) {
      pipeline.notes.push(revision.note)
    }

    pipelines.push(pipeline)
  }

  const state = pipelines.length === 0 ? 'no-pipeline' : rollup(pipelines)
  const { readiness, blockers } = gitlabReadiness(detail)
  const author = asRecord(detail.author)
  const review = gitlabReview(detail, approvals)

  return {
    key: iid,
    number: Number(iid),
    ref: `!${iid}`,
    title: cleanText(detail.title) || '(untitled)',
    url: safeUrl(detail.web_url),
    author: cleanText(author.username) || cleanText(author.name) || 'unknown',
    sourceBranch: cleanText(detail.source_branch, 120),
    targetBranch: cleanText(detail.target_branch, 120),
    sourceProject,
    isDraft: detail.draft === true || detail.work_in_progress === true,
    review,
    readiness,
    blockers,
    ci: { state, label: pipelines.length === 0 ? 'No pipeline' : ciLabel(state, pipelines), pipelines },
    updatedAt: str(detail.updated_at),
    headSha: str(asRecord(detail.diff_refs).head_sha) || str(detail.sha),
    canMerge: str(detail.detailed_merge_status) === 'mergeable' && asRecord(detail.user).can_merge !== false,
    needsReview: review.startsWith('Awaiting review'),
    error: null,
    staleSince: null,
  }
}

/** A request whose details could not be loaded: listed facts only, CI Unavailable. */
function unavailableRequest(listed: Json, error: unknown): MergeWatchRequest {
  const iid = str(listed.iid)
  const author = asRecord(listed.author)

  return {
    key: iid,
    number: Number(iid),
    ref: `!${iid}`,
    title: cleanText(listed.title) || '(untitled)',
    url: safeUrl(listed.web_url),
    author: cleanText(author.username) || 'unknown',
    sourceBranch: cleanText(listed.source_branch, 120),
    targetBranch: cleanText(listed.target_branch, 120),
    sourceProject: null,
    isDraft: listed.draft === true,
    review: 'Review status unavailable',
    readiness: 'Unknown',
    blockers: [],
    ci: { state: 'unavailable', label: 'Unavailable', pipelines: [] },
    updatedAt: str(listed.updated_at),
    headSha: str(listed.sha),
    canMerge: false,
    needsReview: false,
    error: cleanError(error),
    staleSince: null,
  }
}

/** Every open MR (all pages), each with its own head pipeline and jobs. */
export async function fetchGitLab(repo: MergeWatchRepo, glab: GlabRunner, now: number): Promise<MergeWatchRequest[]> {
  const ctx: Ctx = { repo, glab, now }
  const listed = await getAll(
    ctx,
    `projects/${encodeURIComponent(repo.path)}/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc`,
  )

  return mapLimit(listed, MR_CONCURRENCY, async mr => {
    try {
      return await loadRequest(ctx, mr)
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error
      }

      return unavailableRequest(mr, error)
    }
  })
}

// ---------------------------------------------------------------------------
// Write actions. Only ever run after the person confirms in the pane.
// ---------------------------------------------------------------------------

function flatten(pipelines: readonly MergeWatchPipeline[]): MergeWatchPipeline[] {
  return pipelines.flatMap(p => [p, ...flatten(p.children)])
}

/** Re-runs every failed job that is not allowed to fail, in the project that owns its pipeline. */
export async function retryFailedGitLab(repo: MergeWatchRepo, glab: GlabRunner, request: MergeWatchRequest, now: number): Promise<number> {
  let count = 0

  for (const pipeline of flatten(request.ci.pipelines)) {
    if (pipeline.projectId === null || pipeline.isPreviousRevision) {
      continue
    }

    for (const j of pipeline.jobs) {
      if (j.state !== 'failed' || j.isAllowedFailure || !/^\d+$/.test(j.id)) {
        continue
      }

      try {
        await glab(['api', '--hostname', repo.host, '--method', 'POST', `projects/${pipeline.projectId}/jobs/${j.id}/retry`])
      } catch (error) {
        throw classifyGlabError(error, repo.host, now)
      }

      count += 1
    }
  }

  return count
}

/** Merges the MR, pinned to the commit the pane showed: GitLab refuses if the branch moved since. */
export async function mergeGitLab(repo: MergeWatchRepo, glab: GlabRunner, request: MergeWatchRequest, now: number): Promise<void> {
  const args = ['api', '--hostname', repo.host, '--method', 'PUT', `projects/${encodeURIComponent(repo.path)}/merge_requests/${request.number}/merge`]

  try {
    await glab(request.headSha === '' ? args : [...args, '--raw-field', `sha=${request.headSha}`])
  } catch (error) {
    throw classifyGlabError(error, repo.host, now)
  }
}
