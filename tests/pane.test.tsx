import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { answerGlab, fakeGitLab, GL_HOST, GL_PATH, GL_WEB, glJob, glMr, glPipeline } from './fixtures'
import type { FakeGitLab } from './fixtures'

const SURFACES = ['terminal', 'desktop'] as const
const REMOTES_ONE = `origin\tgit@${GL_HOST}:${GL_PATH}.git (fetch)\norigin\tgit@${GL_HOST}:${GL_PATH}.git (push)`
const OTHER_HOST = 'gitlab.other.test'
const REMOTES_TWO = `${REMOTES_ONE}\nupstream\thttps://${OTHER_HOST}/${GL_PATH}.git (fetch)`

type Harness = {
  fake: FakeGitLab
  other: FakeGitLab
  store: Map<string, unknown>
  listCalls: () => number
  toasts: string[]
  opened: Record<string, unknown>[]
  clock: ReturnType<typeof mock.clock>
  slow: { list: number }
  /** glab calls that were not GETs: the write actions. */
  writes: string[][]
}

/** Stubs the engine beneath the mod: git, glab, store, clock and the pane calls. */
function harness(
  on: On,
  options: { remotes?: string; cwd?: string; notGit?: boolean; fake?: FakeGitLab; surfaces?: ('terminal' | 'desktop')[] } = {},
): Harness {
  const h: Harness = {
    fake: options.fake ?? fakeGitLab(),
    other: fakeGitLab({ mrs: [glMr(999, { title: 'From the other host', web_url: `https://${OTHER_HOST}/${GL_PATH}/-/merge_requests/999` })] }),
    store: new Map(),
    listCalls: () => 0,
    toasts: [],
    opened: [],
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 8, 14, 32, 5) }),
    slow: { list: 0 },
    writes: [],
  }
  const calls: string[][] = []
  h.listCalls = () => calls.filter(a => /merge_requests\?state=opened/.test(a[5] ?? '')).length

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: options.cwd ?? '/work/project/nested/dir' }))
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('store.get', (_$, e) => ({ value: h.store.get(e.key) }))
  on('store.set', (_$, e) => {
    h.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    h.opened.push({ ...e })

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    h.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('classic.SessionStart', () => ({}))
  on('session.end', () => ({ sessionId: 'test-session' }))
  const run = (exitCode: number, stdout: string, stderr: string) => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', async (_$, e) => {
    const [cmd, ...args] = e.argv

    if (cmd === 'git') {
      if (options.notGit) {
        return run(128, '', 'fatal: not a git repository')
      }

      if (args.includes('--show-toplevel')) {
        return run(0, '/work/project-worktree\n', '')
      }

      if (args.includes('--git-common-dir')) {
        return run(0, '/work/project/.git\n', '')
      }

      if (args[0] === 'remote') {
        return run(0, options.remotes ?? REMOTES_ONE, '')
      }
    }

    if (cmd === 'glab') {
      calls.push([...args])

      if (args[4] !== 'GET') {
        h.writes.push([...args])

        return run(0, '{}', '')
      }

      const host = args[2]
      const isList = /merge_requests\?state=opened/.test(args[5] ?? '')

      if (isList && h.slow.list > 0) {
        await h.clock.sleep(h.slow.list)
      }

      const r = answerGlab(host === OTHER_HOST ? h.other : h.fake, args)

      return run(r.exitCode, r.stdout, r.stderr)
    }

    return run(127, '', `unexpected command ${String(cmd)}`)
  })

  return h
}

function pane(surface: RenderSurface, bodyColumns = 80) {
  return {
    plugin: 'merge-watch',
    surface,
    component: 'Pane' as const,
    requestId: 'merge-watch',
    viewport: { columns: bodyColumns + 4, rows: 40 },
    props: {
      title: 'Merge Watch',
      isFocused: false,
      bodyColumns,
      placement: 'dock' as const,
      scroll: { offset: 0, bodyRows: 36 },
      view: {},
    },
  }
}

