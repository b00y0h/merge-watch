import { expect, test } from 'claude-code/testing'

import { mergeGitHub, retryFailedGitHub } from '../hooks/github'
import { normalizeView, segmentWidths } from '../hooks/merge-watch'
import type { HttpResponse } from '../hooks/github'
import { job } from '../hooks/status'
import { groupOf, jobMix, reasonLine, splitCells, stripPrefix } from '../hooks/view-model'
import type { MergeWatchPipeline, MergeWatchRepo, MergeWatchRequest } from '../types'

function pipeline(over: Partial<MergeWatchPipeline> = {}): MergeWatchPipeline {
  return { title: 'Pipeline #1', state: 'passed', label: 'Passed', url: null, isPreviousRevision: false, isIncomplete: false, notes: [], jobs: [], children: [], projectId: '1', runId: null, ...over }
}

function request(over: Partial<MergeWatchRequest> = {}): MergeWatchRequest {
  return {
    key: '1',
    number: 1,
    ref: '!1',
    title: 'feat(x): thing',
    url: null,
    author: 'a',
    sourceBranch: 's',
    targetBranch: 'main',
    sourceProject: null,
    isDraft: false,
    review: 'No approval required',
    readiness: 'Ready to merge',
    blockers: [],
    ci: { state: 'passed', label: 'Passed', pipelines: [pipeline()] },
    updatedAt: '2026-10-08T00:00:00Z',
    headSha: 'abc',
    canMerge: true,
    needsReview: false,
    error: null,
    staleSince: null,
    ...over,
  }
}

test('conventional-commit and draft prefixes are stripped from titles', () => {
  expect(stripPrefix('docs(adr): add ADR-1000 buttons')).toBe('add ADR-1000 buttons')
  expect(stripPrefix('fix(deps)!: update pnpm to v12')).toBe('update pnpm to v12')
  expect(stripPrefix('Draft: feat(design-importer): source-agnostic importer')).toBe('source-agnostic importer')
  expect(stripPrefix('[WIP] chore: tidy')).toBe('tidy')
  expect(stripPrefix('Plain title: with a colon')).toBe('Plain title: with a colon')
  expect(stripPrefix('feat:')).toBe('feat:')
})

test('groups: drafts, ready only with passing CI and a mergeable verdict, else failing', () => {
  expect(groupOf(request())).toBe('ready')
  expect(groupOf(request({ ci: { state: 'warning', label: 'Passed with warnings', pipelines: [pipeline()] } }))).toBe('ready')
  expect(groupOf(request({ isDraft: true }))).toBe('draft')
  expect(groupOf(request({ readiness: 'Not ready to merge' }))).toBe('failing')
  expect(groupOf(request({ ci: { state: 'running', label: 'Running', pipelines: [pipeline()] } }))).toBe('failing')
  // Stale data is never presented as ready.
  expect(groupOf(request({ staleSince: 5 }))).toBe('failing')
})

test('reason lines: allowed failures never count as failures', () => {
  const allowed = job('9', 'dependency-audit', 'failed', { isAllowedFailure: true, label: 'Failed (allowed)' })

  expect(reasonLine(request({ needsReview: true, ci: { state: 'warning', label: 'x', pipelines: [pipeline({ jobs: [allowed] })] } }))).toBe(
    '✓ needs review · 1 allowed failure',
  )
  expect(reasonLine(request({ ci: { state: 'warning', label: 'x', pipelines: [pipeline({ jobs: [allowed] })] } }))).toBe('✓ 1 allowed failure')

  const failing = (n: number) =>
    request({ readiness: 'Not ready to merge', ci: { state: 'failed', label: 'Failed', pipelines: [pipeline({ jobs: [allowed, ...Array.from({ length: n }, (_, i) => job(String(i), `job${i}`, 'failed'))] })] } })

  expect(reasonLine(failing(2))).toBe('✕ job0, job1')
  expect(reasonLine(failing(16))).toBe('✕ 16 jobs failing — job0, job1, job2…')
  // A previous revision's failures are not the current result.
  expect(
    reasonLine(request({ readiness: 'Not ready to merge', ci: { state: 'unknown', label: 'x', pipelines: [pipeline({ isPreviousRevision: true, jobs: [job('1', 'a', 'failed')] })] } })),
  ).toBe('↺ pipeline is for a previous revision')
})

