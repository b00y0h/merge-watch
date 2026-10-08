import { expect, test } from 'claude-code/testing'

import { fetchGitLab, gitlabReadiness, latestAttempts, mapGitLabJob, mapGitLabPipelineState, parseNdjson } from '../hooks/gitlab'
import type { MergeWatchRepo } from '../types'
import { GL_HOST, GL_PATH, GL_WEB, fakeGitLab, glJob, glMr, glPipeline, glabRunner } from './fixtures'

const REPO: MergeWatchRepo = {
  provider: 'gitlab',
  host: GL_HOST,
  path: GL_PATH,
  key: `gitlab:${GL_HOST}/${GL_PATH}`,
  remoteName: 'origin',
  webUrl: GL_WEB,
}

test('2. every page of merge requests and jobs is read, with --paginate and GET only', async () => {
  const mrs = Array.from({ length: 230 }, (_, i) => glMr(i + 1))
  const jobs = Array.from({ length: 250 }, (_, i) => glJob(1000 + i, `job-${i}`, 'success'))
  const fake = fakeGitLab({
    mrs,
    details: { '1': { ...glMr(1), sha: 'aaa', head_pipeline: glPipeline(830, 'aaa', { status: 'success' }) } },
    jobs: { '830': jobs },
  })
  const calls: string[][] = []
  const requests = await fetchGitLab(REPO, glabRunner(fake, calls), 0)

  expect(requests).toHaveLength(230)
  expect(requests.find(r => r.number === 1)?.ci.pipelines[0]?.jobs).toHaveLength(250)
  // Every call is a read-only GET with an explicit host; lists use --paginate.
  for (const args of calls) {
    expect(args.slice(0, 5)).toEqual(['api', '--hostname', GL_HOST, '--method', 'GET'])
  }
  expect(calls.filter(a => a.includes('--paginate')).length).toBeGreaterThan(1)
})

test('2. ndjson pages that arrive as one array per line are flattened', () => {
  expect(parseNdjson('[{"id":1},{"id":2}]\n[{"id":3}]\n')).toHaveLength(3)
  expect(parseNdjson('{"id":1}\n\n{"id":2}')).toHaveLength(2)
})

test("3. the MR's own head pipeline is used, from its owning project (fork)", async () => {
  const fake = fakeGitLab({
    mrs: [glMr(142, { source_project_id: 77, target_project_id: 1 })],
    details: {
      '142': {
        ...glMr(142, { source_project_id: 77, target_project_id: 1 }),
        sha: 'f0f0',
        diff_refs: { head_sha: 'f0f0' },
        head_pipeline: glPipeline(900, 'f0f0', { project_id: 77, status: 'failed', web_url: 'https://gitlab.example.com/fork/project/-/pipelines/900' }),
      },
    },
    jobs: { '900': [glJob(5, 'lint', 'success'), glJob(6, 'integration tests', 'failed')] },
    projects: { '77': { path_with_namespace: 'someone/project-fork' } },
  })
  const calls: string[][] = []
  const [r] = await fetchGitLab(REPO, glabRunner(fake, calls), 0)

  expect(r?.sourceProject).toBe('someone/project-fork')
  expect(r?.ci.state).toBe('failed')
  expect(calls.some(a => a[5] === 'projects/77/pipelines/900/jobs?per_page=100')).toBe(true)
  expect(r?.ci.pipelines[0]?.url).toBe('https://gitlab.example.com/fork/project/-/pipelines/900')
})

