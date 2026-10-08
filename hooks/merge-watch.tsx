// Merge Watch: the pane, its commands, and the once-a-minute refresh.
// Fetching lives in the adapters (gitlab.ts, github.ts); this file schedules, merges and draws.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderElement, Timer } from 'claude-code'

import type {
  MergeWatchPipeline,
  MergeWatchRepo,
  MergeWatchRequest,
  MergeWatchSnapshot,
  MergeWatchView,
} from '../types'
import { fetchGitHub, mergeGitHub, retryFailedGitHub } from './github'
import type { HttpResponse, HttpSend } from './github'
import { fetchGitLab, mergeGitLab, retryFailedGitLab } from './gitlab'
import type { GlabRunner } from './gitlab'
import { chooseRepo, reposFromRemotes, splitHosts } from './repo'
import type { HostConfig } from './repo'
import { cleanError } from './safe'
import { AuthError, RateLimitError, jobCounts, sortRequests } from './status'
import {
  FAILURES_SHOWN,
  GROUP_LABEL,
  GROUP_ORDER,
  allowedFailures,
  currentJobs,
  groupOf,
  isStale,
  jobMix,
  pipelineSummary,
  realFailures,
  reasonLine,
  splitCells,
  stripPrefix,
} from './view-model'
import type { Group, JobMix } from './view-model'

type $ = EngineInterface

// Design tokens. Colours are fixed hex (from the design's oklch values) because both the terminal
// and the desktop app accept hex; tinted fills always set their own text colour, so they read in
// light and dark themes alike.
const C = {
  muted: '#8a8984',
  faint: '#9a9893',
  hairline: '#ebe9e4',
  green: '#137738',
  red: '#b6322d',
  amber: '#9a6500',
  blue: '#2f6fb3',
} as const

const TINT: Record<Group, { bg: string; fg: string }> = {
  ready: { bg: '#d1f2d7', fg: '#005725' },
  failing: { bg: '#ffdeda', fg: '#9b1f1d' },
  draft: { bg: '#efeee9', fg: '#5a5955' },
}

const BAR = {
  passed: C.green,
  failed: C.red,
  allowed: C.amber,
  manual: '#d6d4ce',
  other: '#d6d4ce',
} as const

export const PANE_ID = 'merge-watch'
export const REFRESH_MS = 60_000
const HTTP_TIMEOUT_MS = 20_000
const GLAB_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 10_000

const INITIAL_VIEW: MergeWatchView = {
  phase: 'idle',
  repo: null,
  candidates: [],
  isRefreshing: false,
  isChoosing: false,
  notice: null,
  confirm: null,
  notices: {},
}

const viewAtom = atom({ plugin: 'merge-watch', key: 'view' } as const, INITIAL_VIEW)
const snapshotAtom = atom({ plugin: 'merge-watch', key: 'snapshot' } as const, null)
const expandedAtom = atom({ plugin: 'merge-watch', key: 'expanded' } as const, {})
const showAllAtom = atom({ plugin: 'merge-watch', key: 'showAll' } as const, false)
const moreFailedAtom = atom({ plugin: 'merge-watch', key: 'moreFailed' } as const, {})

