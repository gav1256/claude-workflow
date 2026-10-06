import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  applyTaskCall,
  bar,
  baseName,
  parseCommand,
  shortTarget,
  stripFences,
  summarize,
  taskProgress,
  tasksFromTodos,
  toolLabel,
  truncateChars,
  turnLine,
} from './model'

const lines = (n: number, f: (i: number) => string = i => `line ${i}`): string => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n')

// ---------- stripFences ----------

describe('stripFences', () => {
  test('a long block with a language becomes one line', () => {
    const text = `Here it is:\n\n\`\`\`ts\n${lines(20)}\n\`\`\`\n\nDone.`
    expect(stripFences(text)).toBe('Here it is:\n\n`[code · ts · 20 lines]`\n\nDone.')
  })

  test('a long block with no language is named text', () => {
    expect(stripFences(`\`\`\`\n${lines(8)}\n\`\`\``)).toBe('`[code · text · 8 lines]`')
  })

  test('tilde fences work, and a longer fence is closed only by an equal or longer one of its own kind', () => {
    expect(stripFences(`~~~py\n${lines(9)}\n~~~`)).toBe('`[code · py · 9 lines]`')
    const inner = `\`\`\`\`md\n${lines(3)}\n\`\`\`\nmore\n${lines(4)}\n\`\`\`\``
    expect(stripFences(inner)).toBe('`[code · md · 9 lines]`')
    expect(stripFences(`~~~ts\n${lines(7)}\n\`\`\`\n~~~`)).toBe('`[code · ts · 8 lines]`')
  })

  test('backticks in prose are not fences', () => {
    const prose = 'Use ``` to open a block, and `code` inline.\nOr ```js one() ``` on one line.\nThen ~~~ too.'
    expect(stripFences(prose)).toBe(prose)
  })

  test('Hebrew prose is kept as it is, and Hebrew in a long block does not break the count', () => {
    const he = 'שלום עולם, זה טקסט רגיל עם `קוד` בתוכו.'
    expect(stripFences(he)).toBe(he)
    expect(stripFences(`${he}\n\`\`\`ts\n${lines(7, i => `// שורה ${i}`)}\n\`\`\`\n${he}`)).toBe(`${he}\n\`[code · ts · 7 lines]\`\n${he}`)
  })

  test('two blocks collapse one by one; a short block between them stays', () => {
    const text = `\`\`\`ts\n${lines(6)}\n\`\`\`\nmid\n\`\`\`ts\n${lines(2)}\n\`\`\`\n\`\`\`js\n${lines(30)}\n\`\`\``
    expect(stripFences(text)).toBe(`\`[code · ts · 6 lines]\`\nmid\n\`\`\`ts\n${lines(2)}\n\`\`\`\n\`[code · js · 30 lines]\``)
  })

  // the amendment: what stays fully visible
  test('a block of 5 lines or fewer is kept, 3 and 5 alike; 6 collapses', () => {
    const three = `\`\`\`ts\n${lines(3)}\n\`\`\``
    expect(stripFences(three)).toBe(three)
    const five = `\`\`\`ts\n${lines(5)}\n\`\`\``
    expect(stripFences(five)).toBe(five)
    expect(stripFences(`\`\`\`ts\n${lines(6)}\n\`\`\``)).toBe('`[code · ts · 6 lines]`')
  })

  test('a 20-line bash block is kept (a command to run)', () => {
    const block = `\`\`\`bash\n${lines(20, i => `echo ${i}`)}\n\`\`\``
    expect(stripFences(block)).toBe(block)
  })

  test('every command language is kept', () => {
    for (const lang of ['sh', 'bash', 'shell', 'console', 'powershell', 'ps1', 'cmd', 'bat', 'Bash', 'PowerShell']) {
      const block = `\`\`\`${lang}\n${lines(12)}\n\`\`\``
      expect(stripFences(block)).toBe(block)
    }
  })

  test('a 20-line block of "! " lines with no language is kept', () => {
    const block = `\`\`\`\n${lines(20, i => `! run step ${i}`)}\n\`\`\``
    expect(stripFences(block)).toBe(block)
  })

  test('one "! " line anywhere in a long block keeps it', () => {
    const block = `\`\`\`\n${lines(10)}\n! git status\n\`\`\``
    expect(stripFences(block)).toBe(block)
  })

  test('a 12-line json block is kept (a settings line to paste), jsonc too', () => {
    const block = `\`\`\`json\n${lines(12, i => `  "k${i}": ${i},`)}\n\`\`\``
    expect(stripFences(block)).toBe(block)
    const jsonc = `\`\`\`jsonc\n${lines(12, i => `  // ${i}`)}\n\`\`\``
    expect(stripFences(jsonc)).toBe(jsonc)
  })

  test('a 20-line ts block is collapsed', () => {
    expect(stripFences(`\`\`\`ts\n${lines(20)}\n\`\`\``)).toBe('`[code · ts · 20 lines]`')
  })

  test('an unclosed block keeps its text exactly, final newline included', () => {
    const open = `\`\`\`bash\n${lines(10)}\n`
    expect(stripFences(open)).toBe(open)
    const short = '```ts\na\nb\n'
    expect(stripFences(short)).toBe(short)
  })

  test('an unclosed fence is never collapsed, however long, with or without a final newline', () => {
    const open = `text\n\`\`\`ts\n${lines(10)}`
    expect(stripFences(open)).toBe(open)
    expect(stripFences(`${open}\n`)).toBe(`${open}\n`)
    expect(stripFences('```ts')).toBe('```ts')
    const tilde = `intro\n~~~py\n${lines(40)}\nand then prose`
    expect(stripFences(tilde)).toBe(tilde)
  })

  // the reviewer's probes: prose after a stray fence must survive
  test('probe (a): stray fences never swallow the question and the reply that follow', () => {
    const text = '```md\n```bash\nnpm i\n```\n```\nShould I commit this?\nReply yes or no.'
    const out = stripFences(text)
    expect(out).toContain('Should I commit this?')
    expect(out).toContain('Reply yes or no.')
    expect(out).toBe(text) // the first block is 2 lines (kept), the second never closes (kept)
  })

  test('probe (b): a 4-space indented block that holds a fence line keeps the text after it', () => {
    const text = `Steps:\n\n    \`\`\`\n${lines(8, i => `    code ${i}`)}\n    \`\`\`\n    Question: ok?\nDone`
    const out = stripFences(text)
    expect(out).toContain('Question: ok?')
    expect(out).toBe(text) // indented four spaces: no fence at all
  })

  test('a fence indented up to three spaces counts, and its collapsed line keeps that indent', () => {
    const text = `- item\n   \`\`\`ts\n${lines(8)}\n   \`\`\`\n- next item`
    expect(stripFences(text)).toBe('- item\n   `[code · ts · 8 lines]`\n- next item')
    expect(stripFences(`  ~~~\n${lines(6)}\n  ~~~`)).toBe('  `[code · text · 6 lines]`')
  })

  test('a backtick in the info string is no fence', () => {
    const text = `\`\`\`ts \`inline\`\n${lines(10)}\n\`\`\``
    expect(stripFences(text)).toBe(text)
  })

  test('a closing fence may carry trailing spaces but no text', () => {
    expect(stripFences(`\`\`\`ts\n${lines(7)}\n\`\`\`  `)).toBe('`[code · ts · 7 lines]`')
    // a line with text after the fence run is body, not a close: this block never closes, so it stays
    const open = `\`\`\`ts\n${lines(7)}\n\`\`\` oops`
    expect(stripFences(open)).toBe(open)
  })

  test('configuration, shell and diff languages are kept like commands', () => {
    for (const lang of ['zsh', 'fish', 'pwsh', 'ps', 'batch', 'dos', 'shell-session', 'sh-session', 'terminal', 'nu', 'yaml', 'yml', 'toml', 'ini', 'env', 'dotenv', 'diff', 'patch', 'YAML']) {
      const block = `\`\`\`${lang}\n${lines(12)}\n\`\`\``
      expect(stripFences(block)).toBe(block)
    }
    expect(stripFences(`\`\`\`python\n${lines(12)}\n\`\`\``)).toBe('`[code · python · 12 lines]`')
  })

  test('for any input, every line outside a collapsed closed block survives, in order', () => {
    // a seeded generator over fence-like and prose lines, so a failure repeats
    let seed = 12345
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const pool = ['```', '```ts', '```bash', '````', '~~~', '~~~py', '   ```js', '    ```', '\t```', '``` x', '```a`b', '~~~a`b', '```ts', '````md', '', '! cmd', 'prose', '`inline`', 'Question: ok?', 'שלום']
    const opener = /^ {0,3}(`{3,}|~{3,})/
    const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
    for (let round = 0; round < 400; round++) {
      const input: string[] = []
      const count = 1 + rand(30)
      for (let i = 0; i < count; i++) input.push(rand(3) === 0 ? `prose ${round}-${i}` : (pool[rand(pool.length)] as string))
      const out = stripFences(input.join('\n')).split('\n')
      let k = 0
      let i = 0
      while (i < input.length) {
        const line = input[i] as string
        if (out[k] === line) {
          k += 1
          i += 1
          continue
        }
        // a line that is not kept must open a closed block that was collapsed to one line
        const open = opener.exec(line)
        expect(open !== null).toBe(true)
        expect(/^ {0,3}`\[code · [^ ]+ · \d+ lines\]`$/.test(out[k] as string)).toBe(true)
        const mark = (open as RegExpExecArray)[1] as string
        let j = i + 1
        while (j < input.length) {
          const c = closer.exec(input[j] as string)?.[1]
          if (c !== undefined && c[0] === mark[0] && c.length >= mark.length) break
          j += 1
        }
        expect(j < input.length).toBe(true) // it was closed
        expect(j - i - 1).toBeGreaterThan(5) // and long
        k += 1
        i = j + 1
      }
      expect(k).toBe(out.length)
    }
  })

  test('round 2: stray fences closed against each other keep the prose between them whole', () => {
    const text = `\`\`\`md\n${lines(6)}\n\`\`\`\n\`\`\`\n\nShould I commit?\nSay yes.\n${lines(4, i => `more ${i}`)}\n\`\`\`ts\n${lines(3)}\n\`\`\`\nEnd?`
    const out = stripFences(text)
    expect(out).toContain('Should I commit?')
    expect(out).toContain('Say yes.')
    expect(out).toContain('End?')
    // the first block is a real 6-line block and collapses; the span from the stray ``` to the next close stays verbatim
    expect(out).toBe(`\`[code · md · 6 lines]\`\n${text.split('\n').slice(8).join('\n')}`)
  })

  test('round 2: real nesting (a four-backtick md block around a ts fence) still collapses the outer block', () => {
    const text = `before\n\`\`\`\`md\n\`\`\`ts\n${lines(7)}\n\`\`\`\n\`\`\`\`\nafter`
    expect(stripFences(text)).toBe('before\n`[code · md · 9 lines]`\nafter')
    const tilde = `~~~~md\n~~~ts\n${lines(7)}\n~~~\n~~~~`
    expect(stripFences(tilde)).toBe('`[code · md · 9 lines]`')
  })

  test('round 2: a tilde fence with a backtick in its info string is no fence, as for backticks', () => {
    const text = `~~~a\`b\n${lines(10)}\n~~~`
    expect(stripFences(text)).toBe(text)
    const withProse = `intro\n~~~a\`b\n${lines(10)}\n~~~\nQuestion: ok?`
    expect(stripFences(withProse)).toBe(withProse)
  })

  test('text with no fence at all is returned untouched', () => {
    expect(stripFences('plain')).toBe('plain')
    expect(stripFences('')).toBe('')
  })
})

// ---------- shortTarget and summaries ----------

describe('shortTarget', () => {
  test('file tools show the base name only', () => {
    expect(shortTarget('Read', { file_path: 'C:\\Users\\x\\proj\\src\\app.ts' })).toBe('app.ts')
    expect(shortTarget('Edit', { file_path: '/a/b/c.tsx', old_string: 'secret', new_string: 'x' })).toBe('c.tsx')
    expect(shortTarget('Write', { file_path: '/a/b/new.md' })).toBe('new.md')
    expect(shortTarget('MultiEdit', { file_path: '/a/b/m.ts' })).toBe('m.ts')
    expect(shortTarget('NotebookEdit', { notebook_path: '/a/n.ipynb' })).toBe('n.ipynb')
  })

  test('Bash shows its description, else the first words of the command, never the whole command', () => {
    expect(shortTarget('Bash', { command: 'rm -rf /tmp/x && curl https://secret.example.com/token', description: 'Clean up temp files' })).toBe('Clean up temp files')
    expect(shortTarget('Bash', { command: 'git status --porcelain -b | grep M' })).toBe('git status')
    expect(shortTarget('Bash', { command: 'ls' })).toBe('ls')
    expect(shortTarget('Bash', { command: '  \n  ' })).toBe('')
    const long = 'x'.repeat(100)
    expect(Array.from(shortTarget('Bash', { command: 'a', description: long })).length).toBe(40)
    expect(shortTarget('Bash', { command: 'git commit -m "very secret message"' })).not.toContain('secret')
  })

  test('Grep and Glob show the pattern; Agent its description; anything else just the tool name', () => {
    expect(shortTarget('Grep', { pattern: 'foo.*bar', path: '/x' })).toBe('foo.*bar')
    expect(shortTarget('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(shortTarget('Agent', { description: 'Explore the repo', prompt: 'long long prompt' })).toBe('Explore the repo')
    expect(shortTarget('WebFetch', { url: 'https://x.example.com', prompt: 'p' })).toBe('')
    expect(toolLabel('WebFetch', { url: 'https://x.example.com' })).toBe('WebFetch')
    expect(toolLabel('Read', { file_path: '/a/b.ts' })).toBe('Read b.ts')
  })

  test('truncates by code point and never reverses Hebrew', () => {
    const he = 'תיאור ארוך מאוד של משימה שצריכה להיחתך באמצע המשפט בלי לשבור כלום'
    const out = shortTarget('Agent', { description: he })
    expect(Array.from(out).length).toBe(40)
    expect(out.endsWith('…')).toBe(true)
    expect(he.startsWith(out.slice(0, -1))).toBe(true)
    expect(shortTarget('Read', { file_path: '/a/קובץ.ts' })).toBe('קובץ.ts')
    // an astral code point is one unit, not two halves
    expect(truncateChars('😀😀😀😀', 3)).toBe('😀😀…')
    expect(shortTarget('Bash', { command: 'x', description: 'line one\nline two\u0007' })).toBe('line one line two')
  })

  test('bad input does not throw', () => {
    expect(shortTarget('Read', null)).toBe('')
    expect(shortTarget('Bash', 'text')).toBe('')
    expect(shortTarget('Read', { file_path: 3 })).toBe('')
    expect(baseName('')).toBe('')
  })
})

describe('summarize', () => {
  test('Edit and Write count lines from the patch, else the git diff, else the old and new text', () => {
    const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' ctx', '-old', '+new1', '+new2'] }]
    expect(summarize('Edit', { structuredPatch: patch })).toBe('+2 −1')
    expect(summarize('Write', { type: 'update', structuredPatch: patch, content: 'x' })).toBe('+2 −1')
    expect(summarize('Edit', { structuredPatch: [], gitDiff: { additions: 4, deletions: 2 } })).toBe('+4 −2')
    expect(summarize('Edit', { oldString: 'a\nb', newString: 'a\nb\nc\nd' })).toBe('+4 −2')
    expect(summarize('Write', { type: 'create', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null })).toBe('+3 −0')
    expect(summarize('Edit', {})).toBe('edited')
    expect(summarize('Edit', 'weird')).toBe('edited')
    expect(summarize('Edit', { staged: true, structuredPatch: patch })).toBe('held for review, not written')
  })

  test('Read shows the number of lines', () => {
    expect(summarize('Read', { type: 'text', file: { filePath: 'a', content: 'secret', numLines: 120, startLine: 1, totalLines: 120 } })).toBe('120 lines')
    expect(summarize('Read', { type: 'text', file: { numLines: 1 } })).toBe('1 line')
    expect(summarize('Read', { type: 'image', file: {} })).toBe('image')
    expect(summarize('Read', undefined)).toBe('done')
  })

  test('Bash is done, with the interpretation and a stderr mark, never any output and never an exit code', () => {
    expect(summarize('Bash', { stdout: 'TOP SECRET', stderr: '', interrupted: false })).toBe('done')
    expect(summarize('Bash', { stdout: '', stderr: 'warning: x', interrupted: false })).toBe('done · stderr')
    expect(summarize('Bash', { stdout: '', stderr: '  \n', interrupted: false })).toBe('done')
    expect(summarize('Bash', { stdout: '', stderr: '', interrupted: false, returnCodeInterpretation: 'No matches found' })).toBe('done · No matches found')
    expect(summarize('Bash', { stdout: '', stderr: 'e', interrupted: false, returnCodeInterpretation: 'Files differ' })).toBe('done · Files differ · stderr')
    expect(summarize('Bash', { stdout: '', stderr: '', interrupted: false, exitCode: 2 })).toBe('done') // no exit-code claim
    expect(summarize('Bash', { stdout: '', stderr: '', interrupted: true })).toBe('interrupted')
    expect(summarize('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' })).toBe('running in background')
  })

  test('Grep and Glob count matches and files', () => {
    expect(summarize('Grep', { mode: 'files_with_matches', numFiles: 3, filenames: [] })).toBe('3 files')
    expect(summarize('Grep', { mode: 'content', numFiles: 2, filenames: [], numLines: 9, numMatches: 7, content: 'text' })).toBe('7 matches')
    expect(summarize('Grep', { mode: 'count', numFiles: 1, filenames: [], numMatches: 1 })).toBe('1 match')
    expect(summarize('Grep', {})).toBe('done')
    expect(summarize('Glob', { numFiles: 12, filenames: [], truncated: false, durationMs: 1 })).toBe('12 files')
    expect(summarize('Glob', { numFiles: 100, filenames: [], truncated: true, durationMs: 1 })).toBe('100+ files')
    expect(summarize('Glob', { numFiles: 1, filenames: [], truncated: false, durationMs: 1 })).toBe('1 file')
  })

  test('anything else is done', () => {
    expect(summarize('WebFetch', { result: 'page text' })).toBe('done')
    expect(summarize('mcp__x__y', undefined)).toBe('done')
  })
})

// ---------- the turn bar ----------

describe('bar and tasks', () => {
  test('bar fills in proportion and clamps', () => {
    expect(bar(4, 7, 14)).toBe('▕████████░░░░░░▏')
    expect(bar(0, 0, 10)).toBe('▕░░░░░░░░░░▏')
    expect(bar(9, 3, 10)).toBe('▕██████████▏')
    expect(bar(-1, 5, 10)).toBe('▕░░░░░░░░░░▏')
  })

  test('tasksFromTodos reads statuses; applyTaskCall follows TaskCreate and TaskUpdate', () => {
    const todos = tasksFromTodos({ todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'weird' }] })
    expect(todos?.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending', 'pending'])
    expect(tasksFromTodos({})).toBeUndefined()
    let tasks = applyTaskCall(null, 'TaskCreate', { subject: 'a' }, { task: { id: '1', subject: 'a' } })
    tasks = applyTaskCall(tasks, 'TaskCreate', { subject: 'b' }, { task: { id: '2', subject: 'b' } })
    tasks = applyTaskCall(tasks, 'TaskCreate', { subject: 'c' }, undefined)
    expect(tasks?.map(t => t.id)).toEqual(['1', '2', 'task-3'])
    tasks = applyTaskCall(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })
    tasks = applyTaskCall(tasks, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })
    expect(tasks).toEqual([
      { id: '1', status: 'completed' },
      { id: 'task-3', status: 'pending' },
    ])
    expect(taskProgress(tasks ?? [])).toEqual({ done: 1, total: 2 })
    expect(applyTaskCall(null, 'TaskUpdate', { taskId: '9' }, undefined)).toBeNull()
  })

  test('turnLine uses the task list, else the tool call counter, and is at least 10 cells wide', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ id: String(i), status: i < 4 ? ('completed' as const) : ('pending' as const) }))
    const withTasks = turnLine({ tasks, started: 3, finished: 3 }, 80)
    expect(withTasks.label).toBe('4/7 tasks')
    expect(withTasks.bar.startsWith('▕')).toBe(true)
    expect(Array.from(withTasks.bar).filter(c => c === '█').length).toBe(Math.round((4 / 7) * (Array.from(withTasks.bar).length - 2)))
    const counter = turnLine({ tasks: null, started: 12, finished: 10 }, 80)
    expect(counter.label).toBe('12 tool calls')
    expect(turnLine({ tasks: null, started: 1, finished: 0 }, 80).label).toBe('1 tool call')
    expect(Array.from(turnLine({ tasks: null, started: 0, finished: 0 }, 5).bar).length).toBe(12) // 10 cells and the two ends
    expect(Array.from(turnLine({ tasks: [], started: 2, finished: 1 }, 80).bar).length).toBeLessThanOrEqual(32)
  })

  test('parseCommand', () => {
    expect(parseCommand('')).toBe('toggle')
    expect(parseCommand(undefined)).toBe('toggle')
    expect(parseCommand(' ON ')).toBe('on')
    expect(parseCommand('off')).toBe('off')
    expect(parseCommand('status')).toBe('status')
    expect(parseCommand('maybe')).toBe('unknown')
    expect(parseCommand(['off'])).toBe('off')
  })
})