/** Starts a session, then starts Merge Watch the only way it starts: /merge-watch. */
async function start($: Engine, h: Harness): Promise<void> {
  await $.session.start({ cwd: '/work/project/nested/dir', surface: 'terminal', isInteractive: true })
  await command($, '')
  await h.clock.settle()
}

async function command($: Engine, args: string): Promise<string | undefined> {
  const r = await $.command.run({ command: 'merge-watch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  return r.text
}

function sample(): FakeGitLab {
  return fakeGitLab({
    mrs: [
      glMr(142, { title: 'Add the pricing page', updated_at: '2026-10-08T14:00:00Z', source_branch: 'pricing-page', author: { username: 'alex' } }),
      glMr(139, { title: 'Fix checkout validation', updated_at: '2026-10-08T13:00:00Z', source_branch: 'fix-checkout', author: { username: 'sam' } }),
      glMr(136, { title: 'Update account settings', updated_at: '2026-10-08T13:00:00Z', draft: true }),
    ],
    details: {
      '142': { ...glMr(142, { title: 'Add the pricing page', updated_at: '2026-10-08T14:00:00Z', source_branch: 'pricing-page' }), sha: 'p142', detailed_merge_status: 'not_approved', head_pipeline: glPipeline(830, 'p142', { status: 'running' }) },
      '139': { ...glMr(139, { title: 'Fix checkout validation', updated_at: '2026-10-08T13:00:00Z' }), sha: 'p139', detailed_merge_status: 'requested_changes', head_pipeline: glPipeline(829, 'p139', { status: 'failed' }) },
    },
    jobs: {
      '830': [glJob(1, 'lint', 'success'), glJob(2, 'unit tests', 'success'), glJob(3, 'build', 'running'), glJob(4, 'deploy preview', 'pending')],
      '829': [glJob(5, 'lint', 'success'), glJob(6, 'integration tests', 'failed'), glJob(7, 'deploy preview', 'skipped')],
    },
  })
}

type Found = { text: string; type: string; props: Record<string, unknown> }
type Finder = { findAll: (q: { type?: string }) => Promise<Found[]> }

/** The Link whose label starts with `label` (Links carry no key). */
async function link(ui: Finder, label: string): Promise<Found | undefined> {
  return (await ui.findAll({ type: 'Link' })).find(l => String(l.props.label).startsWith(label))
}

/** The Link for one GitLab job id. */
async function jobLink(ui: Finder, id: number): Promise<Found | undefined> {
  return (await ui.findAll({ type: 'Link' })).find(l => String(l.props.href).endsWith(`/-/jobs/${id}`))
}

async function texts(ui: { findAll: (q: { type?: string }) => Promise<{ text: string; type: string; props: Record<string, unknown> }[]> }): Promise<string> {
  const all = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Link' })), ...(await ui.findAll({ type: 'Button' }))]
  // The desktop summary bar is an SVG; its alt text says what it shows.
  const svgs = await ui.findAll({ type: 'Svg' })

  return [...all.map(e => e.text || String(e.props.label ?? '')), ...svgs.map(e => String(e.props.alt ?? ''))].join('\n')
}

test('6/7. grouped rows on terminal and desktop; the title toggles, Open MR and jobs link out', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    let all = await texts(ui)

    expect(all).toContain(`Merge Watch · ${GL_PATH}`)
    expect(all).toContain('PIPELINE FAILING')
    expect(all).toContain('DRAFTS')
    expect(all).not.toContain('READY TO MERGE')
    expect(all).toContain('2 failing')
    expect(all).toContain('1 draft')
    expect(all).toContain('3 of 3 open · updated')
    // Collapsed by default: the cleaned title is the row's toggle, with a reason line under it.
    expect((await ui.find({ key: 'toggle-142' }))?.props.label).toBe('Add the pricing page')
    expect(all).toContain('▶ running — build')
    expect(all).toContain('✕ integration tests')
    expect(await link(ui, 'Open MR')).toBeUndefined()

    await ui.press({ key: 'toggle-139' })
    all = await texts(ui)
    expect((await link(ui, 'Open MR'))?.props.href).toBe(`${GL_WEB}/-/merge_requests/139`)
    expect((await jobLink(ui, 6))?.props.label).toBe('integration tests')
    expect(all).toContain('Open · Changes requested')
    expect(all).not.toContain('Changes requested · Changes requested')
    expect(all).toContain('#829 · 1 passed · 1 failed · 1 skipped')
    expect(await ui.find({ key: 'retry-139' })).toBeDefined()
    await ui.press({ key: 'toggle-139' })
    await ui.unmount()
  }

  expect(h.opened[0]).toEqual({ id: 'merge-watch', title: 'Merge Watch', focus: true })
})