// Module state. A hot reload starts it over, and the host drops the old module's timers,
// so a reload never leaves a second timer running.
let timer: Timer | undefined
let generation = 0
let inflight: Promise<void> | null = null
let inflightGeneration = -1
let checkout: { top: string; common: string } | null = null
let hosts: HostConfig = { githubHosts: [], gitlabHosts: [] }
let githubTokenOption: string | undefined
// Mirrors of $.state, so /clear (which resets $.state) can put the pane back as it was.
let lastView: MergeWatchView = INITIAL_VIEW
let lastSnapshot: MergeWatchSnapshot | null = null
let lastExpanded: Record<string, boolean> = {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatTime(ms: number | null): string {
  if (ms === null) {
    return '—'
  }

  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function noun(repo: MergeWatchRepo | null, count: number): string {
  const word = repo?.provider === 'github' ? 'PR' : 'MR'

  return `${count} open ${word}${count === 1 ? '' : 's'}`
}

/**
 * Folds a fresh result into the previous one: a request whose details failed this time keeps
 * its last good data, labelled stale with the time it dates from.
 */
export function mergeRequests(
  previous: MergeWatchSnapshot | null,
  fresh: readonly MergeWatchRequest[],
): MergeWatchRequest[] {
  const before = new Map((previous?.requests ?? []).map(r => [r.key, r]))

  return sortRequests(
    fresh.map(r => {
      if (r.error === null) {
        return r
      }

      const old = before.get(r.key)

      if (old === undefined || (old.error !== null && old.staleSince === null)) {
        return r
      }

      return { ...old, title: r.title, error: r.error, staleSince: old.staleSince ?? previous?.fetchedAt ?? null }
    }),
  )
}

/** After a failed refresh: the previous data stays, every request marked stale. */
export function staleSnapshot(
  previous: MergeWatchSnapshot | null,
  repoKey: string,
  patch: Pick<MergeWatchSnapshot, 'error' | 'authHelp' | 'nextRetryAt'>,
): MergeWatchSnapshot {
  if (previous === null || previous.repoKey !== repoKey) {
    return { repoKey, fetchedAt: null, requests: [], ...patch }
  }

  return {
    ...previous,
    ...patch,
    requests: previous.requests.map(r => ({ ...r, staleSince: r.staleSince ?? previous.fetchedAt })),
  }
}

// ---------------------------------------------------------------------------
// State writes (each mirrored for /clear)
// ---------------------------------------------------------------------------

/**
 * Fills in any field an older version of Merge Watch did not write. $.state outlives a plugin
 * update within a session, so a view saved by an earlier release can lack newer fields.
 */
export function normalizeView(v: Partial<MergeWatchView> | null | undefined): MergeWatchView {
  return {
    ...INITIAL_VIEW,
    ...(v ?? {}),
    candidates: Array.isArray(v?.candidates) ? v.candidates : [],
    confirm: v?.confirm ?? null,
    notices: v?.notices !== null && typeof v?.notices === 'object' ? v.notices : {},
  }
}

async function readView($: $): Promise<MergeWatchView> {
  return normalizeView(await read($, viewAtom))
}

async function setView($: $, fn: (v: MergeWatchView) => MergeWatchView): Promise<void> {
  await update($, viewAtom, v => {
    lastView = fn(normalizeView(v))

    return lastView
  })
}

async function setSnapshot($: $, value: MergeWatchSnapshot | null): Promise<void> {
  lastSnapshot = value
  await update($, snapshotAtom, () => value)
}

async function setExpanded($: $, value: Record<string, boolean>): Promise<void> {
  lastExpanded = value
  await update($, expandedAtom, () => value)
}

// ---------------------------------------------------------------------------
// Repository and preferences
// ---------------------------------------------------------------------------

type CheckoutPrefs = { enabled?: boolean; selection?: string }

/** Preferences for this checkout: keyed by the git common dir, shared by its worktrees. */
async function loadCheckoutPrefs($: $): Promise<CheckoutPrefs> {
  if (checkout === null) {
    return {}
  }

  const saved = await $.store.get(`checkout:${checkout.common}`)

  return saved !== null && typeof saved === 'object' ? (saved as CheckoutPrefs) : {}
}

async function saveCheckoutPrefs($: $, patch: CheckoutPrefs): Promise<void> {
  if (checkout === null) {
    return
  }

  const key = `checkout:${checkout.common}`
  const current = await $.store.get(key)
  const base = current !== null && typeof current === 'object' ? (current as CheckoutPrefs) : {}
  await $.store.set(key, { ...base, ...patch })
}

async function git($: $, args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const result = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })

    return result.exitCode === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

/** Finds the checkout from the session's directory (nested folders and worktrees included) and picks a repo. */
async function resolveRepo($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const top = await git($, ['rev-parse', '--show-toplevel'], cwd)

  if (top === null || top === '') {
    checkout = null
    await setView($, v => ({ ...v, phase: 'not-git', repo: null, candidates: [] }))

    return
  }

  const common = (await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'], top)) ?? top
  checkout = { top, common }
  const remotes = (await git($, ['remote', '-v'], top)) ?? ''
  const candidates = reposFromRemotes(remotes, hosts)
  const prefs = await loadCheckoutPrefs($)
  const choice = chooseRepo(candidates, prefs.selection ?? null)

  if (choice.kind === 'none') {
    await setView($, v => ({ ...v, phase: 'no-remote', repo: null, candidates: [] }))

    return
  }

  if (choice.kind === 'ambiguous') {
    await setView($, v => ({ ...v, phase: 'choose-repo', repo: null, candidates: choice.candidates, isChoosing: true }))

    return
  }

  await useRepo($, choice.repo, choice.candidates, prefs.enabled !== false)
}

async function useRepo($: $, repo: MergeWatchRepo, candidates: MergeWatchRepo[], enabled: boolean): Promise<void> {
  const saved = await $.store.get(`expanded:${repo.key}`)
  await setExpanded($, saved !== null && typeof saved === 'object' ? (saved as Record<string, boolean>) : {})
  const showAll = (await $.store.get(`showAll:${repo.key}`)) === true
  await update($, showAllAtom, () => showAll)

  const snapshot = await read($, snapshotAtom)

  if (snapshot !== null && snapshot.repoKey !== repo.key) {
    await setSnapshot($, null)
  }

  await setView($, v => ({ ...v, phase: enabled ? 'ready' : 'off', repo, candidates, isChoosing: false }))
}

async function selectRepo($: $, repo: MergeWatchRepo): Promise<void> {
  const view = await readView($)
  await saveCheckoutPrefs($, { selection: repo.key })
  const prefs = await loadCheckoutPrefs($)
  await useRepo($, repo, view.candidates, prefs.enabled !== false)

  if (prefs.enabled !== false) {
    startMonitoring($)
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Races `work` against a timeout on the mods clock; the late answer is ignored. */
async function withTimeout<T>($: $, work: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = $.clock.after(ms, () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)))
  })

  try {
    return await Promise.race([work, timeout])
  } finally {
    handle?.cancel()
  }
}