test('3. merged-result pipelines count as current only when the merge commit has the MR head as a parent', async () => {
  const head = 'abc1'
  const merge = 'def2'
  const fake = fakeGitLab({
    mrs: [glMr(10), glMr(11)],
    details: {
      '10': { ...glMr(10), sha: head, head_pipeline: glPipeline(1, merge, { ref: 'refs/merge-requests/10/merge', status: 'success' }) },
      '11': { ...glMr(11), sha: 'new9', head_pipeline: glPipeline(2, 'ffff', { ref: 'refs/merge-requests/11/merge', status: 'success' }) },
    },
    commits: { [merge]: { parent_ids: ['main0', head] }, ffff: { parent_ids: ['main0', 'old8'] } },
    jobs: { '1': [glJob(1, 'build', 'success')], '2': [glJob(2, 'build', 'success')] },
  })
  const requests = await fetchGitLab(REPO, glabRunner(fake), 0)
  const current = requests.find(r => r.number === 10)
  const old = requests.find(r => r.number === 11)

  expect(current?.ci.state).toBe('passed')
  expect(current?.ci.pipelines[0]?.notes).toContain('Merged result pipeline')
  // No false green: an older revision's success is not the current result.
  expect(old?.ci.pipelines[0]?.isPreviousRevision).toBe(true)
  expect(old?.ci.state).not.toBe('passed')
  expect(old?.ci.label).toBe('Previous revision only')
})

test('3. a plain pipeline for an older commit is labelled Previous revision', async () => {
  const fake = fakeGitLab({
    mrs: [glMr(3)],
    details: { '3': { ...glMr(3), sha: 'new1', head_pipeline: glPipeline(3, 'old1', { status: 'success' }) } },
  })
  const [r] = await fetchGitLab(REPO, glabRunner(fake), 0)

  expect(r?.ci.pipelines[0]?.isPreviousRevision).toBe(true)
  expect(r?.ci.state).toBe('unknown')
})

test('3. retries: the newest attempt of a job wins over an older failure', () => {
  const jobs = latestAttempts([glJob(10, 'unit tests', 'failed'), glJob(12, 'unit tests', 'success'), glJob(11, 'lint', 'success')])

  expect(jobs.map(j => `${j.name}:${j.status}`)).toEqual(['lint:success', 'unit tests:success'])
})

test('3. downstream pipelines: loaded when accessible, labelled when not', async () => {
  const fake = fakeGitLab({
    mrs: [glMr(5)],
    details: { '5': { ...glMr(5), sha: 's5', head_pipeline: glPipeline(50, 's5', { status: 'running' }) } },
    jobs: { '50': [glJob(1, 'build', 'success')], '51': [glJob(2, 'deploy', 'running')] },
    bridges: {
      '50': [
        { id: 90, name: 'trigger-deploy', downstream_pipeline: { id: 51, project_id: 2, web_url: `${GL_WEB}/-/pipelines/51`, status: 'running' } },
        { id: 91, name: 'trigger-secret', downstream_pipeline: { id: 52, project_id: 3, web_url: 'https://gitlab.example.com/secret/-/pipelines/52', status: 'success' } },
      ],
    },
    pipelines: { '51': glPipeline(51, 's5', { project_id: 2, status: 'running' }) },
  })
  const [r] = await fetchGitLab(REPO, glabRunner(fake), 0)
  const [ok, denied] = r?.ci.pipelines[0]?.children ?? []

  expect(ok?.jobs.map(j => j.name)).toEqual(['deploy'])
  expect(denied?.state).toBe('unavailable')
  expect(denied?.label).toBe('Not accessible')
  expect(denied?.url).toBe('https://gitlab.example.com/secret/-/pipelines/52')
  expect(r?.ci.state).not.toBe('passed')
})

test('5. job and pipeline status mapping, allowed failures and manual jobs', () => {
  expect(mapGitLabJob(glJob(1, 'a', 'failed', { allow_failure: true }))).toMatchObject({ state: 'failed', label: 'Failed (allowed)', isAllowedFailure: true })
  expect(mapGitLabJob(glJob(1, 'a', 'manual', { allow_failure: true })).label).toBe('Manual (optional)')
  expect(mapGitLabJob(glJob(1, 'a', 'manual', { allow_failure: false })).label).toBe('Manual (blocking)')
  expect(mapGitLabJob(glJob(1, 'a', 'canceled')).state).toBe('cancelled')
  expect(mapGitLabJob(glJob(1, 'a', 'created')).state).toBe('pending')
  expect(mapGitLabJob(glJob(1, 'a', 'something_new')).state).toBe('unknown')
  expect(mapGitLabPipelineState({ status: 'success', detailed_status: { group: 'success-with-warnings' } }).state).toBe('warning')
  expect(mapGitLabPipelineState({ status: 'manual' }).state).toBe('blocked')
  expect(mapGitLabPipelineState({}).state).toBe('unknown')
})

