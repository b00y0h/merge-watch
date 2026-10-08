// Fake GitLab and GitHub providers for tests. No real credentials, hosts or network.

import type { GlabRunner } from '../hooks/gitlab'
import type { HttpGet, HttpResponse } from '../hooks/github'

export type Json = Record<string, unknown>

export const GL_HOST = 'gitlab.example.com'
export const GL_PATH = 'team/sub/project'
export const GL_ENC = encodeURIComponent(GL_PATH)
export const GL_WEB = `https://${GL_HOST}/${GL_PATH}`

export function glMr(iid: number, over: Json = {}): Json {
  return {
    iid,
    title: `Merge request ${iid}`,
    web_url: `${GL_WEB}/-/merge_requests/${iid}`,
    author: { username: 'alex' },
    source_branch: `branch-${iid}`,
    target_branch: 'main',
    draft: false,
    updated_at: `2026-10-01T10:${String(iid % 60).padStart(2, '0')}:00Z`,
    source_project_id: 1,
    target_project_id: 1,
    ...over,
  }
}

export function glPipeline(id: number, sha: string, over: Json = {}): Json {
  return {
    id,
    project_id: 1,
    sha,
    ref: 'refs/merge-requests/1/head',
    status: 'running',
    web_url: `${GL_WEB}/-/pipelines/${id}`,
    ...over,
  }
}

export function glJob(id: number, name: string, status: string, over: Json = {}): Json {
  return { id, name, status, stage: 'test', allow_failure: false, web_url: `${GL_WEB}/-/jobs/${id}`, ...over }
}

export type FakeGitLab = {
  mrs: Json[]
  details: Record<string, Json>
  approvals: Record<string, Json>
  jobs: Record<string, Json[]>
  bridges: Record<string, Json[]>
  pipelines: Record<string, Json>
  commits: Record<string, Json>
  projects: Record<string, Json>
  /** A path substring → stderr text; the call fails with it. */
  failures: Record<string, string>
}

export function fakeGitLab(over: Partial<FakeGitLab> = {}): FakeGitLab {
  return { mrs: [], details: {}, approvals: {}, jobs: {}, bridges: {}, pipelines: {}, commits: {}, projects: {}, failures: {}, ...over }
}

/** Answers one `glab api` call: { exitCode, stdout, stderr }, as glab would. */
export function answerGlab(fake: FakeGitLab, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  if (args[0] !== 'api' || !args.includes('--method') || args[args.indexOf('--method') + 1] !== 'GET') {
    return { exitCode: 1, stdout: '', stderr: 'test: only read-only glab api GET calls are allowed' }
  }

  const path = args[5] ?? ''
  const paginate = args.includes('--paginate')

  for (const [needle, stderr] of Object.entries(fake.failures)) {
    if (path.includes(needle)) {
      return { exitCode: 1, stdout: '', stderr }
    }
  }

  const ndjson = (rows: readonly Json[]) => ({ exitCode: 0, stdout: rows.map(r => JSON.stringify(r)).join('\n'), stderr: '' })
  const one = (row: Json | undefined) =>
    row === undefined ? { exitCode: 1, stdout: '', stderr: 'HTTP 404 Not Found' } : { exitCode: 0, stdout: JSON.stringify(row), stderr: '' }

  let m: RegExpExecArray | null

  if (path.startsWith(`projects/${GL_ENC}/merge_requests?`)) {
    return paginate ? ndjson(fake.mrs) : { exitCode: 1, stdout: '', stderr: 'test: list without --paginate' }
  }

  if ((m = /merge_requests\/(\d+)\/approvals$/.exec(path)) !== null) {
    return one(fake.approvals[m[1]!] ?? { approved: false, approvals_left: 1, approved_by: [] })
  }

  if ((m = /merge_requests\/(\d+)$/.exec(path)) !== null) {
    const listed = fake.mrs.find(x => String(x.iid) === m![1])

    return one(fake.details[m[1]!] ?? listed)
  }

  if ((m = /pipelines\/(\d+)\/jobs\?/.exec(path)) !== null) {
    return paginate ? ndjson(fake.jobs[m[1]!] ?? []) : { exitCode: 1, stdout: '', stderr: 'test: jobs without --paginate' }
  }

  if ((m = /pipelines\/(\d+)\/bridges\?/.exec(path)) !== null) {
    return ndjson(fake.bridges[m[1]!] ?? [])
  }

  if ((m = /^projects\/(\d+)\/pipelines\/(\d+)$/.exec(path)) !== null) {
    return one(fake.pipelines[m[2]!])
  }

  if ((m = /repository\/commits\/([0-9a-f]+)$/.exec(path)) !== null) {
    return one(fake.commits[m[1]!])
  }

  if ((m = /^projects\/(\d+)$/.exec(path)) !== null) {
    return one(fake.projects[m[1]!])
  }

  return { exitCode: 1, stdout: '', stderr: `HTTP 404 Not Found: ${path}` }
}

/** A GlabRunner over the fake; `calls` records every argument vector. */
export function glabRunner(fake: FakeGitLab, calls: string[][] = []): GlabRunner {
  return async args => {
    calls.push([...args])
    const r = answerGlab(fake, args)

    if (r.exitCode !== 0) {
      throw new Error(r.stderr)
    }

    return r.stdout
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GH_PATH = 'octo/app'
export const GH_API = `https://api.github.com/repos/${GH_PATH}`

/** Routes `url` (without query noise) to a JSON body; pages are separate keys with Link headers between them. */
export type FakeGitHub = {
  /** url → body, or { status, headers, body } for an error/paged answer. */
  routes: Record<string, unknown>
  calls: string[]
}

export function ok(body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status: 200, ok: true, headers, text: JSON.stringify(body) }
}

export function githubGet(fake: FakeGitHub): HttpGet {
  return async (url, headers) => {
    fake.calls.push(url)

    if (!String(headers.authorization).startsWith('Bearer ')) {
      return { status: 401, ok: false, headers: {}, text: '{"message":"Requires authentication"}' }
    }

    const route = fake.routes[url]

    if (route === undefined) {
      return { status: 404, ok: false, headers: {}, text: '{"message":"Not Found"}' }
    }

    if (route !== null && typeof route === 'object' && 'status' in (route as Json) && 'text' in (route as Json)) {
      return route as HttpResponse
    }

    return ok(route)
  }
}

export function ghPr(number: number, over: Json = {}): Json {
  return {
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/${GH_PATH}/pull/${number}`,
    user: { login: 'sam' },
    draft: false,
    updated_at: `2026-10-01T09:${String(number % 60).padStart(2, '0')}:00Z`,
    head: { ref: `feature-${number}`, sha: `head${number}`, repo: { full_name: GH_PATH } },
    base: { ref: 'main', repo: { full_name: GH_PATH } },
    ...over,
  }
}

/** Registers the per-PR routes a PR with no CI at all needs. */
export function emptyCi(routes: Record<string, unknown>, sha: string): void {
  routes[`${GH_API}/actions/runs?head_sha=${sha}&per_page=100`] = { workflow_runs: [] }
  routes[`${GH_API}/commits/${sha}/check-runs?filter=latest&per_page=100`] = { check_runs: [] }
  routes[`${GH_API}/commits/${sha}/status`] = { statuses: [] }
}