test('the job table lists failures, running and allowed failures, five at a time', async ($, on) => {
  const fake = sample()
  fake.jobs['829']!.push(
    glJob(8, 'dependency-audit', 'failed', { allow_failure: true }),
    ...Array.from({ length: 6 }, (_, i) => glJob(20 + i, `shard ${i + 1}`, 'failed')),
  )
  const h = harness(on, { fake })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'toggle-139' })
    let all = await texts(ui)

    // Seven real failures: the reason line summarises, the table shows five and a toggle.
    expect(all).toContain('✕ 7 jobs failing — integration tests, shard 1, shard 2…')
    expect(await jobLink(ui, 5)).toBeUndefined()
    expect((await jobLink(ui, 8))?.props.label).toBe('dependency-audit')
    expect(all).toContain('allowed')
    expect(await jobLink(ui, 25)).toBeUndefined()
    expect((await ui.find({ key: 'more-139' }))?.props.label).toBe('+2 more failed')
    await ui.press({ key: 'more-139' })
    expect(await jobLink(ui, 25)).toBeDefined()
    expect((await ui.find({ key: 'more-139' }))?.props.label).toBe('Show fewer')
    await ui.press({ key: 'more-139' })
    await ui.press({ key: 'toggle-139' })
    all = await texts(ui)
    expect(all).not.toContain('dependency-audit')
    await ui.unmount()
  }
})

test('ready, failing and draft groups follow mergeability, not CI alone', async ($, on) => {
  const fake = sample()
  fake.mrs.push(glMr(150, { title: 'docs(adr): add ADR-1000 buttons', updated_at: '2026-10-08T14:10:00Z' }))
  fake.details['150'] = {
    ...glMr(150, { title: 'docs(adr): add ADR-1000 buttons', updated_at: '2026-10-08T14:10:00Z' }),
    sha: 'p150',
    detailed_merge_status: 'mergeable',
    reviewers: [{ username: 'sam' }],
    head_pipeline: glPipeline(850, 'p150', { status: 'success', detailed_status: { group: 'success-with-warnings' } }),
  }
  fake.approvals['150'] = { approved: false, approvals_left: 0, approved_by: [] }
  fake.jobs['850'] = [glJob(30, 'lint', 'success'), glJob(31, 'dependency-audit', 'failed', { allow_failure: true })]
  const h = harness(on, { fake })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))
  const all = await texts(ui)

  expect(all).toContain('READY TO MERGE')
  expect(all).toContain('1 ready')
  expect((await ui.find({ key: 'toggle-150' }))?.props.label).toBe('add ADR-1000 buttons')
  expect(all).toContain('✓ needs review · 1 allowed failure')
  // Awaiting review: the primary action is Review (a link), not Merge.
  await ui.press({ key: 'toggle-150' })
  expect((await link(ui, 'Review'))?.props.href).toBe(`${GL_WEB}/-/merge_requests/150`)
  expect(await ui.find({ key: 'merge-150' })).toBeUndefined()
})

test('7. narrow panes and long lists keep every request reachable', async ($, on) => {
  const many = fakeGitLab({ mrs: Array.from({ length: 60 }, (_, i) => glMr(i + 1)) })
  const h = harness(on, { fake: many })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface, 28))
    const toggles = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key ?? '').startsWith('toggle-'))

    expect(toggles).toHaveLength(60)
    await ui.unmount()
  }
})

