/**
 * dsh-memento-tab — protocol conformance smoke test.
 *
 * The tab's writes only reach the store if dsh-memento's prepended answerer
 * claims the approval request, and it claims on one string: a `reason` that
 * starts with `[dsh-memento] ` and parses under its own regex. This test pins
 * that contract, so an accidental edit to {@link writeReason} fails here rather
 * than silently turning every Write into `unavailable`.
 *
 * Run with `node test/smoke.mjs` (or `npm test`).
 */

import assert from 'node:assert/strict'
import { agentKeyOf, writeReason, workspaceKeyOf } from '../index.mjs'

/**
 * dsh-memento `lib/gate.mjs` `parseWriteReason` — copied verbatim as the
 * conformance oracle. If upstream ever changes it, this test is the alarm.
 */
const UPSTREAM_PARSER = /^\[dsh-memento\] ([a-z]+)(?: \((\d+) entries\))? ([a-z]+)\/([a-z-]+)(?: \[source:([^\]]+)\])?\n([\s\S]*)$/

let failures = 0

/**
 * Run one assertion, reporting instead of throwing so every case is reported.
 * @param {string} label - case name.
 * @param {() => void} body - assertions to run.
 */
function check(label, body) {
  try {
    body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('writeReason ↔ upstream parser')

check('add carries marker, track/scope and the full text', () => {
  const reason = writeReason({ action: 'add', track: 'user', scope: 'workspace', text: 'hello\nworld' })
  const match = UPSTREAM_PARSER.exec(reason)
  assert.ok(match !== null, `upstream parser rejected: ${JSON.stringify(reason)}`)
  assert.equal(match[1], 'add')
  assert.equal(match[3], 'user')
  assert.equal(match[4], 'workspace')
  assert.equal(match[6], 'hello\nworld', 'multi-line text must survive verbatim')
})

check('remove carries the entry text used as the unique substring', () => {
  const reason = writeReason({ action: 'remove', track: 'agent', scope: 'user-global', text: 'no ghostscript' })
  const match = UPSTREAM_PARSER.exec(reason)
  assert.ok(match !== null)
  assert.equal(match[1], 'remove')
  assert.equal(match[3], 'agent')
  assert.equal(match[4], 'user-global')
  assert.equal(match[6], 'no ghostscript')
})

check('batch count renders in upstream position', () => {
  const reason = writeReason({ action: 'seed', track: 'user', scope: 'user-global', text: 'x', count: 3 })
  const match = UPSTREAM_PARSER.exec(reason)
  assert.ok(match !== null, `upstream parser rejected: ${JSON.stringify(reason)}`)
  assert.equal(match[2], '3')
  assert.equal(match[6], 'x')
})

check('source tag renders in upstream position', () => {
  const reason = writeReason({ action: 'add', track: 'agent', scope: 'workspace', text: 'y', source: 'proposal' })
  const match = UPSTREAM_PARSER.exec(reason)
  assert.ok(match !== null, `upstream parser rejected: ${JSON.stringify(reason)}`)
  assert.equal(match[5], 'proposal')
  assert.equal(match[6], 'y')
})

check('count and source together still parse', () => {
  const reason = writeReason({ action: 'seed', track: 'agent', scope: 'workspace', text: 'z', count: 12, source: 'claude' })
  const match = UPSTREAM_PARSER.exec(reason)
  assert.ok(match !== null, `upstream parser rejected: ${JSON.stringify(reason)}`)
  assert.equal(match[2], '12')
  assert.equal(match[5], 'claude')
})

console.log('workspace / agent keys')

check('workspaceKeyOf absolute-resolves a cwd', () => {
  assert.equal(workspaceKeyOf('/tmp/x/../y'), '/tmp/y')
})

check('workspaceKeyOf maps a missing cwd to the shared empty layer', () => {
  assert.equal(workspaceKeyOf(undefined), '')
  assert.equal(workspaceKeyOf(''), '')
})

check('agentKeyOf trims and maps a missing preset to the shared layer', () => {
  assert.equal(agentKeyOf('  standard  '), 'standard')
  assert.equal(agentKeyOf(undefined), '')
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