test('the mini bar splits ten cells in proportion, keeping every non-empty segment', () => {
  const r = request({
    ci: {
      state: 'failed',
      label: 'x',
      pipelines: [pipeline({ jobs: [...Array.from({ length: 35 }, (_, i) => job(`p${i}`, 'p', 'passed')), job('f1', 'f', 'failed'), job('a1', 'a', 'failed', { isAllowedFailure: true }), job('m1', 'm', 'manual')] })],
    },
  })
  const cells = splitCells(jobMix(r), 10)

  expect(cells.passed + cells.failed + cells.allowed + cells.manual + cells.other).toBe(10)
  expect(cells.failed).toBe(1)
  expect(cells.allowed).toBe(1)
  expect(cells.manual).toBe(1)
})

const REPO: MergeWatchRepo = { provider: 'github', host: 'github.com', path: 'octo/app', key: 'github:github.com/octo/app', remoteName: 'origin', webUrl: 'https://github.com/octo/app' }

test('GitHub Retry re-runs failed jobs per run; Merge is pinned to the head commit', async () => {
  const sent: { url: string; method: string; body?: string }[] = []
  const send = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResponse> => {
    sent.push({ url, method: init.method, body: init.body })

    return { status: 200, ok: true, headers: {}, text: '{}' }
  }
  const r = request({
    number: 7,
    headSha: 'h7',
    ci: {
      state: 'failed',
      label: 'Failed',
      pipelines: [
        pipeline({ runId: '501', projectId: null, jobs: [job('1', 'a', 'failed'), job('2', 'b', 'passed')] }),
        pipeline({ runId: '502', projectId: null, jobs: [job('3', 'c', 'passed')] }),
      ],
    },
  })

  expect(await retryFailedGitHub(REPO, send, 'dummy_token_do_not_use', r, 0)).toBe(1)
  await mergeGitHub(REPO, send, 'dummy_token_do_not_use', r, 0)
  expect(sent).toEqual([
    { url: 'https://api.github.com/repos/octo/app/actions/runs/501/rerun-failed-jobs', method: 'POST', body: undefined },
    { url: 'https://api.github.com/repos/octo/app/pulls/7/merge', method: 'PUT', body: '{"sha":"h7"}' },
  ])

  let message = ''

  try {
    await mergeGitHub(REPO, async () => ({ status: 405, ok: false, headers: {}, text: '{"message":"Pull Request is not mergeable"}' }), 'dummy_token_do_not_use', r, 0)
  } catch (error) {
    message = (error as Error).message
  }

  expect(message).toBe('GitHub answered 405: Pull Request is not mergeable')
})

test('summary segments fill the width exactly and every label fits', () => {
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)
  const a = segmentWidths([{ count: 5, min: 9 }, { count: 4, min: 11 }, { count: 1, min: 9 }], 58)

  expect(sum(a)).toBe(58)
  expect(a[2]).toBeGreaterThanOrEqual(9)
  expect(a[0]).toBeGreaterThan(a[1]!)
  const b = segmentWidths([{ count: 40, min: 10 }, { count: 1, min: 11 }], 40)
  expect(sum(b)).toBe(40)
  expect(b[1]).toBe(11)
})

test('a panel state saved by an older version gains the fields this one reads', () => {
  // 0.3.0 wrote no confirm or notices; $.state keeps it across a plugin update in one session.
  const old = { phase: 'ready', repo: null, candidates: [], isRefreshing: false, isChoosing: false, notice: null } as never
  const view = normalizeView(old)

  expect(view.notices).toEqual({})
  expect(view.confirm).toBeNull()
  expect(view.phase).toBe('ready')
  expect(normalizeView(undefined).phase).toBe('idle')
  expect(normalizeView({ notices: { '1': 'Merge requested.' } }).notices).toEqual({ '1': 'Merge requested.' })
})
