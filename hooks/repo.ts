// Repository detection: parse git remotes and choose which hosted repository to watch.

import type { MergeWatchProvider, MergeWatchRepo } from '../types'

export type ParsedRemote = { host: string; path: string }

export type HostConfig = {
  /** Extra GitHub Enterprise hosts, e.g. "github.example.com". */
  githubHosts: readonly string[]
  /** Extra self-hosted GitLab hosts that do not have "gitlab" in their name. */
  gitlabHosts: readonly string[]
}

/**
 * Parses HTTPS, SSH (`ssh://`) and scp-style (`git@host:group/sub/repo.git`) remote URLs.
 * Credentials in the URL are dropped; nested groups are kept whole.
 */
export function parseRemoteUrl(raw: string): ParsedRemote | null {
  const value = raw.trim()

  if (value === '') {
    return null
  }

  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL

    try {
      url = new URL(value)
    } catch {
      return null
    }

    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) {
      return null
    }

    host = url.hostname
    path = decodeURIComponent(url.pathname)
  } else if (scp !== null) {
    host = scp[1]!
    path = scp[2]!
  } else {
    return null
  }

  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')

  // GitLab's SSH form can carry a leading "scm/" or a port-like segment; keep only real path parts.
  const parts = path.split('/').filter(Boolean)

  if (parts.length < 2 || parts.some(p => p === '.' || p === '..')) {
    return null
  }

  return { host: host.toLowerCase(), path: parts.join('/') }
}

export function providerFor(host: string, config: HostConfig): MergeWatchProvider | null {
  const h = host.toLowerCase()

  if (h === 'github.com' || config.githubHosts.map(x => x.toLowerCase()).includes(h)) {
    return 'github'
  }

  if (h === 'gitlab.com' || /(^|\.)gitlab\./.test(h) || config.gitlabHosts.map(x => x.toLowerCase()).includes(h)) {
    return 'gitlab'
  }

  return null
}

export function repoKey(provider: MergeWatchProvider, host: string, path: string): string {
  return `${provider}:${host.toLowerCase()}/${path}`
}

/** `git remote -v` output → one supported repository per remote name (fetch URL preferred). */
export function reposFromRemotes(remoteOutput: string, config: HostConfig): MergeWatchRepo[] {
  const byName = new Map<string, MergeWatchRepo>()

  for (const line of remoteOutput.split('\n')) {
    const match = /^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?\s*$/.exec(line.trim())

    if (match === null) {
      continue
    }

    const [, name, url, kind] = match

    if (byName.has(name!) && kind === 'push') {
      continue
    }

    const parsed = parseRemoteUrl(url!)

    if (parsed === null) {
      continue
    }

    const provider = providerFor(parsed.host, config)

    if (provider === null) {
      continue
    }

    byName.set(name!, {
      provider,
      host: parsed.host,
      path: parsed.path,
      key: repoKey(provider, parsed.host, parsed.path),
      remoteName: name!,
      webUrl: `https://${parsed.host}/${parsed.path}`,
    })
  }

  return [...byName.values()]
}

export type RepoChoice =
  | { kind: 'chosen'; repo: MergeWatchRepo; candidates: MergeWatchRepo[] }
  | { kind: 'ambiguous'; candidates: MergeWatchRepo[] }
  | { kind: 'none' }

/** Saved selection, then `origin`, then a single supported remote; otherwise ask. */
export function chooseRepo(candidates: readonly MergeWatchRepo[], savedKey: string | null): RepoChoice {
  const list = [...candidates]

  if (list.length === 0) {
    return { kind: 'none' }
  }

  const saved = savedKey === null ? undefined : list.find(r => r.key === savedKey)

  if (saved !== undefined) {
    return { kind: 'chosen', repo: saved, candidates: list }
  }

  const origin = list.find(r => r.remoteName === 'origin')

  if (origin !== undefined) {
    return { kind: 'chosen', repo: origin, candidates: list }
  }

  const distinct = new Map(list.map(r => [r.key, r]))

  if (distinct.size === 1) {
    return { kind: 'chosen', repo: list[0]!, candidates: list }
  }

  return { kind: 'ambiguous', candidates: list }
}

export function splitHosts(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(/[,\s]+/)
        .map(h => h.trim().toLowerCase())
        .filter(h => /^[a-z0-9.-]+(:\d+)?$/.test(h))
    : []
}
