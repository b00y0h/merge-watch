# Merge Watch

A Claude Code mod that opens a panel beside the conversation listing every open merge request in
the current repository (or pull request, on GitHub), grouped by whether it can merge, with its
failing jobs one click away. It refreshes once a minute.

```
Merge Watch · platform/meridian                         ↻ ⤢ ✕
 2 ready          3 failing                  1 draft
READY TO MERGE 2 ─────────────────────────────────────────────
!1030  add ADR-1000 design-system buttons an…   ━━━━━━━━━━ ▸
       ✓ needs review · 1 allowed failure
PIPELINE FAILING 3 ───────────────────────────────────────────
!1007  update dependency @ai-sdk/amazon-bed…    ━━━━━━━━━━ ▾
       ✕ typecheck
       fix(deps): update dependency @ai-sdk/amazon-bedrock to v5
       Status    Open · No approval required
       Branch    renovate/ai-sdk-amazon-bedrock-5.x → main · renovate
       Pipeline  #1470130 · 35 passed · 2 failed · 8 manual
       ╭───────────────────────────────────────────╮
       │ typecheck                          failed │
       │ dependency-audit                  allowed │
       ╰───────────────────────────────────────────╯
       [ Retry failed ] ( Open MR ) [ Copy link ]
6 of 12 open · updated 14:25:35 · show all
```

- **Groups.** Ready to merge: GitLab or GitHub says it can merge and the pipeline passed ("passed with
  warnings" counts). Pipeline failing: everything else that is not a draft, including a pipeline still
  running or a request waiting for approval. Drafts: drafts, whatever their pipeline. Data that could not
  be refreshed is never shown as ready.
- **Rows.** Each request is two lines: its title without the `feat(scope):` prefix, and a reason line
  (failed job names, or "needs review · 1 allowed failure"). Allowed failures never count as failures.
  The small bar shows the pipeline's mix: passed, failed, allowed to fail, manual.
- **Click a title** (or the ▸) to expand it: the full title, status, branch, pipeline counts, and a table
  of failed, running and allowed-to-fail jobs, five failures at a time. Job names link to the job.
  Expanded rows are remembered per repository; ⤢ opens or closes them all.
- **Show all.** Requests not updated for 14 days are hidden until you press "show all". That choice is
  remembered per repository.
- **Actions.** Ready and mergeable: **Merge**. Awaiting review: **Review** (opens it). Failing:
  **Retry failed**, which re-runs only the failed jobs that are not allowed to fail. Merge and Retry
  ask you to confirm first, and a merge is pinned to the commit the panel showed, so a push in the
  meantime makes the provider refuse it rather than merge something you did not see.
- Data that could not be refreshed stays on screen, labelled stale with the time it dates from.
  A pipeline for an older commit is labelled "Previous revision" and is never shown as the current result.

Refreshing calls the GitLab CLI or the GitHub API only. It never starts a Claude turn and uses no
model tokens. The only changes it ever makes are Retry failed and Merge, and only after you confirm.

On the desktop app the summary and pipeline bars are drawn as graphics; in the terminal they are
coloured block characters. Fonts and sizes follow each app, since a mod cannot set them.

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
a token with read access to pull requests, checks, actions and commit statuses (and write access to
actions and contents if you want Retry failed and Merge to work). Either:

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
  or GitHub, or use Retry failed on the current pipeline.
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
