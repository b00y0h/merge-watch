// Merge Watch's shared display model and its $.state contract.
// Both adapters (GitLab, GitHub) produce these shapes; the pane only renders them.

export type MergeWatchProvider = 'gitlab' | 'github'

/** A CI state, provider-neutral. Never `passed` unless the provider said so for the current revision. */
export type MergeWatchCiState =
  | 'passed'
  | 'warning'
  | 'failed'
  | 'running'
  | 'pending'
  | 'manual'
  | 'blocked'
  | 'skipped'
  | 'cancelled'
  | 'no-pipeline'
  | 'no-checks'
  | 'unknown'
  | 'unavailable'

export type MergeWatchJob = {
  id: string
  name: string
  state: MergeWatchCiState
  /** The word shown beside the icon, e.g. "Failed (allowed)", "Manual (optional)". */
  label: string
  isAllowedFailure: boolean
  /** A validated http(s) URL, or null when the provider gave no link for this job. */
  url: string | null
  stage: string | null
}

export type MergeWatchPipeline = {
  /** e.g. "Pipeline #830", "CI workflow", "Commit statuses". */
  title: string
  state: MergeWatchCiState
  label: string
  url: string | null
  /** The pipeline belongs to an older commit of the request: its result is not the current one. */
  isPreviousRevision: boolean
  /** Some jobs or child pipelines could not be loaded. */
  isIncomplete: boolean
  notes: string[]
  jobs: MergeWatchJob[]
  children: MergeWatchPipeline[]
}

export type MergeWatchRequest = {
  /** Unique within the repository: the provider's number as a string. */
  key: string
  number: number
  /** "!142" on GitLab, "#142" on GitHub. */
  ref: string
  title: string
  url: string | null
  author: string
  sourceBranch: string
  targetBranch: string
  /** Set when the source lives in another project or fork. */
  sourceProject: string | null
  isDraft: boolean
  /** "Awaiting review", "Approved", "Changes requested", ... */
  review: string
  /** Request readiness, kept apart from CI. "Ready to merge" only when the provider says so. */
  readiness: string
  blockers: string[]
  ci: {
    state: MergeWatchCiState
    label: string
    pipelines: MergeWatchPipeline[]
  }
  updatedAt: string
  /** This request's data could not be refreshed; what is shown is from `staleSince`. */
  error: string | null
  staleSince: number | null
}

export type MergeWatchRepo = {
  provider: MergeWatchProvider
  host: string
  /** Full project path, nested groups included: "group/sub/project" or "owner/repo". */
  path: string
  /** provider:host/path, lower-cased host. Every preference is stored under it. */
  key: string
  remoteName: string
  webUrl: string
}

export type MergeWatchSnapshot = {
  repoKey: string
  /** When the request list was last fetched successfully (ms). Null before the first success. */
  fetchedAt: number | null
  requests: MergeWatchRequest[]
  /** Why the last refresh failed as a whole, if it did. */
  error: string | null
  /** Setup instructions when authentication is missing. */
  authHelp: string | null
  /** Polling is slowed (rate limit): the next attempt is not before this time (ms). */
  nextRetryAt: number | null
}

export type MergeWatchPhase =
  | 'idle'
  | 'not-git'
  | 'no-remote'
  | 'choose-repo'
  | 'ready'
  | 'off'

export type MergeWatchView = {
  phase: MergeWatchPhase
  repo: MergeWatchRepo | null
  candidates: MergeWatchRepo[]
  isRefreshing: boolean
  isChoosing: boolean
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'merge-watch': {
      view: MergeWatchView
      snapshot: MergeWatchSnapshot | null
      expanded: Record<string, boolean>
    }
  }
}
