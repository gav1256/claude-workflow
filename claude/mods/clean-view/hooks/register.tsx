import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// The hooks live in clean-view.tsx, the pure logic in model.ts.
export const register: Register = on => {
  registerCleanView(on)
}