// ---------- the hooks, through the test kit ----------

const ENGINE = 'ENGINE DRAWS THIS'
const text = (s: string) => ({ type: 'Text' as const, props: {}, children: [s] })

// $.state in memory, and an engine bottom for every site the mod hooks, so a pass-through shows as ENGINE.
function world(on: On) {
  const stored: Record<string, unknown> = {}
  const reads = { n: 0 }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('store.get', (_$, e) => {
    reads.n += 1
    return { value: stored[e.key] }
  })
  on('store.set', (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  const state = new Map<string, { value: unknown; version: number }>()
  on('state.get', (_$, e) => {
    const held = state.get(`${e.plugin}/${e.key}`)
    return { value: { value: held?.value, version: held?.version ?? 0 } }
  })
  on('state.set', (_$, e) => {
    const k = `${e.plugin}/${e.key}`
    const version = (state.get(k)?.version ?? 0) + 1
    state.set(k, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.render', (_$, e) => (e.component === 'AssistantMessage' ? text(`MSG:${(e.props as { text: string }).text}`) : text(ENGINE)) as never)
  return { stored, reads }
}

const toolProps = (o: Record<string, unknown> = {}) =>
  ({ tool_use_id: 'tu1', tool: 'Read', input: { file_path: '/a/b/app.ts' }, isRunning: false, isErrored: false, isInterrupted: false, ...o }) as never

const resultProps = (o: Record<string, unknown> = {}) =>
  ({ tool_use_id: 'tu1', tool: 'Edit', output: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] }, isErrored: false, ...o }) as never

const promptProps = (o: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 8 }, view: {}, ...o }) as never

const SURFACES = ['terminal', 'desktop'] as const

test('a running row is one line with a bar, a finished row one line with a check', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const running = await $.ui.mount({ plugin: 'progress-bars', surface, component: 'ToolUse', props: toolProps({ isRunning: true }), requestId: 'r1' })
    expect(await running.find({ type: 'Text', text: '▸' })).toBeDefined()
    expect(await running.find({ type: 'Text', text: 'Read app.ts' })).toBeDefined()
    expect(await running.find({ type: 'Text', text: '░░▒▓' })).toBeDefined()
    expect(await running.find({ text: ENGINE })).toBeUndefined()
    await running.unmount()

    const done = await $.ui.mount({ plugin: 'progress-bars', surface, component: 'ToolUse', props: toolProps(), requestId: 'r2' })
    expect(await done.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect(await done.find({ type: 'Text', text: 'Read app.ts' })).toBeDefined()
    await done.unmount()

    const bash = await $.ui.mount({
      plugin: 'progress-bars',
      surface,
      component: 'ToolUse',
      props: toolProps({ tool: 'Bash', input: { command: 'rm -rf build && echo SECRET_TOKEN', description: 'Clean the build' } }),
      requestId: 'r3',
    })
    expect(await bash.find({ type: 'Text', text: 'Bash Clean the build' })).toBeDefined()
    expect(JSON.stringify(await bash.drawn())).not.toContain('SECRET_TOKEN')
    await bash.unmount()
  }
})