test('6/11. the chevron expands a row, and the choice is saved per repository', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  expect(await jobLink(ui, 3)).toBeUndefined()
  await ui.press({ key: 'chev-142' })
  expect((await jobLink(ui, 3))?.props.label).toBe('build')
  expect(h.store.get(`expanded:gitlab:${GL_HOST}/${GL_PATH}`)).toEqual({ '142': true })
  await ui.press({ key: 'chev-142' })
  expect(await jobLink(ui, 3)).toBeUndefined()

  // ⤢ opens every row, and again closes them all.
  await ui.press({ key: 'expand' })
  expect(await jobLink(ui, 3)).toBeDefined()
  expect(await jobLink(ui, 6)).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await jobLink(ui, 6)).toBeUndefined()
})

test('8. fetches at once, then every 60 seconds, without overlapping refreshes', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)

  expect(h.listCalls()).toBe(1)
  await h.clock.advance(59_000)
  expect(h.listCalls()).toBe(1)
  await h.clock.advance(1_000)
  expect(h.listCalls()).toBe(2)

  // A slow refresh: the next manual refreshes join it instead of starting more.
  h.slow.list = 10_000
  await h.clock.advance(60_000)
  expect(h.listCalls()).toBe(3)
  expect(await command($, 'refresh')).toBe('Refreshing Merge Watch.')
  await command($, 'refresh')
  expect(h.listCalls()).toBe(3)
  h.slow.list = 0
  await h.clock.advance(10_000)
  expect(h.listCalls()).toBe(3)
})

test('9. off stops polling, on resumes at once; repeated on and session.start never double the timer', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)
  expect(h.listCalls()).toBe(1)

  await command($, 'off')
  await h.clock.advance(180_000)
  expect(h.listCalls()).toBe(1)
  expect(h.store.get('checkout:/work/project/.git')).toEqual({ enabled: false })

  await command($, 'on')
  await h.clock.settle()
  expect(h.listCalls()).toBe(2)
  await command($, 'on')
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await h.clock.settle()
  const afterRepeats = h.listCalls()
  await h.clock.advance(60_000)
  expect(h.listCalls()).toBe(afterRepeats + 1)
})

test('9/11. a late answer for the previous repository is discarded after switching', async ($, on) => {
  const h = harness(on, { fake: sample(), remotes: REMOTES_TWO })
  h.slow.list = 5_000
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await command($, '')
  await h.clock.settle()
  expect(h.listCalls()).toBe(1)

  expect(await command($, 'repo upstream')).toBe(`Merge Watch now watches ${OTHER_HOST}/${GL_PATH}.`)
  h.slow.list = 0
  await h.clock.advance(5_000)
  await h.clock.settle()

  const ui = await $.ui.mount(pane('terminal'))

  expect((await ui.find({ key: 'toggle-999' }))?.props.label).toBe('From the other host')
  expect(await ui.find({ key: 'toggle-142' })).toBeUndefined()
  expect(h.store.get('checkout:/work/project/.git')).toMatchObject({ selection: `gitlab:${OTHER_HOST}/${GL_PATH}` })
})

test('1. ambiguous remotes show a selector instead of guessing', async ($, on) => {
  const remotes = `upstream\tgit@${GL_HOST}:${GL_PATH}.git (fetch)\nmirror\thttps://${OTHER_HOST}/${GL_PATH}.git (fetch)`
  const h = harness(on, { remotes })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  expect(h.listCalls()).toBe(0)
  expect(await ui.find({ key: 'pick-upstream' })).toBeDefined()
  await ui.press({ key: 'pick-mirror' })
  await h.clock.settle()
  // Picking one starts monitoring it straight away.
  expect(h.listCalls()).toBe(1)
  expect(h.store.get('checkout:/work/project/.git')).toEqual({ selection: `gitlab:${OTHER_HOST}/${GL_PATH}` })
})

test('1. outside a Git repository the pane says so', async ($, on) => {
  const h = harness(on, { notGit: true })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  expect(await texts(ui)).toContain('Open a Git project to use Merge Watch.')
  expect(h.listCalls()).toBe(0)
})

