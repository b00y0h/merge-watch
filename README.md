# Merge Watch

A Claude Code mod that opens a panel beside the conversation listing every open merge request in
the current repository (or pull request, on GitHub), with its review state, its blockers and every
CI/CD job, refreshed once a minute.

```
Merge Watch · team/my-project
3 open MRs · Updated 14:32:05
[ Refresh ] [ Hide ]
▾ !142 Add the pricing page                         ▶ Running
  Open · Awaiting review · Not ready to merge · Needs approval
  pricing-page → main · by alex  copy link
  Pipeline #830 · 2 passed · 1 running · 1 pending  ▶ Running
    ▶ build                                           Running
▸ !139 Fix checkout validation                      ✕ Failed
  Open · Changes requested · Not ready to merge
```

- Click a request's title to open it in your browser. Click a job to open that job.
- The ▾/▸ arrow beside a title collapses or expands its jobs. Your choice is remembered per repository.
- Only jobs that need a look get a row of their own: running, failed (allowed failures included, and
  labelled), blocked, unknown, and manual jobs that block the pipeline. Every other job is counted on
  the pipeline's line ("26 passed · 1 failed · 3 pending"), so a collapsed request takes two lines.
- Every status has an icon and a word: Passed, Failed, Running, Pending, Manual, Blocked, Skipped,
  Cancelled, No pipeline, No checks, Unknown, Unavailable.
- Readiness ("Ready to merge", blockers such as merge conflicts) is shown apart from CI. Passing CI
  alone never means ready.
- Data that could not be refreshed stays on screen, labelled stale with the time it dates from.
  A pipeline for an older commit is labelled "Previous revision" and is never shown as the current result.

Refreshing calls the GitLab CLI or the GitHub API only. It never starts a Claude turn and uses no
model tokens. It never creates pipelines, plays or retries jobs, or changes a request.

## Install

Merge Watch is installed per project. From the root of the project:

```bash
claude plugin marketplace add b00y0h/merge-watch --scope project
claude plugin install merge-watch@merge-watch --scope project
```

`--scope project` writes the marketplace and the enabled plugin to the project's
`.claude/settings.json`. Once that file is committed, collaborators are prompted to install the
marketplace when they trust the project, but **each collaborator still installs it themselves**.

To use it only for yourself in one repository, without touching the shared settings, use local scope
instead (written to `.claude/settings.local.json`):

```bash
claude plugin marketplace add b00y0h/merge-watch --scope local
claude plugin install merge-watch@merge-watch --scope local
```

Restart Claude Code, or run `/reload-plugins`, to load it. Merge Watch does nothing until you run
`/merge-watch`: no panel opens and nothing is fetched when a session starts.

## Sign-in

**GitLab** (gitlab.com and self-hosted): Merge Watch uses the GitLab CLI, `glab`, and reuses its sign-in.
Install glab, then in your own terminal:

```bash
glab auth login --hostname gitlab.example.com
```

Merge Watch passes `--hostname` on every call, so it always asks the host your remote points at.

**GitHub** (github.com and GitHub Enterprise): Merge Watch calls the GitHub REST API directly and needs
a token with read access to pull requests, checks, actions and commit statuses. Either:

- enter it in the plugin's `github_token` option with `/plugin configure merge-watch@merge-watch`
  (stored in your system's secure storage, not in settings files), or
- start Claude Code with `GITHUB_TOKEN` (or `GH_TOKEN`) set in its environment.

Never paste a token into the chat or a project file. A GitLab sign-in cannot be used for GitHub.

## Commands

| Command | What it does |
|---|---|
| `/merge-watch` | Start watching this repository and open the panel. Run it again to bring the panel back |
| `/merge-watch refresh` | Refresh now. A refresh already running is joined, not repeated |
| `/merge-watch hide` | Close the panel, keep refreshing in the background |
| `/merge-watch off` | Close the panel and stop refreshing for this repository |
| `/merge-watch on` | Same as `/merge-watch`: start (or resume), refresh at once and open the panel |
| `/merge-watch repo` | Show which repository is watched and pick another remote |
| `/merge-watch repo <remote>` | Watch the remote with that name, e.g. `upstream` |

The panel's **Hide** button works like `/merge-watch hide`. All commands work while Claude is busy.

## Which repository it watches

Merge Watch finds the Git repository from the session's working directory, including nested folders
and Git worktrees, and reads its remotes (HTTPS, SSH and `git@host:group/sub/project` forms, nested
GitLab groups included). It uses, in order: the remote you picked before, then `origin`, then the only
supported remote. If several remotes are equally plausible it shows a picker instead of guessing.

github.com and gitlab.com are recognised, as is any host with `gitlab.` in its name. Add other hosts in
the plugin options: `github_hosts` for GitHub Enterprise, `gitlab_hosts` for self-hosted GitLab.

Preferences are stored per repository, keyed by provider, host and full project path, so two projects
with the same name on different hosts never share settings. The remote you picked is stored per
checkout and survives restarts.

## Troubleshooting

- **"Open a Git project to use Merge Watch."** The session is not inside a Git repository.
- **"has no GitLab or GitHub remote Merge Watch recognises"** Add your host to `gitlab_hosts` or
  `github_hosts` with `/plugin configure merge-watch@merge-watch`.
- **A sign-in message in the panel** Follow it: `glab auth login --hostname <host>` for GitLab, or
  set a GitHub token as above. Then run `/merge-watch refresh`.
- **"Polling slowed by the provider. Next try at …"** The provider rate-limited Merge Watch. It
  waits until then before asking again, and keeps showing the last data.
- **"Previous revision"** The newest pipeline ran for an older commit. Push or re-run CI in GitLab
  or GitHub; Merge Watch never triggers pipelines itself.
- **The panel never appears on its own** That is by design. Run `/merge-watch` in each session where you
  want it.
- **`claude -p` answers that Merge Watch needs an app** A headless run has nowhere to show the panel, so
  Merge Watch does not start there.

To see why a mod did nothing, start Claude Code with `claude --debug` and look for lines that mention
`merge-watch`.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The tests mock git, glab, the GitHub API, the clock and storage, so they need no credentials or network.