/** Runs glab by argument vector in the checkout; rejects with its stderr. */
function glabFor($: $): GlabRunner {
  const cwd = checkout?.top

  return async args => {
    const result = await $.process.run(['glab', ...args], { cwd, timeoutMs: GLAB_TIMEOUT_MS })

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `glab exited with ${result.exitCode}`)
    }

    return result.stdout
  }
}

/** Any-method HTTP for the GitHub write actions, with the same timeout as reads. */
function sendFor($: $): HttpSend {
  return (url, init) => withTimeout<HttpResponse>($, $.http.fetch(url, init), HTTP_TIMEOUT_MS, 'GitHub request')
}

async function githubToken($: $): Promise<string | undefined> {
  return githubTokenOption ?? (await $.env.get('GITHUB_TOKEN')) ?? (await $.env.get('GH_TOKEN'))
}

async function fetchRequests($: $, repo: MergeWatchRepo, now: number): Promise<MergeWatchRequest[]> {
  if (repo.provider === 'gitlab') {
    return fetchGitLab(repo, glabFor($), now)
  }

  const token = await githubToken($)

  return fetchGitHub(
    repo,
    (url, headers) => withTimeout<HttpResponse>($, $.http.fetch(url, { method: 'GET', headers }), HTTP_TIMEOUT_MS, 'GitHub request'),
    token,
    now,
  )
}

/**
 * Refreshes once. A call while a refresh of the same monitoring generation is running joins it.
 * A result that arrives after the repository or generation changed is thrown away.
 */
async function refresh($: $, isManual: boolean): Promise<void> {
  if (inflight !== null) {
    if (inflightGeneration === generation) {
      return inflight
    }

    await inflight.catch(() => undefined)
  }

  const view = await readView($)
  const repo = view.repo

  if (view.phase !== 'ready' || repo === null) {
    return
  }

  const now = await $.clock.now()
  const previous = await read($, snapshotAtom)

  if (!isManual && previous?.repoKey === repo.key && previous.nextRetryAt !== null && previous.nextRetryAt > now) {
    return
  }

  const gen = generation
  inflightGeneration = gen
  inflight = (async () => {
    await setView($, v => ({ ...v, isRefreshing: true }))

    try {
      const fresh = await fetchRequests($, repo, now)
      const current = await readView($)

      if (gen !== generation || current.repo?.key !== repo.key) {
        return
      }

      const before = await read($, snapshotAtom)
      await setSnapshot($, {
        repoKey: repo.key,
        fetchedAt: await $.clock.now(),
        requests: mergeRequests(before?.repoKey === repo.key ? before : null, fresh),
        error: null,
        authHelp: null,
        nextRetryAt: null,
      })
    } catch (error) {
      const current = await readView($)

      if (gen !== generation || current.repo?.key !== repo.key) {
        return
      }

      const before = await read($, snapshotAtom)
      await setSnapshot(
        $,
        staleSnapshot(before, repo.key, {
          error: cleanError(error),
          authHelp: error instanceof AuthError ? error.help : null,
          nextRetryAt: error instanceof RateLimitError ? error.retryAt : null,
        }),
      )
    } finally {
      if (gen === generation) {
        await setView($, v => ({ ...v, isRefreshing: false }))
      }

      inflight = null
    }
  })()

  return inflight
}

// ---------------------------------------------------------------------------
// Monitoring and the pane
// ---------------------------------------------------------------------------

/** Fetches now, then every minute. Any earlier timer of this module is cancelled first. */
function startMonitoring($: $): void {
  generation += 1
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => {
    void refresh($, false)
  })
  void refresh($, true)
}

function stopMonitoring(): void {
  generation += 1
  timer?.cancel()
  timer = undefined
}

/** Opens the pane with the keyboard. Only ever called because someone asked for it. */
async function openPane($: $): Promise<void> {
  const repo = (await readView($)).repo

  await $.ui.open({ id: PANE_ID, title: repo === null ? 'Merge Watch' : `Merge Watch · ${repo.path}`, focus: true })
}

async function setEnabled($: $, enabled: boolean): Promise<void> {
  await saveCheckoutPrefs($, { enabled })
  const view = await readView($)

  if (view.repo !== null) {
    await setView($, v => ({ ...v, phase: enabled ? 'ready' : 'off' }))
  }

  if (enabled) {
    startMonitoring($)
  } else {
    stopMonitoring()
    await setView($, v => ({ ...v, isRefreshing: false }))
  }
}

async function toggleExpanded($: $, key: string): Promise<void> {
  const view = await readView($)
  const current = await read($, expandedAtom)
  const next = { ...current, [key]: current[key] !== true }
  await setExpanded($, next)

  if (view.repo !== null) {
    await $.store.set(`expanded:${view.repo.key}`, next)
  }
}

async function copyLink($: $, url: string, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'): Promise<void> {
  const copied = await $.ui.copy({ text: url, surface })
  $.ui.toast(copied.isCopied ? 'Link copied' : `Copy this link: ${url}`)
}