test('rows pass through to the engine when off, errored, interrupted, or a question or plan tool', async ($, on) => {
  const { stored } = world(on)
  const drawsEngine = async (props: never, store?: boolean) => {
    if (store !== undefined) stored.enabled = store
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolUse', props, requestId: `p${Math.random()}` })
    const found = await m.find({ text: ENGINE })
    await m.unmount()
    return found !== undefined
  }
  expect(await drawsEngine(toolProps({ isRunning: true }), true)).toBe(false) // on: replaced
  expect(await drawsEngine(toolProps({ isErrored: true }))).toBe(true)
  expect(await drawsEngine(toolProps({ isInterrupted: true }))).toBe(true)
  expect(await drawsEngine(toolProps({ tool: 'AskUserQuestion', input: { questions: [] } }))).toBe(true)
  expect(await drawsEngine(toolProps({ tool: 'ExitPlanMode', input: { plan: 'p' } }))).toBe(true)
  expect(await drawsEngine(toolProps({ tool: 'EnterPlanMode', input: {} }))).toBe(true)
  expect(await drawsEngine(toolProps(), false)).toBe(true) // off
})

test('only the allowlisted tools collapse; a message to the person, a goal, an MCP tool or any other tool is the engine\'s', async ($, on) => {
  const { stored } = world(on)
  stored.enabled = true
  const drawsEngine = async (tool: string) => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolUse', props: toolProps({ tool, input: {} }), requestId: `a${Math.random()}` })
    const found = await m.find({ text: ENGINE })
    await m.unmount()
    return found !== undefined
  }
  for (const tool of ['SendUserMessage', 'SendUserFile', 'ProposeGoal', 'mcp__srv__lookup', 'mcp__srv__authenticate', 'SuggestPlugins', 'OfferHelp', 'ShowOnboardingGuide', 'Skill', 'NewFutureTool']) {
    expect(await drawsEngine(tool)).toBe(true)
  }
  for (const tool of ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent']) {
    expect(await drawsEngine(tool)).toBe(false)
  }
})

