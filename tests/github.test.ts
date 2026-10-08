import { expect, test } from 'claude-code/testing'

import { fetchGitHub, githubReadiness, githubReview, mapCheckState, nextLink, relevantRuns } from '../hooks/github'
import type { MergeWatchRepo } from '../types'
import { GH_API, GH_PATH, emptyCi, ghPr, githubGet, ok } from './fixtures'
import type { FakeGitHub, Json } from './fixtures'

const REPO: MergeWatchRepo = {
  provider: 'github',
  host: 'github.com',
  path: GH_PATH,
  key: `github:github.com/${GH_PATH}`,
  remoteName: 'origin',
  webUrl: `https://github.com/${GH_PATH}`,
}

const TOKEN = 'dummy_token_do_not_use'
const LIST = `${GH_API}/pulls?state=open&sort=updated&direction=desc&per_page=100`

function prRoutes(routes: Record<string, unknown>, pr: Json, extra: { reviews?: unknown[] } = {}): void {
  const n = Number(pr.number)
  routes[`${GH_API}/pulls/${n}`] = { mergeable: true, mergeable_state: 'clean', requested_reviewers: [], ...pr }
  routes[`${GH_API}/pulls/${n}/reviews?per_page=100`] = extra.reviews ?? []
}

test('2. every page of pull requests and Actions jobs is followed', async () => {
  const routes: Record<string, unknown> = {}
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ghPr(from + i))
  routes[LIST] = ok(page(1, 100), { link: `<${LIST}&page=2>; rel="next", <${LIST}&page=3>; rel="last"` })
  routes[`${LIST}&page=2`] = ok(page(101, 100), { link: `<${LIST}&page=3>; rel="next"` })
  routes[`${LIST}&page=3`] = ok(page(201, 5))

  for (let n = 1; n <= 205; n += 1) {
    prRoutes(routes, ghPr(n))
    emptyCi(routes, `head${n}`)
  }

  // PR 1 has one workflow whose jobs span two pages.
  routes[`${GH_API}/actions/runs?head_sha=head1&per_page=100`] = {
    workflow_runs: [{ id: 500, name: 'CI', event: 'pull_request', head_sha: 'head1', workflow_id: 9, run_number: 3, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/app/actions/runs/500', pull_requests: [{ number: 1 }], head_repository: { full_name: GH_PATH } }],
  }
  const jobs = `${GH_API}/actions/runs/500/jobs?filter=latest&per_page=100`
  routes[jobs] = ok({ jobs: Array.from({ length: 100 }, (_, i) => ({ id: 7000 + i, name: `job ${i}`, status: 'completed', conclusion: 'success', html_url: `https://github.com/octo/app/actions/runs/500/job/${7000 + i}` })) }, { link: `<${jobs}&page=2>; rel="next"` })
  routes[`${jobs}&page=2`] = ok({ jobs: [{ id: 7100, name: 'last job', status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/app/actions/runs/500/job/7100' }] })

  const fake: FakeGitHub = { routes, calls: [] }
  const requests = await fetchGitHub(REPO, githubGet(fake), TOKEN, 0)

  expect(requests).toHaveLength(205)
  expect(requests.find(r => r.number === 1)?.ci.pipelines[0]?.jobs).toHaveLength(101)
  expect(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toBe('https://x/a?page=2')
})

test("4. runs are matched to the PR's head commit and repo, never by branch name; newest attempt wins", () => {
  const pr = { number: 7, headSha: 'h7', headRepo: 'fork/app', baseRepo: GH_PATH }
  const runs: Json[] = [
    // Same branch name, different commit: not this PR's.
    { id: 1, head_sha: 'other', event: 'pull_request', workflow_id: 1, run_number: 9, run_attempt: 1, head_repository: { full_name: 'fork/app' }, head_branch: 'feature-7' },
    // Fork PR: GitHub lists no pull_requests, but the head repo and commit match.
    { id: 2, head_sha: 'h7', event: 'pull_request', workflow_id: 1, run_number: 4, run_attempt: 1, head_repository: { full_name: 'fork/app' }, pull_requests: [] },
    // A re-run of the same workflow: higher attempt wins.
    { id: 2, head_sha: 'h7', event: 'pull_request', workflow_id: 1, run_number: 4, run_attempt: 2, head_repository: { full_name: 'fork/app' }, pull_requests: [] },
    // Same commit from an unrelated repository: no verified association.
    { id: 3, head_sha: 'h7', event: 'pull_request', workflow_id: 2, run_number: 1, run_attempt: 1, head_repository: { full_name: 'stranger/app' }, pull_requests: [] },
    // A second workflow listed against this PR.
    { id: 4, head_sha: 'h7', event: 'pull_request', workflow_id: 3, run_number: 1, run_attempt: 1, head_repository: { full_name: 'x/y' }, pull_requests: [{ number: 7 }] },
    // Irrelevant event.
    { id: 5, head_sha: 'h7', event: 'schedule', workflow_id: 4, run_number: 1, run_attempt: 1, head_repository: { full_name: 'fork/app' } },
  ]
  const kept = relevantRuns(runs, pr)

  expect(kept.map(r => `${r.id}:${r.run_attempt}`).sort()).toEqual(['2:2', '4:1'])
})

test('4. Actions jobs are not shown twice as check runs; external checks and statuses keep their own links', async () => {
  const routes: Record<string, unknown> = {}
  routes[LIST] = [ghPr(3)]
  prRoutes(routes, ghPr(3))
  routes[`${GH_API}/actions/runs?head_sha=head3&per_page=100`] = {
    workflow_runs: [
      { id: 10, name: 'CI', event: 'pull_request', head_sha: 'head3', workflow_id: 1, run_number: 2, run_attempt: 2, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/octo/app/actions/runs/10', pull_requests: [{ number: 3 }] },
      { id: 11, name: 'Docs', event: 'pull_request', head_sha: 'head3', workflow_id: 2, run_number: 1, run_attempt: 1, status: 'in_progress', conclusion: null, html_url: 'https://github.com/octo/app/actions/runs/11', pull_requests: [{ number: 3 }] },
    ],
  }
  routes[`${GH_API}/actions/runs/10/jobs?filter=latest&per_page=100`] = {
    jobs: [{ id: 101, name: 'unit tests', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/octo/app/actions/runs/10/job/101' }],
  }
  routes[`${GH_API}/actions/runs/11/jobs?filter=latest&per_page=100`] = {
    jobs: [{ id: 111, name: 'build docs', status: 'in_progress', conclusion: null, html_url: 'https://github.com/octo/app/actions/runs/11/job/111' }],
  }
  routes[`${GH_API}/commits/head3/check-runs?filter=latest&per_page=100`] = {
    check_runs: [
      { id: 101, name: 'unit tests', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, html_url: 'https://github.com/octo/app/runs/101' },
      { id: 900, name: 'Codecov', status: 'completed', conclusion: 'success', app: { slug: 'codecov' }, details_url: 'https://codecov.example.com/report/900', html_url: 'https://github.com/octo/app/runs/900' },
    ],
  }
  routes[`${GH_API}/commits/head3/status`] = {
    statuses: [{ id: 1, context: 'ci/legacy', state: 'pending', target_url: 'https://ci.example.com/build/1' }, { id: 2, context: 'ci/nolink', state: 'success', target_url: null }],
  }

  const [r] = await fetchGitHub(REPO, githubGet({ routes, calls: [] }), TOKEN, 0)
  const all = r!.ci.pipelines.flatMap(p => p.jobs)

  expect(all.filter(j => j.name === 'unit tests')).toHaveLength(1)
  expect(all.find(j => j.name === 'unit tests')?.url).toBe('https://github.com/octo/app/actions/runs/10/job/101')
  expect(all.find(j => j.name === 'Codecov')?.url).toBe('https://codecov.example.com/report/900')
  expect(all.find(j => j.name === 'ci/legacy')?.url).toBe('https://ci.example.com/build/1')
  expect(all.find(j => j.name === 'ci/nolink')?.url).toBeNull()
  expect(r!.ci.pipelines.map(p => p.title)).toEqual(['CI (pull_request)', 'Docs (pull_request)', 'Checks', 'Commit statuses'])
  expect(r!.ci.pipelines[0]?.notes).toContain('Attempt 2')
  expect(r!.ci.state).toBe('failed')
})

test('4. merge-test commits: Actions runs on a PR report against its head commit', async () => {
  // GitHub runs pull_request workflows on refs/pull/N/merge but records head_sha = the PR head.
  const routes: Record<string, unknown> = {}
  routes[LIST] = [ghPr(4, { merge_commit_sha: 'merge4' })]
  prRoutes(routes, ghPr(4, { merge_commit_sha: 'merge4' }))
  routes[`${GH_API}/actions/runs?head_sha=head4&per_page=100`] = {
    workflow_runs: [{ id: 40, name: 'CI', event: 'pull_request', head_sha: 'head4', head_branch: 'feature-4', workflow_id: 1, run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/app/actions/runs/40', pull_requests: [{ number: 4 }] }],
  }
  routes[`${GH_API}/actions/runs/40/jobs?filter=latest&per_page=100`] = { jobs: [{ id: 41, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/app/actions/runs/40/job/41' }] }
  routes[`${GH_API}/commits/head4/check-runs?filter=latest&per_page=100`] = { check_runs: [{ id: 41, name: 'test', status: 'completed', conclusion: 'success' }] }
  routes[`${GH_API}/commits/head4/status`] = { statuses: [] }
  const fake: FakeGitHub = { routes, calls: [] }
  const [r] = await fetchGitHub(REPO, githubGet(fake), TOKEN, 0)

  expect(r?.ci.state).toBe('passed')
  expect(fake.calls.some(u => u.includes('merge4'))).toBe(false)
})

test('5. GitHub states: neutral, action required, stale, allowed outcomes and no checks', async () => {
  expect(mapCheckState('completed', 'neutral')).toEqual({ state: 'skipped', label: 'Neutral' })
  expect(mapCheckState('completed', 'action_required').state).toBe('blocked')
  expect(mapCheckState('completed', 'stale').state).toBe('unknown')
  expect(mapCheckState('completed', 'timed_out')).toEqual({ state: 'failed', label: 'Timed out' })
  expect(mapCheckState('queued', '').label).toBe('Queued')

  const routes: Record<string, unknown> = {}
  routes[LIST] = [ghPr(8)]
  prRoutes(routes, ghPr(8))
  emptyCi(routes, 'head8')
  const [r] = await fetchGitHub(REPO, githubGet({ routes, calls: [] }), TOKEN, 0)

  expect(r?.ci).toMatchObject({ state: 'no-checks', label: 'No checks' })
})

test('5. review and mergeability: Checking while GitHub has not decided; CI never implies ready', () => {
  expect(githubReadiness({ mergeable: null, mergeable_state: 'unknown' }).readiness).toBe('Checking mergeability')
  expect(githubReadiness({ mergeable: false, mergeable_state: 'dirty' }).blockers).toContain('Merge conflicts')
  expect(githubReadiness({ mergeable: true, mergeable_state: 'blocked' }).readiness).toBe('Not ready to merge')
  expect(githubReadiness({ mergeable: true, mergeable_state: 'clean', draft: true }).blockers).toContain('Draft')
  expect(githubReadiness({ mergeable: true, mergeable_state: 'clean' }).readiness).toBe('Ready to merge')

  const reviews = [
    { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'a' }, state: 'COMMENTED' },
    { user: { login: 'b' }, state: 'APPROVED' },
  ]
  expect(githubReview({}, reviews)).toBe('Changes requested')
  expect(githubReview({}, [{ user: { login: 'a' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'a' }, state: 'APPROVED' }])).toBe('Approved')
  expect(githubReview({ requested_reviewers: [{ login: 'c' }] }, [])).toBe('Awaiting review')
  expect(githubReview({}, null)).toBe('Review status unavailable')
})

test('10. GitHub: missing token, rate limits and partial failures', async () => {
  let help = ''

  try {
    await fetchGitHub(REPO, githubGet({ routes: {}, calls: [] }), undefined, 0)
  } catch (error) {
    help = (error as { help?: string }).help ?? ''
  }

  expect(help).toContain('github_token')
  expect(help).toContain('Never paste a token')

  const limited: Record<string, unknown> = {
    [LIST]: { status: 403, ok: false, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }, text: '{"message":"API rate limit exceeded"}' },
  }
  let retryAt = 0

  try {
    await fetchGitHub(REPO, githubGet({ routes: limited, calls: [] }), TOKEN, 1000)
  } catch (error) {
    retryAt = (error as { retryAt?: number }).retryAt ?? 0
  }

  expect(retryAt).toBe(2_000_000)

  const routes: Record<string, unknown> = {}
  routes[LIST] = [ghPr(1), ghPr(2)]
  prRoutes(routes, ghPr(1))
  emptyCi(routes, 'head1')
  routes[`${GH_API}/pulls/2`] = { status: 502, ok: false, headers: {}, text: '{"message":"Bad gateway"}' }
  const requests = await fetchGitHub(REPO, githubGet({ routes, calls: [] }), TOKEN, 0)

  expect(requests.find(r => r.number === 1)?.error).toBeNull()
  expect(requests.find(r => r.number === 2)?.error).toContain('502')
  expect(requests.find(r => r.number === 2)?.ci.state).toBe('unavailable')
})
