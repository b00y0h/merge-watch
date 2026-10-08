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
import { fetchGitHub } from './github'
import type { HttpResponse } from './github'
import { fetchGitLab } from './gitlab'
import { chooseRepo, reposFromRemotes, splitHosts } from './repo'
import type { HostConfig } from './repo'
import { cleanError } from './safe'
import { AuthError, RateLimitError, STATE_COLOR, STATE_ICON, sortRequests } from './status'

type $ = EngineInterface

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
}

const viewAtom = atom({ plugin: 'merge-watch', key: 'view' } as const, INITIAL_VIEW)
const snapshotAtom = atom({ plugin: 'merge-watch', key: 'snapshot' } as const, null)
const expandedAtom = atom({ plugin: 'merge-watch', key: 'expanded' } as const, {})

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

async function setView($: $, fn: (v: MergeWatchView) => MergeWatchView): Promise<void> {
  await update($, viewAtom, v => {
    lastView = fn(v)

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

  const snapshot = await read($, snapshotAtom)

  if (snapshot !== null && snapshot.repoKey !== repo.key) {
    await setSnapshot($, null)
  }

  await setView($, v => ({ ...v, phase: enabled ? 'ready' : 'off', repo, candidates, isChoosing: false }))
}

async function selectRepo($: $, repo: MergeWatchRepo): Promise<void> {
  const view = await read($, viewAtom)
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

async function fetchRequests($: $, repo: MergeWatchRepo, now: number): Promise<MergeWatchRequest[]> {
  if (repo.provider === 'gitlab') {
    const cwd = checkout?.top

    return fetchGitLab(
      repo,
      async args => {
        const result = await $.process.run(['glab', ...args], { cwd, timeoutMs: GLAB_TIMEOUT_MS })

        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || `glab exited with ${result.exitCode}`)
        }

        return result.stdout
      },
      now,
    )
  }

  const token = githubTokenOption ?? (await $.env.get('GITHUB_TOKEN')) ?? (await $.env.get('GH_TOKEN'))

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

  const view = await read($, viewAtom)
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
      const current = await read($, viewAtom)

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
      const current = await read($, viewAtom)

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
  await $.ui.open({ id: PANE_ID, title: 'Merge Watch', focus: true })
}

async function setEnabled($: $, enabled: boolean): Promise<void> {
  await saveCheckoutPrefs($, { enabled })
  const view = await read($, viewAtom)

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
  const view = await read($, viewAtom)
  const current = await read($, expandedAtom)
  const next = { ...current, [key]: current[key] === false }
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
  const view = await read($, viewAtom)

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
    const before = await read($, viewAtom)
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

    const view = await read($, viewAtom)

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
    const view = await read($, viewAtom)
    const snapshot = await read($, snapshotAtom)
    const expanded = await read($, expandedAtom)
    const width = Math.max(24, e.props.bodyColumns)
    const repo = view.repo
    const data = snapshot !== null && repo !== null && snapshot.repoKey === repo.key ? snapshot : null

    const header: RenderElement[] = [
      <Text key="title" bold wrap="truncate-end">
        {repo === null ? 'Merge Watch' : `Merge Watch · ${repo.path}`}
      </Text>,
    ]

    const controls = (
      <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="refresh" label="Refresh" onPress={() => refresh($, true)} />
        <Button key="hide" label="Hide" onPress={() => $.ui.close({ id: PANE_ID })} />
        {view.candidates.length > 1 && (
          <Button key="choose" label="Repository" onPress={() => setView($, v => ({ ...v, isChoosing: !v.isChoosing }))} />
        )}
      </Box>
    )

    const message = (key: string, text: string, color?: string) => (
      <Text key={key} color={color} wrap="wrap">
        {text}
      </Text>
    )

    if (view.phase === 'not-git') {
      return <Box flexDirection="column" width={width}>{[...header, message('msg', 'Open a Git project to use Merge Watch.')]}</Box>
    }

    if (view.phase === 'no-remote') {
      return (
        <Box flexDirection="column" width={width}>
          {[...header, message('msg', 'This repository has no GitLab or GitHub remote Merge Watch recognises. For a self-hosted host without "gitlab" in its name, add it to the gitlab_hosts or github_hosts option.')]}
        </Box>
      )
    }

    if (view.phase === 'idle') {
      return <Box flexDirection="column" width={width}>{[...header, message('msg', 'Finding the repository…')]}</Box>
    }

    const chooser =
      view.isChoosing || view.phase === 'choose-repo' ? (
        <Box key="chooser" flexDirection="column">
          <Text dimColor>{view.phase === 'choose-repo' ? 'Several remotes could be the project. Pick one:' : 'Watch another remote:'}</Text>
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
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {chooser}
        </Box>
      )
    }

    if (view.phase === 'off') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {message('msg', 'Monitoring is off for this repository.')}
          <Button key="turn-on" label="Turn on" onPress={() => setEnabled($, true)} />
        </Box>
      )
    }

    const status: RenderElement[] = []
    const count = data?.requests.length ?? 0
    const updated = data?.fetchedAt == null ? 'Not loaded yet' : `Updated ${formatTime(data.fetchedAt)}`
    status.push(
      <Text key="summary" wrap="truncate-end">
        {data?.fetchedAt == null ? updated : `${noun(repo, count)} · ${updated}`}
        {view.isRefreshing ? ' · Refreshing…' : ''}
      </Text>,
    )

    if (data?.error != null) {
      status.push(
        message(
          'error',
          data.fetchedAt === null
            ? `! Couldn't load: ${data.error}`
            : `! Couldn't refresh: ${data.error}. Showing stale data from ${formatTime(data.fetchedAt)}.`,
          'warning',
        ),
      )
    }

    if (data?.authHelp != null) {
      status.push(message('auth', data.authHelp))
    }

    if (data?.nextRetryAt != null) {
      status.push(message('retry', `Polling slowed by the provider. Next try at ${formatTime(data.nextRetryAt)}.`, 'warning'))
    }

    const rows: RenderElement[] = []

    for (const request of data?.requests ?? []) {
      rows.push(...renderRequest(request, expanded[request.key] !== false, data?.fetchedAt ?? null))
    }

    if (data !== null && data.fetchedAt !== null && count === 0 && data.error === null) {
      rows.push(message('empty', `No open ${repo?.provider === 'github' ? 'pull' : 'merge'} requests.`))
    }

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {status}
        {controls}
        {chooser}
        {rows}
      </Box>
    )

    function renderRequest(r: MergeWatchRequest, isOpen: boolean, fetchedAt: number | null): RenderElement[] {
      const k = `r-${r.key}`
      const isStale = r.staleSince !== null
      const ciText = `${STATE_ICON[r.ci.state]} ${r.ci.label}${isStale ? ' (stale)' : ''}`
      const out: RenderElement[] = [
        <Box key={`${k}-head`} flexDirection="row" justifyContent="space-between" columnGap={1} marginTop={1}>
          <Box flexDirection="row" flexShrink={1} columnGap={1}>
            <Button key={`toggle-${r.key}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggleExpanded($, r.key)} />
            {r.url === null ? (
              <Text bold wrap="truncate-end">{`${r.ref} ${r.title} (no link)`}</Text>
            ) : (
              <Link key={`link-${r.key}`} href={r.url} label={`${r.ref} ${r.title}`} />
            )}
          </Box>
          <Text color={isStale ? 'warning' : STATE_COLOR[r.ci.state]} wrap="truncate-end">
            {ciText}
          </Text>
        </Box>,
        <Text key={`${k}-review`} dimColor wrap="truncate-end">
          {`  ${r.isDraft ? 'Draft' : 'Open'} · ${r.review}`}
        </Text>,
        <Text key={`${k}-ready`} wrap="truncate-end" color={r.readiness === 'Ready to merge' ? 'success' : undefined}>
          {`  ${r.readiness === 'Ready to merge' ? '✓' : '·'} ${r.readiness}${r.blockers.length > 0 ? ` · ${r.blockers.join(' · ')}` : ''}`}
        </Text>,
        <Text key={`${k}-branch`} dimColor wrap="truncate-end">
          {`  ${r.sourceBranch} → ${r.targetBranch} · by ${r.author}${r.sourceProject === null ? '' : ` · from ${r.sourceProject}`}`}
        </Text>,
      ]

      if (r.error !== null) {
        out.push(
          <Text key={`${k}-error`} color="warning" wrap="wrap">
            {isStale
              ? `  ! Couldn't refresh ${r.ref}: ${r.error}. Showing data from ${formatTime(r.staleSince)}.`
              : `  ! Details unavailable: ${r.error}`}
          </Text>,
        )
      } else if (isStale) {
        out.push(
          <Text key={`${k}-stale`} color="warning" wrap="truncate-end">
            {`  ! Stale: showing data from ${formatTime(r.staleSince ?? fetchedAt)}`}
          </Text>,
        )
      }

      if (r.url !== null) {
        const url = r.url
        out.push(
          <Box key={`${k}-copy`} paddingLeft={2}>
            <Button key={`copy-${r.key}`} plain dimColor label="Copy link" onPress={press => copyLink($, url, press.surface)} />
          </Box>,
        )
      }

      if (!isOpen) {
        return out
      }

      if (r.ci.pipelines.length === 0) {
        out.push(
          <Text key={`${k}-noci`} dimColor wrap="truncate-end">
            {`  ${STATE_ICON[r.ci.state]} ${r.ci.label}`}
          </Text>,
        )
      }

      r.ci.pipelines.forEach((p, i) => out.push(...renderPipeline(p, `${k}-p${i}`, 2)))

      return out
    }

    function renderPipeline(p: MergeWatchPipeline, k: string, indent: number): RenderElement[] {
      const pad = ' '.repeat(indent)
      const state = p.isPreviousRevision ? 'Previous revision' : p.label
      const out: RenderElement[] = [
        <Box key={`${k}-head`} flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Box flexDirection="row" flexShrink={1}>
            <Text>{pad}</Text>
            {p.url === null ? <Text wrap="truncate-end">{p.title}</Text> : <Link key={`${k}-link`} href={p.url} label={p.title} />}
          </Box>
          <Text color={p.isPreviousRevision ? 'warning' : STATE_COLOR[p.state]} wrap="truncate-end">
            {`${p.isPreviousRevision ? '↺' : STATE_ICON[p.state]} ${state}`}
          </Text>
        </Box>,
      ]

      p.notes.forEach((note, i) =>
        out.push(
          <Text key={`${k}-n${i}`} dimColor color={note.startsWith('Previous revision') ? 'warning' : undefined} wrap="wrap">
            {`${pad}  ${note}`}
          </Text>,
        ),
      )

      if (p.isIncomplete && !p.notes.some(n => /unavailable|not loaded|could not|not accessible/i.test(n))) {
        out.push(
          <Text key={`${k}-inc`} color="warning" wrap="truncate-end">
            {`${pad}  ! Some results are missing`}
          </Text>,
        )
      }

      p.jobs.forEach(j => {
        out.push(
          <Box key={`${k}-j${j.id}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" flexShrink={1}>
              <Text color={STATE_COLOR[j.state]}>{`${pad}  ${STATE_ICON[j.state]} `}</Text>
              {j.url === null ? (
                <Text wrap="truncate-end">{`${j.name} (no link)`}</Text>
              ) : (
                <Link key={`job-${j.id}`} href={j.url} label={j.name} />
              )}
            </Box>
            <Text color={STATE_COLOR[j.state]} wrap="truncate-end">
              {j.label}
            </Text>
          </Box>,
        )
      })

      p.children.forEach((child, i) => out.push(...renderPipeline(child, `${k}-c${i}`, indent + 2)))

      return out
    }
  })
}