test('a finished result is replaced by one dim summary line that is really drawn', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface, component: 'ToolResult', props: resultProps(), requestId: 'x1' })
    const drawn = await m.drawn()
    expect(drawn.type).toBe('Text')
    expect((drawn as { props?: Record<string, unknown> }).props?.dimColor).toBe(true)
    expect((await m.find({ type: 'Text', text: /\+2 −1/ }))?.text).toContain('+2 −1')
    expect(await m.find({ text: ENGINE })).toBeUndefined()
    await m.unmount()

    const read = await $.ui.mount({
      plugin: 'progress-bars',
      surface,
      component: 'ToolResult',
      props: resultProps({ tool: 'Read', output: { type: 'text', file: { filePath: '/a', content: 'SECRET CONTENT', numLines: 42, startLine: 1, totalLines: 42 } } }),
      requestId: 'x2',
    })
    expect(await read.find({ type: 'Text', text: /42 lines/ })).toBeDefined()
    expect(JSON.stringify(await read.drawn())).not.toContain('SECRET CONTENT')
    await read.unmount()

    const bash = await $.ui.mount({
      plugin: 'progress-bars',
      surface,
      component: 'ToolResult',
      props: resultProps({ tool: 'Bash', output: { stdout: 'SECRET OUT', stderr: '', interrupted: false } }),
      requestId: 'x3',
    })
    expect(await bash.find({ type: 'Text', text: /done/ })).toBeDefined()
    expect(JSON.stringify(await bash.drawn())).not.toContain('SECRET OUT')
    await bash.unmount()
  }
})