test('5. readiness is separate from CI; Ready to merge only when GitLab says mergeable', async () => {
  expect(gitlabReadiness({ detailed_merge_status: 'mergeable' }).readiness).toBe('Ready to merge')
  expect(gitlabReadiness({ detailed_merge_status: 'checking' }).readiness).toBe('Checking mergeability')
  expect(gitlabReadiness({ detailed_merge_status: 'not_approved' })).toEqual({ readiness: 'Not ready to merge', blockers: ['Needs approval'] })
  expect(gitlabReadiness({ detailed_merge_status: 'conflict', has_conflicts: true }).blockers).toEqual(['Merge conflicts'])

  // Passing CI on an unapproved MR is still not ready.
  const fake = fakeGitLab({
    mrs: [glMr(7)],
    details: { '7': { ...glMr(7), sha: 's7', detailed_merge_status: 'not_approved', head_pipeline: glPipeline(70, 's7', { status: 'success' }) } },
    jobs: { '70': [glJob(1, 'lint', 'success')] },
  })
  const [r] = await fetchGitLab(REPO, glabRunner(fake), 0)

  expect(r?.ci.state).toBe('passed')
  expect(r?.readiness).toBe('Not ready to merge')
})

test('5. missing CI is No pipeline, never Passed; unloadable jobs make a pipeline incomplete', async () => {
  const fake = fakeGitLab({
    mrs: [glMr(1), glMr(2)],
    details: { '2': { ...glMr(2), sha: 's2', head_pipeline: glPipeline(20, 's2', { status: 'success' }) } },
    failures: { 'pipelines/20/jobs': 'HTTP 500 Internal Server Error' },
  })
  const requests = await fetchGitLab(REPO, glabRunner(fake), 0)

  expect(requests.find(r => r.number === 1)?.ci).toMatchObject({ state: 'no-pipeline', label: 'No pipeline' })
  expect(requests.find(r => r.number === 2)?.ci.state).toBe('unknown')
  expect(requests.find(r => r.number === 2)?.ci.pipelines[0]?.isIncomplete).toBe(true)
})

test('10. one MR failing does not lose the others; missing sign-in becomes setup help', async () => {
  const fake = fakeGitLab({ mrs: [glMr(1), glMr(2)], failures: { 'merge_requests/2': 'HTTP 500 boom' } })
  const requests = await fetchGitLab(REPO, glabRunner(fake), 0)

  expect(requests.find(r => r.number === 1)?.error).toBeNull()
  expect(requests.find(r => r.number === 2)?.error).toContain('500')
  expect(requests.find(r => r.number === 2)?.ci.state).toBe('unavailable')

  const unauth = fakeGitLab({ failures: { merge_requests: 'glab: 401 Unauthorized' } })
  let help = ''

  try {
    await fetchGitLab(REPO, glabRunner(unauth), 0)
  } catch (error) {
    help = (error as { help?: string }).help ?? ''
  }

  expect(help).toContain(`glab auth login --hostname ${GL_HOST}`)

  const limited = fakeGitLab({ failures: { merge_requests: '429 Too Many Requests' } })
  let retryAt = 0

  try {
    await fetchGitLab(REPO, glabRunner(limited), 1000)
  } catch (error) {
    retryAt = (error as { retryAt?: number }).retryAt ?? 0
  }

  expect(retryAt).toBeGreaterThan(1000)
})

test('12. GitLab titles and links are cleaned', async () => {
  const fake = fakeGitLab({
    mrs: [glMr(9, { title: '\u001b[2JFake \u001b[31mtitle', web_url: 'https://YOUR_USER:YOUR_PASSWORD_HERE@gitlab.example.com/x' })],
  })
  const [r] = await fetchGitLab(REPO, glabRunner(fake), 0)

  expect(r?.title).toBe('Fake title')
  expect(r?.url).toBeNull()
})
