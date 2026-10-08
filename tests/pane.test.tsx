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

  return all.map(e => e.text || String(e.props.label ?? '')).join('\n')
}

test('6/7. requests render on terminal and desktop; titles and jobs link to their exact pages', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    const title = await link(ui, '!142 ')
    const job = await jobLink(ui, 6)
    const all = await texts(ui)

    expect(title?.type).toBe('Link')
    expect(title?.props.href).toBe(`${GL_WEB}/-/merge_requests/142`)
    expect(title?.props.label).toBe('!142 Add the pricing page')
    expect(job?.props.href).toBe(`${GL_WEB}/-/jobs/6`)
    expect(job?.props.label).toBe('integration tests')
    expect(all).toContain(`Merge Watch · ${GL_PATH}`)
    expect(all).toContain('3 open MRs · Updated')
    expect(all).toContain('▶ Running')
    expect(all).toContain('✕ Failed')
    expect(all).toContain('Changes requested')
    expect(all).toContain('pricing-page → main · by alex')
    expect(all).toContain('· No pipeline')
    // Sorted newest first, ties broken by number: 142, 139, 136.
    const order = (await ui.findAll({ type: 'Link' })).map(l => String(l.props.label)).filter(l => l.startsWith('!'))
    expect(order).toEqual(['!142 Add the pricing page', '!139 Fix checkout validation', '!136 Update account settings'])
    // The arrow is its own control; the title stays a link.
    expect((await ui.find({ key: 'toggle-142' }))?.type).toBe('Button')
    await ui.unmount()
  }

  expect(h.opened[0]).toEqual({ id: 'merge-watch', title: 'Merge Watch', focus: true })
})

test('only running, failed and blocking jobs get a row; the rest are counted', async ($, on) => {
  const fake = sample()
  fake.jobs['829']!.push(glJob(8, 'dependency-audit', 'failed', { allow_failure: true }), glJob(9, 'deploy', 'manual', { allow_failure: false }), glJob(10, 'optional', 'manual', { allow_failure: true }))
  const h = harness(on, { fake })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    const all = await texts(ui)

    // Passed, pending and skipped jobs have no row of their own.
    expect(await jobLink(ui, 1)).toBeUndefined()
    expect(await jobLink(ui, 4)).toBeUndefined()
    expect(await jobLink(ui, 7)).toBeUndefined()
    expect(await jobLink(ui, 10)).toBeUndefined()
    // Running, failed (allowed too) and blocking manual jobs do.
    expect((await jobLink(ui, 3))?.props.label).toBe('build')
    expect((await jobLink(ui, 6))?.props.label).toBe('integration tests')
    expect((await jobLink(ui, 8))?.props.label).toBe('dependency-audit')
    expect((await jobLink(ui, 9))?.props.label).toBe('deploy')
    expect(all).toContain('Failed (allowed)')
    // Every job is still accounted for on the pipeline line.
    expect(all).toContain('2 passed · 1 running · 1 pending')
    expect(all).toContain('1 passed · 2 failed · 2 manual · 1 skipped')
    await ui.unmount()
  }
})

test('a collapsed request is two lines: title and status', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-139' })
  const all = await texts(ui)

  expect(all).toContain('Open · Changes requested · Not ready to merge · Changes requested')
  expect(await jobLink(ui, 6)).toBeUndefined()
  expect(all).not.toContain('fix-checkout → main')
})

test('7. narrow panes and long lists keep every request reachable', async ($, on) => {
  const many = fakeGitLab({ mrs: Array.from({ length: 60 }, (_, i) => glMr(i + 1)) })
  const h = harness(on, { fake: many })
  await start($, h)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface, 28))
    const links = (await ui.findAll({ type: 'Link' })).filter(l => String(l.props.label).startsWith('!'))

    expect(links).toHaveLength(60)
    await ui.unmount()
  }
})

test('6/11. the arrow collapses a request without opening it, and the choice is saved per repository', async ($, on) => {
  const h = harness(on, { fake: sample() })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  expect(await jobLink(ui, 3)).toBeDefined()
  await ui.press({ key: 'toggle-142' })
  expect(await jobLink(ui, 3)).toBeUndefined()
  expect(await link(ui, '!142 ')).toBeDefined()
  expect(h.store.get(`expanded:gitlab:${GL_HOST}/${GL_PATH}`)).toEqual({ '142': false })
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
  const labels = (await ui.findAll({ type: 'Link' })).map(l => String(l.props.label))

  expect(labels).toContain('!999 From the other host')
  expect(labels.some(l => l.includes('pricing'))).toBe(false)
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
  let all = await texts(ui)

  expect(all).toContain("! Couldn't refresh !139")
  expect(all).toContain('✕ Failed (stale)')
  expect(await link(ui, '!142 ')).toBeDefined()
  await ui.unmount()

  h.fake.failures = { merge_requests: '429 Too Many Requests' }
  await h.clock.advance(60_000)
  const calls = h.listCalls()
  ui = await $.ui.mount(pane('terminal'))
  all = await texts(ui)

  expect(all).toContain("! Couldn't refresh: GitLab is rate limiting")
  expect(all).toContain('Showing stale data from')
  expect(all).toContain('Polling slowed by the provider. Next try at')
  expect(await link(ui, '!142 ')).toBeDefined()
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
  const all = await texts(await $.ui.mount(pane('terminal')))

  expect(all).toContain('Jobs unavailable')
  expect(all).not.toContain('✓ Passed\n')
})

test('11. expansion choices do not leak between repositories', async ($, on) => {
  const h = harness(on, { fake: sample() })
  h.store.set(`expanded:gitlab:${OTHER_HOST}/${GL_PATH}`, { '142': false })
  await start($, h)
  const ui = await $.ui.mount(pane('terminal'))

  // The other host's saved collapse does not apply here.
  expect(await jobLink(ui, 3)).toBeDefined()
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