test('results pass through when errored, for a question or plan tool, and when off', async ($, on) => {
  const { stored } = world(on)
  const drawsEngine = async (props: never, store?: boolean) => {
    if (store !== undefined) stored.enabled = store
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolResult', props, requestId: `q${Math.random()}` })
    const found = await m.find({ text: ENGINE })
    await m.unmount()
    return found !== undefined
  }
  expect(await drawsEngine(resultProps(), true)).toBe(false)
  expect(await drawsEngine(resultProps({ isErrored: true }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'AskUserQuestion', output: {} }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'ExitPlanMode', output: {} }))).toBe(true)
  expect(await drawsEngine(resultProps(), false)).toBe(true)
})

test('results of tools outside the allowlist, and text outputs (a refusal, an abort), are the engine\'s', async ($, on) => {
  const { stored } = world(on)
  stored.enabled = true
  const drawsEngine = async (props: never) => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolResult', props, requestId: `t${Math.random()}` })
    const found = await m.find({ text: ENGINE })
    await m.unmount()
    return found !== undefined
  }
  expect(await drawsEngine(resultProps({ tool: 'SendUserMessage', output: { sent: true } }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'mcp__srv__lookup', output: { rows: [] } }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'Bash', output: 'Permission to use Bash has been denied.' }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'Read', output: 'The user doesn\'t want to proceed.' }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'Edit', output: null }))).toBe(true)
  expect(await drawsEngine(resultProps({ tool: 'Edit', output: undefined }))).toBe(true)
  expect(await drawsEngine(resultProps())).toBe(false) // an object output of an allowlisted tool is collapsed
})

