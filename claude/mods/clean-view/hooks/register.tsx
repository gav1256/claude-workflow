import type { Register } from 'claude-code'

import { registerBand, registerCleanView, registerSessions, registerShared } from './plugin'

// One plugin, two features. `plugin.tsx` holds every function that takes `$` (validate follows `$` only within one
// file): the hooks only Clean View has, the hooks only Sessions has, the hooks both share (one each, in a fixed
// order) and the band they draw in. The pure logic is in `model.ts`, `model-clean.ts`, `model-sessions.ts`,
// `look.ts`, `migrate.ts` and `io.ts`.
export const register: Register = on => {
  registerCleanView(on)
  registerSessions(on)
  registerShared(on)
  registerBand(on)
}