test('10. a failed refresh keeps the last data, labelled stale; rate limits slow polling', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)

  h.fake.failures['merge_requests/139'] = 'HTTP 500 Internal Server Error'
  await h.clock.advance(60_000)
  let ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-139' })
  let all = await texts(ui)

  expect(all).toContain("! Couldn't refresh !139")
  expect(all).toContain('✕ integration tests')
  expect(await ui.find({ key: 'toggle-142' })).toBeDefined()
  await ui.press({ key: 'toggle-139' })
  await ui.unmount()

  h.fake.failures = { merge_requests: '429 Too Many Requests' }
  await h.clock.advance(60_000)
  const calls = h.listCalls()
  ui = await $.ui.mount(pane('terminal'))
  all = await texts(ui)

  expect(all).toContain("! Couldn't refresh: GitLab is rate limiting")
  expect(all).toContain('Showing stale data from')
  expect(all).toContain('Polling slowed by the provider. Next try at')
  expect(await ui.find({ key: 'toggle-142' })).toBeDefined()
  // Stale data can never sit in READY TO MERGE.
  expect(all).not.toContain('READY TO MERGE')
  await h.clock.advance(60_000)
  expect(h.listCalls()).toBe(calls)
})

test('10. missing GitLab sign-in shows setup instructions, no token is asked for', async ($, on) => {
  const h = harness(on, { fake: fakeGitLab({ failures: { merge_requests: 'glab: 401 Unauthorized' } }) })
  await start($, h)
  const all = await texts(await $.ui.mount(pane('terminal')))

  expect(all).toContain(`glab auth login --hostname ${GL_HOST}`)
  expect(all).not.toContain('paste')
})

test('10. a timed-out glab call is reported, never shown as passing', async ($, on) => {
  const h = harness(on, { fake: sample() })
  h.fake.failures['pipelines/830/jobs'] = 'glab: context deadline exceeded (timeout)'
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-142' })
  const all = await texts(ui)

  expect(all).toContain('Jobs unavailable')
  expect(all).not.toContain('READY TO MERGE')
})

test('11. expansion choices do not leak between repositories', async ($, on) => {
  const h = harness(on, { fake: sample() })
  h.store.set(`expanded:gitlab:${OTHER_HOST}/${GL_PATH}`, { '139': true })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  // The other host's saved expansion does not open !139 here.
  expect(await jobLink(ui, 6)).toBeUndefined()
})

test('requests idle for 14 days hide behind "show all", remembered per repository', async ($, on) => {
  const fake = sample()
  fake.mrs.push(glMr(90, { title: 'Old idea', updated_at: '2026-09-01T00:00:00Z' }))
  const h = harness(on, { fake })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  expect(await ui.find({ key: 'toggle-90' })).toBeUndefined()
  expect(await texts(ui)).toContain('3 of 4 open')
  await ui.press({ key: 'show-all' })
  expect(await ui.find({ key: 'toggle-90' })).toBeDefined()
  expect(await texts(ui)).toContain('4 of 4 open')
  expect(h.store.get(`showAll:gitlab:${GL_HOST}/${GL_PATH}`)).toBe(true)
  expect((await ui.find({ key: 'show-all' }))?.props.label).toBe('show recent')
})

test('Retry failed asks first, then retries only real failures in the owning project', async ($, on) => {
  const fake = sample()
  fake.jobs['829']!.push(glJob(8, 'dependency-audit', 'failed', { allow_failure: true }))
  const h = harness(on, { fake })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-139' })

  await ui.press({ key: 'retry-139' })
  expect(h.writes).toHaveLength(0)
  expect((await ui.find({ key: 'confirm-139' }))?.props.label).toBe('Confirm retry of 1 job')
  await ui.press({ key: 'cancel-139' })
  expect(h.writes).toHaveLength(0)

  await ui.press({ key: 'retry-139' })
  await ui.press({ key: 'confirm-139' })
  await h.clock.settle()
  expect(h.writes).toEqual([['api', '--hostname', GL_HOST, '--method', 'POST', 'projects/1/jobs/6/retry']])
  expect(await texts(ui)).toContain('Retried 1 failed job.')
})

