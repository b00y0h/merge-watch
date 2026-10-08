import { expect, test } from 'claude-code/testing'

import { chooseRepo, parseRemoteUrl, providerFor, reposFromRemotes, repoKey } from '../hooks/repo'
import { cleanError, cleanText, safeUrl } from '../hooks/safe'

const HOSTS = { githubHosts: ['github.acme.test'], gitlabHosts: ['code.acme.test'] }

test('1. remotes: HTTPS, SSH, scp-style, nested groups and credentials', () => {
  expect(parseRemoteUrl('https://gitlab.example.com/team/sub/project.git')).toEqual({ host: 'gitlab.example.com', path: 'team/sub/project' })
  expect(parseRemoteUrl('git@gitlab.example.com:team/sub/deeper/project.git')).toEqual({
    host: 'gitlab.example.com',
    path: 'team/sub/deeper/project',
  })
  expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/team/project.git')).toEqual({ host: 'gitlab.example.com', path: 'team/project' })
  expect(parseRemoteUrl('https://YOUR_USER:YOUR_PASSWORD_HERE@github.com/octo/app')).toEqual({ host: 'github.com', path: 'octo/app' })
  expect(parseRemoteUrl('git@github.com:octo/app')).toEqual({ host: 'github.com', path: 'octo/app' })
  expect(parseRemoteUrl('file:///tmp/repo')).toBeNull()
  expect(parseRemoteUrl('/local/path/repo')).toBeNull()
  expect(parseRemoteUrl('https://gitlab.example.com/onlyone')).toBeNull()
})

test('1. providers: github.com, Enterprise hosts, gitlab hosts, unknown hosts', () => {
  expect(providerFor('github.com', HOSTS)).toBe('github')
  expect(providerFor('github.acme.test', HOSTS)).toBe('github')
  expect(providerFor('gitlab.devops.example.com', HOSTS)).toBe('gitlab')
  expect(providerFor('code.acme.test', HOSTS)).toBe('gitlab')
  expect(providerFor('bitbucket.org', HOSTS)).toBeNull()
})

test('1. worktree-style remote output and ambiguous remotes', () => {
  const remotes = [
    'origin\tgit@gitlab.example.com:team/sub/project.git (fetch)',
    'origin\tgit@gitlab.example.com:team/sub/project.git (push)',
    'fork\thttps://github.com/me/project.git (fetch)',
    'fork\thttps://github.com/me/project.git (push)',
    'mirror\thttps://bitbucket.org/me/project.git (fetch)',
  ].join('\n')
  const repos = reposFromRemotes(remotes, HOSTS)

  expect(repos.map(r => r.remoteName)).toEqual(['origin', 'fork'])
  expect(repos[0]?.key).toBe('gitlab:gitlab.example.com/team/sub/project')

  // origin wins without a saved choice; a saved choice wins over origin.
  expect(chooseRepo(repos, null)).toMatchObject({ kind: 'chosen', repo: { remoteName: 'origin' } })
  expect(chooseRepo(repos, 'github:github.com/me/project')).toMatchObject({ kind: 'chosen', repo: { remoteName: 'fork' } })

  // No origin and two different repositories: ask instead of guessing.
  const noOrigin = repos.map(r => ({ ...r, remoteName: r.remoteName === 'origin' ? 'upstream' : r.remoteName }))
  expect(chooseRepo(noOrigin, null).kind).toBe('ambiguous')
  // A single supported remote is used.
  expect(chooseRepo([noOrigin[0]!], null)).toMatchObject({ kind: 'chosen' })
  expect(chooseRepo([], null).kind).toBe('none')
})

test('11. repository keys keep same-named projects on different hosts apart', () => {
  const a = repoKey('gitlab', 'gitlab.one.test', 'team/app')
  const b = repoKey('gitlab', 'gitlab.two.test', 'team/app')
  const c = repoKey('github', 'github.com', 'team/app')

  expect(a).not.toBe(b)
  expect(a).not.toBe(c)
  expect(repoKey('gitlab', 'GitLab.One.Test', 'team/app')).toBe(a)
})

test('12. untrusted text loses control sequences', () => {
  expect(cleanText('\u001b[31mRed\u001b[0m title')).toBe('Red title')
  expect(cleanText('Click \u001b]8;;https://evil.test\u0007here\u001b]8;;\u0007')).toBe('Click here')
  expect(cleanText('tab\tand\nnewline\u0007bell')).toBe('tab and newline bell')
  expect(cleanText('‮evil override')).toBe('evil override')
  expect(cleanText('x'.repeat(500)).length).toBeLessThanOrEqual(300)
  expect(cleanText(undefined)).toBe('')
})

test('12. links: only http(s), never with embedded credentials', () => {
  expect(safeUrl('https://gitlab.example.com/team/project/-/merge_requests/1')).toBe(
    'https://gitlab.example.com/team/project/-/merge_requests/1',
  )
  expect(safeUrl('https://YOUR_USER:YOUR_PASSWORD_HERE@gitlab.example.com/x')).toBeNull()
  expect(safeUrl('https://token@gitlab.example.com/x')).toBeNull()
  expect(safeUrl('javascript:alert(1)')).toBeNull()
  expect(safeUrl('file:///etc/passwd')).toBeNull()
  expect(safeUrl('https://example.com/\u001b[31m')).toBeNull()
  expect(safeUrl('not a url')).toBeNull()
  expect(safeUrl(42)).toBeNull()
  expect(safeUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull()
})

test('12. errors never echo token-shaped values', () => {
  expect(cleanError(new Error('bad token glpat-dummy_token_do_not_use rejected'))).not.toContain('dummy_token')
  expect(cleanError(new Error('bad ghp_dummy_token_do_not_use'))).not.toContain('dummy_token')
})