/**
 * Starts Merge Watch on request: finds the repository, starts the once-a-minute refresh and
 * opens the pane with the keyboard. Nothing runs before someone asks for it.
 */
async function activate($: $): Promise<void> {
  await resolveRepo($)
  const view = await readView($)

  if (view.repo !== null) {
    await saveCheckoutPrefs($, { enabled: true })
    await setView($, v => ({ ...v, phase: 'ready' }))
    startMonitoring($)
  }

  await openPane($)
}

/** A plain `claude -p` run has no app attached, so there is nowhere to show the pane. */
async function hasSurface($: $): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

const NO_SURFACE = 'Merge Watch needs an app that can show its panel, such as the terminal or the desktop app.'
const NOT_RUNNING = "Merge Watch isn't running in this session. Run /merge-watch to start it."

/** Expands every listed row, or collapses them all when they are all open already. */
async function toggleExpandAll($: $, keys: readonly string[]): Promise<void> {
  const view = await readView($)
  const current = await read($, expandedAtom)
  const allOpen = keys.length > 0 && keys.every(k => current[k] === true)
  const next = { ...current }

  for (const k of keys) {
    next[k] = !allOpen
  }

  await setExpanded($, next)

  if (view.repo !== null) {
    await $.store.set(`expanded:${view.repo.key}`, next)
  }
}

async function toggleShowAll($: $): Promise<void> {
  const view = await readView($)
  const next = !(await read($, showAllAtom))
  await update($, showAllAtom, () => next)

  if (view.repo !== null) {
    await $.store.set(`showAll:${view.repo.key}`, next)
  }
}

async function toggleMoreFailed($: $, key: string): Promise<void> {
  await update($, moreFailedAtom, m => ({ ...m, [key]: m[key] !== true }))
}

async function setNotice($: $, key: string, text: string | null): Promise<void> {
  await setView($, v => {
    const notices = { ...v.notices }

    if (text === null) {
      delete notices[key]
    } else {
      notices[key] = text
    }

    return { ...v, notices }
  })
}

/**
 * Runs a confirmed write action on one request, then refreshes so the pane shows the result.
 * Retry re-runs only failures that are not allowed to fail; merge is pinned to the commit shown.
 */
async function runAction($: $, key: string, action: 'retry' | 'merge'): Promise<void> {
  const view = await readView($)
  const snapshot = await read($, snapshotAtom)
  const repo = view.repo
  const request = snapshot?.requests.find(r => r.key === key)
  await setView($, v => ({ ...v, confirm: null }))

  if (repo === null || request === undefined) {
    return
  }

  await setNotice($, key, action === 'retry' ? 'Retrying failed jobs…' : 'Merging…')
  const now = await $.clock.now()

  try {
    if (action === 'retry') {
      const count =
        repo.provider === 'gitlab'
          ? await retryFailedGitLab(repo, glabFor($), request, now)
          : await retryFailedGitHub(repo, sendFor($), await githubToken($), request, now)
      await setNotice($, key, count === 0 ? 'No failed jobs to retry.' : `Retried ${count} failed job${count === 1 ? '' : 's'}.`)
    } else {
      if (repo.provider === 'gitlab') {
        await mergeGitLab(repo, glabFor($), request, now)
      } else {
        await mergeGitHub(repo, sendFor($), await githubToken($), request, now)
      }

      await setNotice($, key, 'Merge requested.')
    }
  } catch (error) {
    await setNotice($, key, `! ${action === 'retry' ? 'Retry' : 'Merge'} failed: ${cleanError(error)}`)
  }

  void refresh($, true)
}

/**
 * Splits `total` cells among segments in proportion to their counts, never below each
 * segment's `min` (its label plus padding), and always summing to exactly `total` when it can.
 */
export function segmentWidths(segments: readonly { count: number; min: number }[], total: number): number[] {
  const sum = segments.reduce((n, s) => n + s.count, 0)
  const widths = segments.map(s => Math.max(s.min, Math.round((s.count / Math.max(1, sum)) * total)))
  let over = widths.reduce((n, w) => n + w, 0) - total

  // Take any excess from the widest segments first, never below their minimum.
  while (over > 0) {
    let widest = -1

    widths.forEach((w, i) => {
      if (w > segments[i]!.min && (widest === -1 || w > widths[widest]!)) {
        widest = i
      }
    })

    if (widest === -1) {
      break
    }

    widths[widest] = widths[widest]! - 1
    over -= 1
  }

  // Hand any shortfall to the widest segment so the bar ends flush.
  if (over < 0 && widths.length > 0) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] = widths[widest]! - over
  }

  return widths
}