test('assistant text has its long code blocks collapsed, prose and other props untouched, and passes when off', async ($, on) => {
  const { stored } = world(on)
  const props = { text: `Look:\n\`\`\`ts\n${lines(9)}\n\`\`\`\nשלום`, isFirstOfReply: true } as never
  const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AssistantMessage', props, requestId: 'a1' })
  expect((await m.find({ type: 'Text' }))?.text).toBe('MSG:Look:\n`[code · ts · 9 lines]`\nשלום')
  await m.unmount()

  stored.enabled = false
  const off = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AssistantMessage', props, requestId: 'a2' })
  expect((await off.find({ type: 'Text' }))?.text).toContain('```ts')
  await off.unmount()
})

test('the turn bar shows 4/7 tasks from a TodoWrite, and follows later TaskCreate and TaskUpdate calls', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }) as never)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: Array.from({ length: 7 }, (_, i) => ({ content: `t${i}`, activeForm: `t${i}`, status: i < 4 ? 'completed' : 'pending' })),
  } as never)
  await clock.settle()
  for (const surface of SURFACES) {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface, component: 'AbovePrompt', props: promptProps(), requestId: 'b1' })
    expect(await m.find({ type: 'Text', text: '4/7 tasks' })).toBeDefined()
    const barText = (await m.findAll({ type: 'Text' })).map(f => f.text).find(t => t.startsWith('▕')) ?? ''
    expect(barText.endsWith('▏')).toBe(true)
    expect(Array.from(barText).length).toBeGreaterThanOrEqual(12)
    expect(await m.find({ text: ENGINE })).toBeDefined() // the engine's own band stays above the bar
    await m.unmount()
  }
})

