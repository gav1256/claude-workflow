// JSON validity of the theme files. A hooks module cannot read files (and the plugin test runner is sandboxed), so this
// runs on its own with Node: `node --test tests/themes.test.mjs`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const load = name => JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), 'utf8'))
const TOKENS = ['claude', 'claudeShimmer', 'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'permission', 'remember', 'success', 'error', 'warning', 'merged', 'promptBorder', 'promptBorderShimmer', 'planMode', 'autoAccept', 'bashBorder', 'ide', 'fastMode', 'userMessageBackground', 'userMessageBackgroundHover', 'bashMessageBackgroundColor', 'memoryBackgroundColor', 'selectionBg', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord', 'rate_limit_fill', 'rate_limit_empty']

for (const file of ['warm', 'clean-view']) {
  test(`${file}.json: a name, a base, and #rrggbb overrides`, () => {
    const t = load(file)
    assert.equal(typeof t.name, 'string')
    assert.ok(['dark', 'light'].includes(t.base))
    const entries = Object.entries(t.overrides)
    assert.ok(entries.length > 5)
    for (const [token, color] of entries) assert.match(`${token}: ${color}`, /^\w+: #[0-9a-fA-F]{6}$/)
  })
}

test('Clean View Dark: its name, and every documented token', () => {
  const t = load('clean-view')
  assert.equal(t.name, 'Clean View Dark')
  assert.equal(t.base, 'dark')
  for (const token of TOKENS) assert.ok(token in t.overrides, token)
  assert.deepEqual(Object.keys(t.overrides).filter(k => !TOKENS.includes(k)), [])
  assert.equal(t.overrides.claude, '#e86aa0')
  assert.equal(t.overrides.success, '#3fb950')
})
