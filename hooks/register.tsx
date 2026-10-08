import type { Register } from 'claude-code'

import { registerMergeWatch } from './merge-watch'

// One entry point, so more mods can be registered beside Merge Watch later.
export const register: Register = (on, options) => {
  registerMergeWatch(on, options)
}