test('with no task list the bar counts tool calls of this turn, and a new turn resets the count', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}` } as never)
  await $.tool.call({ tool: 'Bash', agentId: 'sub', command: 'subagent call is not counted' } as never)
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'c1' })
  expect(await m.find({ type: 'Text', text: '3 tool calls' })).toBeDefined()
  await m.unmount()

  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.settle()
  const next = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'c2' })
  expect(await next.find({ type: 'Text', text: '0 tool calls' })).toBeDefined()
  await next.unmount()
})

test('the task list outlives a turn; a TaskCreate / TaskUpdate list is followed', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let n = 0
  on('tool.call', (_$, e) => (e.tool === 'TaskCreate' ? ({ result: { task: { id: String(++n), subject: 's' } } }) : ({ result: { success: true } })) as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.turn.start({ text: 'next turn', turnId: 't9' })
  await clock.settle()
  const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: 'd1' })
  expect(await m.find({ type: 'Text', text: '1/2 tasks' })).toBeDefined()
  await m.unmount()
})

test('the turn bar yields to a survey, to an idle prompt, and to /bars off', async ($, on) => {
  const { stored } = world(on)
  const draws = async (props: never) => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props, requestId: `e${Math.random()}` })
    const bar = await m.find({ type: 'Text', text: /tool call/ })
    await m.unmount()
    return bar !== undefined
  }
  expect(await draws(promptProps())).toBe(true)
  expect(await draws(promptProps({ hasSurvey: true }))).toBe(false)
  expect(await draws(promptProps({ isWorking: false }))).toBe(false)
  stored.enabled = false
  expect(await draws(promptProps())).toBe(false)
})

test('/bars flips, sets and reports the state; the state is kept in $.store and every change invalidates ui.render', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  const invalidated: unknown[] = []
  on('ui.invalidate', (_$, e) => {
    invalidated.push(e)
    return { value: undefined } as never
  })
  const { stored } = world(on)
  const run = (args: string) =>
    $.command.run({ command: 'bars', args, origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 100 } } as never)

  expect(String((await run('status')).text)).toMatch(/on/) // the default is on
  expect(stored.enabled).toBeUndefined()
  expect(invalidated.length).toBe(0)

  expect(String((await run('')).text)).toMatch(/off/) // bare flips on -> off
  expect(stored.enabled).toBe(false)
  expect(invalidated.length).toBe(1)
  expect(String((await run('status')).text)).toMatch(/off/)

  expect(String((await run('on')).text)).toMatch(/on/)
  expect(stored.enabled).toBe(true)
  expect(invalidated.length).toBe(2)

  await run('off')
  expect(stored.enabled).toBe(false)
  expect(invalidated.length).toBe(3)
  await run('')
  expect(stored.enabled).toBe(true)
  expect(invalidated.length).toBe(4)
  expect(toasts.length).toBe(4)

  expect(String((await run('banana')).text)).toMatch(/Usage/)
  expect(stored.enabled).toBe(true)
  expect(invalidated.length).toBe(4)
})

test('a failed TaskUpdate or TaskCreate (success false, an error, a deny) is not counted in the task list', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  let reply: unknown = {}
  on('tool.call', () => ({ result: reply }) as never)
  const mountTasks = async () => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: `f${Math.random()}` })
    const found = (await m.findAll({ type: 'Text' })).map(f => f.text)
    await m.unmount()
    return found
  }
  reply = { task: { id: '1', subject: 'a' } }
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' } as never)
  reply = { success: true, taskId: '1', updatedFields: ['status'] }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await clock.settle()
  expect(await mountTasks()).toContain('1/1 tasks')

  reply = { success: false, taskId: '2', updatedFields: [], error: 'Task not found' }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' } as never)
  reply = { success: false, taskId: '1', updatedFields: [] }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'pending' } as never)
  reply = { error: 'boom', task: { id: '3', subject: 'c' } }
  await $.tool.call({ tool: 'TaskCreate', subject: 'c', description: 'c' } as never)
  await clock.settle()
  expect(await mountTasks()).toContain('1/1 tasks') // unchanged: the three failed calls added and changed nothing
})

test('the switch is read from $.store once at session start; the render hooks then read the mirror, never the store', async ($, on) => {
  const clock = mock.clock(on)
  const { stored, reads } = world(on)
  stored.enabled = false
  await $.session.start({ cwd: 'C:/x/mine', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  expect(reads.n).toBe(1)
  const before = reads.n
  const row = async () => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolUse', props: toolProps(), requestId: `m${Math.random()}` })
    const engine = (await m.find({ text: ENGINE })) !== undefined
    await m.unmount()
    return engine
  }
  const msg = await $.ui.mount({
    plugin: 'progress-bars',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: `\`\`\`ts\n${lines(9)}\n\`\`\``, isFirstOfReply: true } as never,
    requestId: 'mm',
  })
  await msg.unmount()
  expect(await row()).toBe(true) // off, read from the store at start
  expect(await row()).toBe(true)
  expect(reads.n).toBe(before) // 4 draws, no store read

  stored.enabled = true // a change made behind the mod's back is not seen: the mirror is what draws
  expect(await row()).toBe(true)
  expect(reads.n).toBe(before)
})