test('Merge asks first and pins the merge to the commit shown', async ($, on) => {
  const fake = sample()
  fake.mrs.push(glMr(160, { title: 'feat: ship it', updated_at: '2026-10-08T14:20:00Z' }))
  fake.details['160'] = { ...glMr(160, { title: 'feat: ship it' }), sha: 'abc160', detailed_merge_status: 'mergeable', user: { can_merge: true }, head_pipeline: glPipeline(860, 'abc160', { status: 'success' }) }
  fake.approvals['160'] = { approved: true, approvals_left: 0, approved_by: [{ user: { username: 'sam' } }] }
  fake.jobs['860'] = [glJob(40, 'lint', 'success')]
  const h = harness(on, { fake })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-160' })

  await ui.press({ key: 'merge-160' })
  expect(h.writes).toHaveLength(0)
  await ui.press({ key: 'confirm-160' })
  await h.clock.settle()
  expect(h.writes).toEqual([
    ['api', '--hostname', GL_HOST, '--method', 'PUT', `projects/${encodeURIComponent(GL_PATH)}/merge_requests/160/merge`, '--raw-field', 'sha=abc160'],
  ])
})

test('the desktop app draws the summary and pipeline bars as SVG; the terminal uses text', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)
  const desktop = await $.ui.mount(pane('desktop'))
  const svgs = await desktop.findAll({ type: 'Svg' })

  expect(svgs.length).toBe(4)
  expect(String(svgs[0]?.props.alt)).toBe('2 failing, 1 draft')
  await desktop.unmount()
  const terminal = await $.ui.mount(pane('terminal'))
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('starting a session does nothing until /merge-watch is run', async ($, on) => {
  const h = harness(on, { fake: sample(), surfaces: ['desktop'] })
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })
  await h.clock.advance(180_000)

  expect(h.listCalls()).toBe(0)
  expect(h.opened).toHaveLength(0)
})

test('7. in the desktop app (isInteractive false, surface attached) /merge-watch starts it', async ($, on) => {
  const h = harness(on, { fake: sample(), surfaces: ['desktop'] })
  await $.session.start({ cwd: '/work/project', surface: null, isInteractive: false })
  expect(h.listCalls()).toBe(0)

  await command($, '')
  await h.clock.settle()
  expect(h.listCalls()).toBe(1)
  expect(h.opened).toEqual([{ id: 'merge-watch', title: 'Merge Watch', focus: true }])
  await h.clock.advance(60_000)
  expect(h.listCalls()).toBe(2)
})

test('7. with no app attached (claude -p) the command explains instead of polling', async ($, on) => {
  const h = harness(on, { fake: sample(), surfaces: [] })
  await $.session.start({ cwd: '/work/project', surface: null, isInteractive: false })

  expect(await command($, '')).toContain('needs an app that can show its panel')
  await h.clock.advance(120_000)
  expect(h.listCalls()).toBe(0)
  expect(h.opened).toHaveLength(0)
})

test('hide and off before starting say it is not running', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: true })

  expect(await command($, 'hide')).toContain("isn't running")
  expect(await command($, 'off')).toContain("isn't running")
  expect(h.listCalls()).toBe(0)
})

test('7. non-interactive sessions never poll or open the pane', async ($, on) => {
  const h = harness(on, { fake: sample(), surfaces: [] })
  await $.session.start({ cwd: '/work/project', surface: null, isInteractive: false })
  await h.clock.advance(120_000)

  expect(h.listCalls()).toBe(0)
  expect(h.opened).toHaveLength(0)
})

test('commands: hide keeps monitoring, bare command opens with focus', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)

  expect(await command($, 'hide')).toContain('still refreshing')
  await h.clock.advance(60_000)
  expect(h.listCalls()).toBe(2)
  await command($, '')
  expect(h.opened.at(-1)).toEqual({ id: 'merge-watch', title: 'Merge Watch', focus: true })
  expect(await command($, 'bogus')).toContain('/merge-watch refresh')
})
