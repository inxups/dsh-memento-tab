/**
 * dsh-memento-tab — protocol conformance smoke test.
 *
 * Two upstream contracts are pinned here:
 *
 *   1. the approval `reason` format — the tab's writes only reach the store if
 *      dsh-memento's prepended answerer claims the request, and it claims on one
 *      byte-exact string;
 *   2. the export/import interchange format — the file the tab produces must be
 *      one `/memory import` accepts, and the ceilings the tab shows must be the
 *      seam's own.
 *
 * The second half needs the installed upstream package. When it is missing the
 * checks are SKIPPED, not failed, so the repo still tests on a bare checkout.
 *
 * Run with `node test/smoke.mjs` (or `npm test`).
 * Set `DSH_MEMENTO_SOURCE` to the upstream package root when it is not the default.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXPORT_PLUGIN, EXPORT_SCHEMA, MAX_IMPORT_ENTRIES, MAX_MERGE_MATCHES, agentKeyOf, exportEnvelope, writeReason, workspaceKeyOf } from '../index.mjs'

/**
 * dsh-memento `lib/gate.mjs` `parseWriteReason` — copied verbatim as the
 * conformance oracle. If upstream ever changes it, this test is the alarm.
 */
const UPSTREAM_PARSER = /^\[dsh-memento\] ([a-z]+)(?: \((\d+) entries\))? ([a-z]+)\/([a-z-]+)(?: \[source:([^\]]+)\])?\n([\s\S]*)$/

/** Installed upstream package root; same convention as load.mjs's DSH_SOURCE. */
const MEMENTO_SOURCE = process.env.DSH_MEMENTO_SOURCE ?? '/Users/inxups/.dsh/profiles/web/node_modules/dsh-memento'

/**
 * Load the installed dsh-memento: its internal constants and its public root.
 *
 * `lib/constants.mjs` is not in the package's `exports` map, but the constants
 * are protocol values this plugin mirrors, so the test reaches them by path
 * rather than pretending the copy is self-evidently correct.
 * @returns {Promise<{constants: any, root: any} | null>} modules, or null when absent.
 */
async function loadUpstream() {
  try {
    const constants = await import(pathToFileURL(join(MEMENTO_SOURCE, 'lib/constants.mjs')).href)
    const root = await import(pathToFileURL(join(MEMENTO_SOURCE, 'index.mjs')).href)
    return { constants, root }
  } catch {
    return null
  }
}

const upstream = await loadUpstream()

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

console.log('export / import interchange ↔ upstream')

if (upstream === null) {
  console.log(`  skipped: dsh-memento not found at ${MEMENTO_SOURCE} (set DSH_MEMENTO_SOURCE to pin)`)
} else {
  check('EXPORT_SCHEMA matches upstream', () => {
    assert.equal(EXPORT_SCHEMA, upstream.constants.EXPORT_SCHEMA)
  })

  check('MAX_IMPORT_ENTRIES matches upstream', () => {
    assert.equal(MAX_IMPORT_ENTRIES, upstream.constants.MAX_IMPORT_ENTRIES)
  })

  check('MAX_MERGE_MATCHES matches upstream MAX_CONSOLIDATE_MATCHES', () => {
    assert.equal(MAX_MERGE_MATCHES, upstream.constants.MAX_CONSOLIDATE_MATCHES)
  })

  check('EXPORT_PLUGIN is the plugin id upstream demands', () => {
    assert.equal(EXPORT_PLUGIN, 'dsh-memento')
  })

  check('a filled export envelope passes upstream validateExportEnvelope', () => {
    const now = Date.now()
    const envelope = exportEnvelope([
      {
        id: '5f1a3f0e-7c2b-4d9a-8b1e-2f3c4d5e6a7b',
        track: 'user',
        scope: 'workspace',
        workspaceKey: '/w',
        agentKey: '',
        text: 'hello',
        source: 'memory',
        tags: ['a'],
        version: 1,
        createdAt: now,
        updatedAt: now,
        lastRecalled: null,
        recallCount: 0,
        sessionId: null,
      },
    ], [{ track: 'user', scope: 'workspace', used: 5, limit: 2000 }])
    const parsed = upstream.root.validateExportEnvelope(envelope)
    assert.equal(parsed.plugin, EXPORT_PLUGIN)
    assert.equal(parsed.schema, EXPORT_SCHEMA)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].text, 'hello')
  })

  check('an entry that never carried a sessionId still exports as null', () => {
    const now = Date.now()
    const [entry] = exportEnvelope([{ id: '5f1a3f0e-7c2b-4d9a-8b1e-2f3c4d5e6a7b', track: 'user', scope: 'workspace', workspaceKey: '/w', agentKey: '', text: 'x', source: 'memory', tags: [], version: 1, createdAt: now, updatedAt: now, lastRecalled: null, recallCount: 0 }], []).entries
    assert.equal(entry.sessionId, null, 'the validator requires the key, so it is never simply absent')
  })

  check('an empty export envelope is still a valid document', () => {
    const parsed = upstream.root.validateExportEnvelope(exportEnvelope([], []))
    assert.deepEqual(parsed.entries, [])
  })

  check('the upstream validator rejects what our importer also refuses', () => {
    // Same shape the tab's `envelopeEntries` rejects, seen from the other side:
    // if these two ever disagree, a file could be exportable but not importable.
    assert.throws(() => upstream.root.validateExportEnvelope({ plugin: 'dsh-memento', schema: 'memory-export-v1', exportedAt: 'x', budgets: [], entries: [] }))
    assert.throws(() => upstream.root.validateExportEnvelope({ plugin: 'dsh-memento', schema: 'memory-export-v1', exportedAt: new Date().toISOString(), budgets: [], entries: [{ track: 'user', scope: 'workspace' }] }))
  })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