test('/bars writes the store and the mirror: the very next draw follows it without a store read', async ($, on) => {
  const clock = mock.clock(on)
  const { stored, reads } = world(on)
  await $.session.start({ cwd: 'C:/x/mine', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  const row = async () => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'ToolUse', props: toolProps(), requestId: `n${Math.random()}` })
    const engine = (await m.find({ text: ENGINE })) !== undefined
    await m.unmount()
    return engine
  }
  const run = (args: string) =>
    $.command.run({ command: 'bars', args, origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(await row()).toBe(false) // default on: collapsed
  const before = reads.n
  await run('off')
  expect(stored.enabled).toBe(false)
  expect(await row()).toBe(true)
  await run('on')
  expect(stored.enabled).toBe(true)
  expect(await row()).toBe(false)
  expect(reads.n).toBe(before) // no store read by the command or the draws: the mirror answers
})

test('session.start does not reset the task list; session.end does', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }) as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', activeForm: 'a', status: 'completed' }, { content: 'b', activeForm: 'b', status: 'pending' }] } as never)
  await $.session.start({ cwd: 'C:/x/mine', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  const label = async () => {
    const m = await $.ui.mount({ plugin: 'progress-bars', surface: 'terminal', component: 'AbovePrompt', props: promptProps(), requestId: `s${Math.random()}` })
    const t = (await m.findAll({ type: 'Text' })).map(f => f.text).join('|')
    await m.unmount()
    return t
  }
  expect(await label()).toContain('1/2 tasks')
  await $.session.end({ sessionId: 's', reason: 'clear' } as never)
  await clock.settle()
  expect(await label()).toContain('0 tool calls')
})