const USAGE =
  'Use /merge-watch to open the panel, or add refresh, hide, off, on or repo (for example /merge-watch refresh).'

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function registerMergeWatch(on: On, options: PluginOptions): void {
  hosts = {
    githubHosts: splitHosts(options.github_hosts),
    gitlabHosts: splitHosts(options.gitlab_hosts),
  }
  githubTokenOption = typeof options.github_token === 'string' && options.github_token.trim() !== '' ? options.github_token : undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'merge-watch',
      description: 'Show open merge requests and their CI in a panel',
      argumentHint: '[refresh|hide|off|on|repo]',
      immediate: true,
    })

    // Nothing else happens until someone runs /merge-watch: no repository lookup, no
    // refresh, no pane.
    return next(e)
  })

  // /clear, /resume and /branch reset $.state but not the module: put the pane back.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await update($, viewAtom, () => ({ ...lastView, isRefreshing: false }))
    await update($, snapshotAtom, () => lastSnapshot)
    await update($, expandedAtom, () => lastExpanded)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      stopMonitoring()
    }

    return next(e)
  })

  on('command.run', { command: 'merge-watch' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    const verb = action.toLowerCase()
    const before = await readView($)
    const isStopped = before.phase === 'idle' || before.phase === 'off'

    // Starting (or restarting) is only ever this command's doing.
    if (isStopped && (verb === '' || verb === 'on' || verb === 'refresh')) {
      if (!(await hasSurface($))) {
        return { text: NO_SURFACE }
      }

      await activate($)

      return verb === '' ? {} : { text: 'Merge Watch is on.' }
    }

    if (before.phase === 'idle' && (verb === 'hide' || verb === 'off')) {
      return { text: NOT_RUNNING }
    }

    if (before.phase === 'idle' && verb === 'repo') {
      await resolveRepo($)
    }

    const view = await readView($)

    switch (verb) {
      case '':
        await openPane($)

        return {}
      case 'refresh': {
        if (view.phase !== 'ready') {
          return { text: view.phase === 'off' ? 'Merge Watch is off. Run /merge-watch on to resume.' : 'Merge Watch has no repository to refresh yet.' }
        }

        const snapshot = await read($, snapshotAtom)
        const now = await $.clock.now()

        if (snapshot?.nextRetryAt != null && snapshot.nextRetryAt > now) {
          return { text: `The provider asked Merge Watch to slow down. Next try at ${formatTime(snapshot.nextRetryAt)}.` }
        }

        void refresh($, true)

        return { text: 'Refreshing Merge Watch.' }
      }
      case 'hide':
        await $.ui.close({ id: PANE_ID })

        return { text: 'Merge Watch is hidden and still refreshing. Run /merge-watch to show it.' }
      case 'off':
        await setEnabled($, false)
        await $.ui.close({ id: PANE_ID })

        return { text: 'Merge Watch is off for this repository. Run /merge-watch on to resume.' }
      case 'on':
        await activate($)

        return { text: 'Merge Watch is on.' }
      case 'repo': {
        const wanted = rest.join(' ')

        if (wanted !== '') {
          const match = view.candidates.find(r => r.remoteName === wanted || r.key === wanted || r.path === wanted)

          if (match === undefined) {
            return { text: `No remote named "${wanted}". Choices: ${view.candidates.map(r => r.remoteName).join(', ') || 'none'}.` }
          }

          await selectRepo($, match)

          return { text: `Merge Watch now watches ${match.host}/${match.path}.` }
        }

        await setView($, v => ({ ...v, isChoosing: true }))
        await openPane($)
        const current = view.repo === null ? 'none selected' : `${view.repo.host}/${view.repo.path} (${view.repo.remoteName})`

        return { text: `Watching: ${current}. Pick another in the panel, or run /merge-watch repo <remote>.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const svgTable = e.surface === 'desktop' ? $.ui.resolve(e) : null
    const Svg = svgTable !== null && 'Svg' in svgTable ? svgTable.Svg : null
    const view = await readView($)
    const snapshot = await read($, snapshotAtom)
    const expanded = await read($, expandedAtom)
    const showAll = await read($, showAllAtom)
    const moreFailed = await read($, moreFailedAtom)
    const now = await $.clock.now()
    const columns = Number(e.props.bodyColumns)
    // Some surfaces may not report a width; lay out for a typical sidebar then.
    const W = Number.isFinite(columns) && columns > 0 ? Math.max(32, columns) : 60
    const repo = view.repo
    const data = snapshot !== null && repo !== null && snapshot.repoKey === repo.key ? snapshot : null

    const IID_COLS = 7
    const BAR_CELLS = 10
    const TITLE_COLS = Math.max(10, W - IID_COLS - BAR_CELLS - 4)
    // The desktop app frames the pane with its own title bar (title, maximise, close); the
    // terminal shows no title while one pane is open, so it gets the header row.
    const hasOwnChrome = e.surface !== 'terminal'

    // The rows the ⤢ button opens or closes; filled in once the list is known.
    let visibleKeys: string[] = []

    const clip = (text: string, cols: number) => (text.length <= cols ? text : `${text.slice(0, Math.max(1, cols - 1))}…`)

    const header = hasOwnChrome ? null : (
      <Box key="header" flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text wrap="truncate-end">
          <Text color={C.muted}>Merge Watch · </Text>
          <Text bold>{repo === null ? '' : repo.path}</Text>
        </Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key="refresh" plain label="↻" onPress={() => refresh($, true)} />
          <Button key="expand" plain label="⤢" onPress={() => toggleExpandAll($, visibleKeys)} />
          <Button key="close" plain label="✕" onPress={() => $.ui.close({ id: PANE_ID })} />
        </Box>
      </Box>
    )

    const message = (key: string, text: string, color?: string) => (
      <Text key={key} color={color} wrap="wrap">
        {text}
      </Text>
    )

    const frame = (...children: (RenderElement | null)[]) => (
      <Box flexDirection="column" width={W} rowGap={0}>
        {children}
      </Box>
    )

    if (view.phase === 'not-git') {
      return frame(header, message('msg', 'Open a Git project to use Merge Watch.'))
    }

    if (view.phase === 'no-remote') {
      return frame(
        header,
        message('msg', 'This repository has no GitLab or GitHub remote Merge Watch recognises. For a self-hosted host without "gitlab" in its name, add it to the gitlab_hosts or github_hosts option.'),
      )
    }

    if (view.phase === 'idle') {
      return frame(header, message('msg', 'Finding the repository…', C.muted))
    }

    const chooser =
      view.isChoosing || view.phase === 'choose-repo' ? (
        <Box key="chooser" flexDirection="column">
          <Text color={C.muted}>{view.phase === 'choose-repo' ? 'Several remotes could be the project. Pick one:' : 'Watch another remote:'}</Text>
          {view.candidates.map(r => (
            <Button
              key={`pick-${r.remoteName}`}
              plain
              label={`${repo?.key === r.key ? '● ' : '○ '}${r.remoteName}: ${r.host}/${r.path}`}
              onPress={() => selectRepo($, r)}
            />
          ))}
        </Box>
      ) : null

    if (view.phase === 'choose-repo') {
      return frame(header, chooser)
    }

    if (view.phase === 'off') {
      return frame(
        header,
        message('msg', 'Monitoring is off for this repository.', C.muted),
        <Button key="turn-on" label="Turn on" onPress={() => setEnabled($, true)} />,
      )
    }

    // ---- data ------------------------------------------------------------
    const all = data?.requests ?? []
    const shown = showAll ? all : all.filter(r => !isStale(r, now))
    const groups = new Map<Group, MergeWatchRequest[]>(GROUP_ORDER.map(g => [g, []]))

    for (const r of shown) {
      groups.get(groupOf(r))!.push(r)
    }

    visibleKeys = shown.map(r => r.key)

    // ---- status lines (loading, errors, sign-in) -------------------------
    const status: RenderElement[] = []

    if (data === null || data.fetchedAt === null) {
      status.push(message('loading', view.isRefreshing ? 'Loading merge requests…' : 'Not loaded yet.', C.muted))
    }

    if (data?.error != null) {
      status.push(
        message(
          'error',
          data.fetchedAt === null
            ? `! Couldn't load: ${data.error}`
            : `! Couldn't refresh: ${data.error}. Showing stale data from ${formatTime(data.fetchedAt)}.`,
          C.amber,
        ),
      )
    }

    if (data?.authHelp != null) {
      status.push(message('auth', data.authHelp))
    }

    if (data?.nextRetryAt != null) {
      status.push(message('retry', `Polling slowed by the provider. Next try at ${formatTime(data.nextRetryAt)}.`, C.amber))
    }

    // ---- summary bar -----------------------------------------------------
    const segments = GROUP_ORDER.map(g => ({ group: g, count: groups.get(g)!.length })).filter(s => s.count > 0)
    const segmentText = (g: Group, n: number) => (g === 'ready' ? `${n} ready` : g === 'failing' ? `${n} failing` : `${n} draft${n === 1 ? '' : 's'}`)
    let summary: RenderElement | null = null

    if (segments.length > 0) {
      const gaps = segments.length - 1
      const widths = segmentWidths(
        segments.map(s => ({ count: s.count, min: segmentText(s.group, s.count).length + 2 })),
        W - gaps,
      )
      summary = (
        <Box key="summary" flexDirection="row" columnGap={1} marginTop={hasOwnChrome ? 0 : 1}>
          {segments.map((s, i) => (
            <Box key={`seg-${s.group}`} width={widths[i]} flexShrink={0} backgroundColor={TINT[s.group].bg}>
              <Text bold color={TINT[s.group].fg} backgroundColor={TINT[s.group].bg} wrap="truncate">
                {` ${segmentText(s.group, s.count)}`}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }

    // ---- one request -----------------------------------------------------
    const miniBar = (key: string, mix: JobMix) => {
      if (Svg !== null) {
        const total = mix.passed + mix.failed + mix.allowed + mix.manual + mix.other
        let x = 0
        const rects = (['passed', 'failed', 'allowed', 'manual', 'other'] as const)
          .filter(k => mix[k] > 0)
          .map(k => {
            const w = total === 0 ? 44 : (mix[k] / total) * 44
            const r = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="6" fill="${BAR[k]}"/>`
            x += w

            return r
          })

        return (
          <Svg
            key={key}
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="6" viewBox="0 0 44 6"><clipPath id="r"><rect width="44" height="6" rx="3"/></clipPath><g clip-path="url(#r)">${total === 0 ? `<rect width="44" height="6" fill="${BAR.other}"/>` : rects.join('')}</g></svg>`}
            alt={`${mix.passed} passed, ${mix.failed} failed, ${mix.allowed} allowed to fail, ${mix.manual} manual`}
            width={44}
            height={6}
          />
        )
      }

      const cells = splitCells(mix, BAR_CELLS)

      return (
        <Text key={key}>
          {(['passed', 'failed', 'allowed', 'manual', 'other'] as const)
            .filter(k => cells[k] > 0)
            .map(k => (
              <Text key={k} color={BAR[k]}>
                {'━'.repeat(cells[k])}
              </Text>
            ))}
        </Text>
      )
    }

    const reasonColor = (r: MergeWatchRequest, g: Group) => (g === 'draft' ? C.muted : g === 'ready' ? C.green : reasonLine(r).startsWith('✕') ? C.red : C.muted)

    const renderRow = (r: MergeWatchRequest, g: Group): RenderElement[] => {
      const isOpen = expanded[r.key] === true
      const out: RenderElement[] = [
        <Box key={`row-${r.key}`} flexDirection="row" columnGap={1}>
          <Box width={IID_COLS} flexShrink={0}>
            <Text color={C.muted}>{r.ref}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Button key={`toggle-${r.key}`} plain label={clip(stripPrefix(r.title), TITLE_COLS)} onPress={() => toggleExpanded($, r.key)} />
            <Text color={reasonColor(r, g)} wrap="truncate-end">
              {clip(reasonLine(r), TITLE_COLS)}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {miniBar(`bar-${r.key}`, jobMix(r))}
            <Button key={`chev-${r.key}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => toggleExpanded($, r.key)} />
          </Box>
        </Box>,
      ]

      if (isOpen) {
        out.push(renderDetail(r, g))
      }

      return out
    }

    const renderDetail = (r: MergeWatchRequest, g: Group): RenderElement => {
      const k = `d-${r.key}`
      const head = r.ci.pipelines[0]
      const failed = realFailures(r)
      const allowed = allowedFailures(r)
      const running = currentJobs(r).filter(j => j.state === 'running')
      const showEvery = moreFailed[r.key] === true
      const listedFailures = showEvery ? failed : failed.slice(0, FAILURES_SHOWN)
      const notice = view.notices[r.key]
      const confirm = view.confirm !== null && view.confirm.key === r.key ? view.confirm.action : null
      const label = (text: string) => (
        <Box width={10} flexShrink={0}>
          <Text color={C.muted}>{text}</Text>
        </Box>
      )
      const jobRow = (id: string, name: string, url: string | null, word: string, color: string, isMuted: boolean) => (
        <Box key={`${k}-j${id}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text color={isMuted ? C.muted : undefined} wrap="truncate-end">
            {url === null ? name : <Link href={url} label={name} />}
          </Text>
          <Text color={color}>{word}</Text>
        </Box>
      )
      const linkButton = (key: string, text: string, url: string) => (
        <Box key={key} borderStyle="round" paddingX={1}>
          <Link href={url} label={text} />
        </Box>
      )
      const actions: RenderElement[] = []

      if (confirm !== null) {
        actions.push(
          <Button
            key={`confirm-${r.key}`}
            variant="primary"
            label={confirm === 'merge' ? `Confirm merge of ${r.ref}` : `Confirm retry of ${failed.length} job${failed.length === 1 ? '' : 's'}`}
            onPress={() => runAction($, r.key, confirm)}
          />,
          <Button key={`cancel-${r.key}`} label="Cancel" onPress={() => setView($, v => ({ ...v, confirm: null }))} />,
        )
      } else if (g === 'ready' && r.canMerge && !r.needsReview) {
        actions.push(<Button key={`merge-${r.key}`} variant="primary" label="Merge" onPress={() => setView($, v => ({ ...v, confirm: { key: r.key, action: 'merge' } }))} />)
      } else if (g === 'ready' && r.url !== null) {
        actions.push(linkButton(`review-${r.key}`, 'Review', r.url))
      } else if (failed.length > 0) {
        actions.push(<Button key={`retry-${r.key}`} variant="primary" label="Retry failed" onPress={() => setView($, v => ({ ...v, confirm: { key: r.key, action: 'retry' } }))} />)
      }

      if (confirm === null && r.url !== null) {
        if (!(g === 'ready' && !r.canMerge)) {
          actions.push(linkButton(`open-${r.key}`, 'Open MR', r.url))
        }

        const url = r.url
        actions.push(<Button key={`copy-${r.key}`} label="Copy link" onPress={press => copyLink($, url, press.surface)} />)
      }

      return (
        <Box key={k} flexDirection="column" paddingLeft={IID_COLS + 1} marginBottom={1}>
          <Text wrap="wrap">{r.title}</Text>
          <Box flexDirection="row">
            {label('Status')}
            <Text wrap="truncate-end">{[r.isDraft ? 'Draft' : 'Open', r.review, ...r.blockers.filter(b => b !== r.review && b !== 'Draft')].join(' · ')}</Text>
          </Box>
          <Box flexDirection="row">
            {label('Branch')}
            <Text wrap="truncate-end">{`${r.sourceBranch} → ${r.targetBranch} · ${r.author}${r.sourceProject === null ? '' : ` · from ${r.sourceProject}`}`}</Text>
          </Box>
          <Box flexDirection="row">
            {label('Pipeline')}
            <Text wrap="truncate-end">
              {head === undefined ? (
                r.ci.label
              ) : head.url === null ? (
                pipelineSummary(head, jobCounts(currentJobs(r)))
              ) : (
                <Link href={head.url} label={pipelineSummary(head, jobCounts(currentJobs(r)))} />
              )}
            </Text>
          </Box>
          {r.ci.pipelines.flatMap(p => p.notes).map((note, i) => (
            <Text key={`${k}-n${i}`} color={note.startsWith('Previous revision') ? C.amber : C.muted} wrap="truncate-end">
              {note}
            </Text>
          ))}
          {r.error !== null && (
            <Text color={C.amber} wrap="wrap">
              {r.staleSince === null ? `! Details unavailable: ${r.error}` : `! Couldn't refresh ${r.ref}: ${r.error}. Showing data from ${formatTime(r.staleSince)}.`}
            </Text>
          )}
          {listedFailures.length + allowed.length + running.length > 0 && (
            <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
              {listedFailures.map(j => jobRow(j.id, j.name, j.url, 'failed', C.red, false))}
              {running.map(j => jobRow(j.id, j.name, j.url, 'running', C.blue, false))}
              {allowed.map(j => jobRow(j.id, j.name, j.url, 'allowed', C.amber, true))}
            </Box>
          )}
          {failed.length > FAILURES_SHOWN && (
            <Button
              key={`more-${r.key}`}
              plain
              dimColor
              label={showEvery ? 'Show fewer' : `+${failed.length - FAILURES_SHOWN} more failed`}
              onPress={() => toggleMoreFailed($, r.key)}
            />
          )}
          {notice !== undefined && (
            <Text color={notice.startsWith('!') ? C.amber : C.muted} wrap="wrap">
              {notice}
            </Text>
          )}
          {actions.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
              {actions}
            </Box>
          )}
        </Box>
      )
    }

    // ---- groups ----------------------------------------------------------
    const body: RenderElement[] = []

    for (const g of GROUP_ORDER) {
      const rows = groups.get(g)!

      if (rows.length === 0) {
        continue
      }

      const title = GROUP_LABEL[g]
      const count = String(rows.length)
      // Rule characters are wider than a cell in the desktop app's font, so draw fewer there.
      const ruleCells = Math.max(0, W - title.length - count.length - 3)
      body.push(
        <Box key={`group-${g}`} flexDirection="row" marginTop={1}>
          <Box flexShrink={0}>
            <Text bold color={g === 'ready' ? C.green : g === 'failing' ? C.red : C.muted} wrap="truncate">
              {title}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={C.faint}>{` ${count} `}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text color={C.hairline} wrap="truncate">
              {'─'.repeat(hasOwnChrome ? Math.floor(ruleCells * 0.55) : ruleCells)}
            </Text>
          </Box>
        </Box>,
      )

      for (const r of rows) {
        body.push(...renderRow(r, g))
      }
    }

    if (data !== null && data.fetchedAt !== null && all.length === 0 && data.error === null) {
      body.push(message('empty', `No open ${repo?.provider === 'github' ? 'pull' : 'merge'} requests.`, C.muted))
    } else if (data !== null && shown.length === 0 && all.length > 0) {
      body.push(message('empty', `No ${repo?.provider === 'github' ? 'PRs' : 'MRs'} updated in the last 14 days.`, C.muted))
    }

    // ---- footer ----------------------------------------------------------
    const hidden = all.length - shown.length
    const footer = (
      <Box key="footer" flexDirection="row" columnGap={1} marginTop={1}>
        <Text color={C.muted} wrap="truncate-end">
          {`${shown.length} of ${all.length} open · ${data?.fetchedAt == null ? 'not loaded' : `updated ${formatTime(data.fetchedAt)}`}${view.isRefreshing ? ' · refreshing…' : ''}`}
        </Text>
        {(hidden > 0 || showAll) && <Button key="show-all" plain label={showAll ? 'show recent' : 'show all'} onPress={() => toggleShowAll($)} />}
        {hasOwnChrome && <Button key="refresh" plain label="↻ refresh" onPress={() => refresh($, true)} />}
        {hasOwnChrome && <Button key="expand" plain label={visibleKeys.every(k => expanded[k] === true) && visibleKeys.length > 0 ? 'collapse all' : 'expand all'} onPress={() => toggleExpandAll($, visibleKeys)} />}
      </Box>
    )

    return frame(header, summary, ...status, chooser, ...body, footer)
  }).catch(($, e, next) => {
    // A drawing that fails says so in the pane instead of leaving it blank.
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text bold>Merge Watch</Text>
        <Text color="warning" wrap="wrap">
          {`! The panel could not be drawn: ${cleanError(next.error?.message ?? 'unknown error')}. Run /merge-watch refresh to try again.`}
        </Text>
      </Box>
    )
  })
}
