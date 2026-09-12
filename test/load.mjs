/**
 * dsh-memento-tab — loader-contract test.
 *
 * This exists because of a real outage: the first version read `ctx.webServer`
 * while `webServer` was not in `inject`, and Cordis throws on that property
 * access. A plugin's `apply` throwing fails the ENTIRE loader tree, so dsh
 * would not boot at all. A `try/catch` around the property access cannot help —
 * the access is the throw.
 *
 * The test boots a real Cordis context (the harness's own vendored copy) and
 * loads the plugin into it, so the exact failure mode above is covered:
 *
 *   1. with a web server  → the three routes register;
 *   2. without one        → the plugin still activates and registers nothing;
 *   3. appearing later    → the plugin picks it up from `internal/service`.
 *
 * It also drives the state route and a rejected write through the real
 * handlers, so the read/write plumbing is exercised rather than assumed.
 *
 * Run with `node test/load.mjs` (or `npm run test:load`).
 * Set `DSH_SOURCE` to the checkout root when it is not the default.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_SOURCE = process.env.DSH_SOURCE ?? '/Users/inxups/project/deepseek-harness'
const PLUGIN = await import('../index.mjs')

/**
 * Resolve a real Cordis `Context`, or report that the test cannot run here.
 * @returns {Promise<any | null>} the Context class, or null when unavailable.
 */
async function loadContext() {
  const candidates = [
    pathToFileURL(join(DSH_SOURCE, 'vendor/cordis/lib/index.js')).href,
    '@deepseek-ai/cordis',
  ]
  for (const specifier of candidates) {
    try {
      const module = await import(specifier)
      if (typeof module.Context === 'function') return module.Context
    } catch {
      // try the next candidate
    }
  }
  return null
}

const Context = await loadContext()
if (Context === null) {
  console.log(`skipped: no Cordis Context reachable (looked in ${DSH_SOURCE}/vendor/cordis and @deepseek-ai/cordis)`)
  process.exit(0)
}

/**
 * A memory seam stub shaped like the real one.
 * @param {{entries?: Array<Record<string, unknown>>, seed?: (inputs: any[]) => any, noLedger?: boolean}} [options] - knobs.
 * @returns {any} a ctx.memory stand-in.
 */
function fakeMemory(options = {}) {
  const entries = options.entries ?? [{ id: 'e1', track: 'user', scope: 'workspace', text: 'hi', workspaceKey: '/w', agentKey: '', tags: [] }]
  const store = {
    auditList: () => [{ ts: Date.now(), action: 'snapshot', outcome: 'ok' }],
    proposalList: () => [],
  }
  if (options.noLedger !== true) store.listEntries = () => entries
  return {
    language: 'zh',
    // Upstream's `query()` is implemented over a store read that increments every
    // returned row's recall_count, so the tab is expected not to call it at all.
    // Recording the calls is how the read path is held to that.
    queryCalls: [],
    query(filter) {
      this.queryCalls.push(filter)
      return { entries: [entries[0]], total: entries.length, truncated: false }
    },
    budgets: () => [{ track: 'user', scope: 'workspace', used: 2, limit: 2000 }],
    // The seam's write path: tests replace `seed` when they need to inspect what
    // the route handed over, or to simulate a domain error (budget, gate).
    seed: options.seed ?? (async (inputs) => ({ added: inputs.length, entries: inputs })),
    store,
  }
}

/**
 * An adapter registry stub, shaped like dsh-memory-protocol's registry.
 * @returns {any} a ctx.memoryAdapters stand-in.
 */
function fakeAdapters() {
  /** @param {string} id - requested adapter id. */
  const missing = (id) => {
    const error = new Error(`no memory adapter registered with id ${JSON.stringify(id)}; check /memory adapters for the registered list`)
    error.code = 'ADAPTER_NOT_FOUND'
    error.details = { adapterId: id }
    return error
  }
  return {
    list: () => [
      {
        id: 'mem0-facts',
        name: 'mem0 facts',
        description: 'mem0 fact list adapter',
        version: '1.0.0',
        importFormats: ['mem0-facts'],
        exportFormat: 'mem0-facts',
      },
      {
        id: 'md-doc',
        name: 'markdown document',
        description: 'bullet markdown adapter',
        version: '1.0.0',
        importFormats: ['md-doc'],
        exportFormat: 'md-doc',
      },
    ],
    adapt: (id, payload) => {
      // Deliberately takes a raw string only, so the route's JSON-parse-then-fall-
      // back-to-text branch is exercised the way a markdown adapter exercises it.
      if (id === 'md-doc') {
        if (typeof payload !== 'string') {
          const error = new Error('md-doc takes markdown text')
          error.code = 'ADAPTER_PAYLOAD'
          throw error
        }
        return {
          entries: payload.split('\n').filter((line) => line.trim().length > 0)
            .map((line) => ({ track: 'user', scope: 'workspace', text: line.replace(/^-\s*/, '') })),
        }
      }
      if (id !== 'mem0-facts') throw missing(id)
      const facts = Array.isArray(payload) ? payload : (payload?.facts ?? [])
      return { entries: facts.map((fact) => ({ track: 'user', scope: 'user-global', text: String(fact.memory ?? fact) })) }
    },
    export: (id, entries) => {
      if (id === 'md-doc') return { plugin: 'md-doc', text: entries.map((entry) => `- ${entry.text}`).join('\n') }
      if (id !== 'mem0-facts') throw missing(id)
      return { plugin: 'mem0', facts: entries.map((entry) => ({ memory: entry.text })) }
    },
  }
}

/** A minimal approval seam stub. */
function fakeApproval() {
  return { config: { policy: 'ask' } }
}

/** A web-server stub recording registered routes. */
function fakeWebServer(routes) {
  return {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/**
 * Build an async-iterable request carrying an optional JSON body.
 * @param {string} url - request URL.
 * @param {unknown} [body] - JSON body to emit.
 * @param {Record<string, string>} [headers] - request headers.
 * @returns {any} a request-shaped object.
 */
function fakeRequest(url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** Headers every write from the tab carries. */
const TAB_HEADERS = { 'x-memento-tab': '1' }

/** A response stub capturing status, headers and body. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { this.body = chunk ?? '' },
    json() { return JSON.parse(this.body) },
  }
}

/**
 * Boot the plugin into a fresh context that has every service it reaches for.
 * @param {{memory?: any, adapters?: any}} [options] - service overrides.
 * @returns {Promise<{ctx: any, routes: Map<string, any>}>} context plus its routes.
 */
async function boot(options = {}) {
  const ctx = new Context()
  ctx.provide('memory', options.memory ?? fakeMemory())
  ctx.provide('approval', fakeApproval())
  if (options.adapters !== undefined) ctx.provide('memoryAdapters', options.adapters)
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  return { ctx, routes }
}

/**
 * Drive one registered route and collect its response.
 * @param {Map<string, any>} routes - registered routes.
 * @param {string} path - route path.
 * @param {any} req - request to send.
 * @returns {Promise<any>} the response stub.
 */
async function hit(routes, path, req) {
  const res = fakeResponse()
  await routes.get(path).handler(req, res)
  return res
}

let failures = 0

/**
 * Run one assertion, reporting instead of throwing.
 * @param {string} label - case name.
 * @param {() => Promise<void> | void} body - assertions.
 */
async function check(label, body) {
  try {
    await body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('loader contract')

await check('activates and registers all five routes when a web server exists', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/memento-tab/decide',
    '/api/memento-tab/export',
    '/api/memento-tab/import',
    '/api/memento-tab/state',
    '/api/memento-tab/write',
  ])
})

await check('activates without throwing when no web server exists', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  // The pre-fix version threw here, which failed the whole loader tree.
  await ctx.plugin(PLUGIN)
})

await check('picks the web server up when it appears after activation', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  await ctx.plugin(PLUGIN)
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  ctx.emit('internal/service', 'webServer')
  assert.equal(routes.size, 5, 'routes should register once the service is announced')
})

console.log('route behaviour')

await check('state route answers with the read model', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  const res = fakeResponse()
  await routes.get('/api/memento-tab/state').handler(fakeRequest('/api/memento-tab/state?cwd=/w'), res)
  const body = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, true)
  assert.equal(body.entries.length, 1)
  assert.equal(body.budgets.length, 1)
  assert.equal(body.auditAvailable, true)
  assert.equal(body.proposalsAvailable, true)
  assert.equal(body.focus.workspaceKey, '/w')
  assert.equal(body.exportAvailable, true)
  assert.equal(body.adaptersAvailable, false, 'no registry mounted is reported, never thrown')
  assert.equal(body.maxImportEntries, PLUGIN.MAX_IMPORT_ENTRIES)
})

console.log('read path: viewing the tab must not count as recall')

await check('state reads the store directly instead of the counting seam', async () => {
  const memory = fakeMemory({ entries: [
    { id: 'e1', track: 'user', scope: 'workspace', text: 'alpha one', workspaceKey: '/w', agentKey: '' },
    { id: 'e2', track: 'user', scope: 'workspace', text: 'beta two', workspaceKey: '/w', agentKey: '' },
  ] })
  const { routes } = await boot({ memory })
  const body = (await hit(routes, '/api/memento-tab/state', fakeRequest('/api/memento-tab/state'))).json()
  assert.equal(body.entries.length, 2, 'listEntries sees the whole store, not just query()\'s first row')
  assert.equal(memory.queryCalls.length, 0, 'memory.query() increments recall_count on every row it returns')
})

await check('state filters track/scope/text the way the store does, newest first', async () => {
  const memory = fakeMemory({ entries: [
    { id: 'e1', track: 'user', scope: 'workspace', text: 'alpha one' },
    { id: 'e2', track: 'agent', scope: 'workspace', text: 'ALPHA two' },
    { id: 'e3', track: 'user', scope: 'user-global', text: 'beta' },
  ] })
  const { routes } = await boot({ memory })
  const state = async (query) => (await hit(routes, '/api/memento-tab/state', fakeRequest(`/api/memento-tab/state${query}`))).json()

  const byText = await state('?text=alpha')
  assert.deepEqual(byText.entries.map((entry) => entry.id), ['e2', 'e1'], 'case-insensitive substring, newest first')
  assert.equal(byText.total, 2)
  assert.equal(byText.truncated, false)

  const byLayer = await state('?track=user&scope=user-global')
  assert.deepEqual(byLayer.entries.map((entry) => entry.id), ['e3'])

  const capped = await state('?limit=1')
  assert.equal(capped.entries.length, 1)
  assert.equal(capped.total, 3, 'total counts matches before the limit')
  assert.equal(capped.truncated, true)
  assert.equal(memory.queryCalls.length, 0, 'every filtered read stays off the counting seam')
})

await check('state falls back to the seam when the store accessor is gone', async () => {
  const memory = fakeMemory({ noLedger: true })
  const { routes } = await boot({ memory })
  const body = (await hit(routes, '/api/memento-tab/state', fakeRequest('/api/memento-tab/state'))).json()
  assert.equal(body.entries.length, 1)
  assert.equal(memory.queryCalls.length, 1, 'degraded, but the tab still renders')
})

await check('write route rejects a body with no sessionId', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  const res = fakeResponse()
  await routes.get('/api/memento-tab/write').handler(
    fakeRequest('/api/memento-tab/write', { op: 'add', track: 'user', scope: 'workspace', text: 'x' }, TAB_HEADERS),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'NO_SESSION')
})

await check('write route rejects an unknown track before touching the seam', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  const res = fakeResponse()
  await routes.get('/api/memento-tab/write').handler(
    fakeRequest('/api/memento-tab/write', { op: 'add', track: 'nope', scope: 'workspace', text: 'x', sessionId: 's1' }, TAB_HEADERS),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'INVALID_INPUT')
})

console.log('write authorisation')

await check('write route refuses a request without the tab header', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  const res = fakeResponse()
  await routes.get('/api/memento-tab/write').handler(
    fakeRequest('/api/memento-tab/write', { op: 'add', track: 'user', scope: 'workspace', text: 'x', sessionId: 's1' }),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'MISSING_TAB_HEADER')
})

await check('decide route refuses a request without the tab header', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  const res = fakeResponse()
  await routes.get('/api/memento-tab/decide').handler(
    fakeRequest('/api/memento-tab/decide', { id: 'p1', decision: 'dismiss', sessionId: 's1' }),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'MISSING_TAB_HEADER')
})

console.log('data routes: export')

/** A well-formed export envelope carrying the given entries. */
function envelope(entries) {
  return JSON.stringify({ plugin: 'dsh-memento', schema: PLUGIN.EXPORT_SCHEMA, exportedAt: new Date().toISOString(), entries })
}

await check('state reports the adapter registry when one is mounted', async () => {
  const { routes } = await boot({ adapters: fakeAdapters() })
  const body = (await hit(routes, '/api/memento-tab/state', fakeRequest('/api/memento-tab/state'))).json()
  assert.equal(body.adaptersAvailable, true)
  assert.equal(body.adapters.length, 2)
  assert.equal(body.adapters[0].id, 'mem0-facts')
})

await check('export envelope carries the upstream schema and every entry', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/export', fakeRequest('/api/memento-tab/export', undefined, TAB_HEADERS))
  const body = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(body.format, PLUGIN.EXPORT_SCHEMA)
  assert.match(body.filename, /^dsh-memento-export-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
  assert.equal(body.count, 1)
  const parsed = JSON.parse(body.text)
  assert.equal(parsed.plugin, PLUGIN.EXPORT_PLUGIN)
  assert.equal(parsed.schema, PLUGIN.EXPORT_SCHEMA)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].text, 'hi')
})

await check('export through an adapter returns that adapter format', async () => {
  const { routes } = await boot({ adapters: fakeAdapters() })
  const res = await hit(routes, '/api/memento-tab/export', fakeRequest('/api/memento-tab/export?adapterId=mem0-facts', undefined, TAB_HEADERS))
  const body = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(body.adapterId, 'mem0-facts')
  assert.equal(body.format, 'mem0-facts')
  assert.match(body.filename, /-mem0-facts-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
  assert.equal(JSON.parse(body.text).plugin, 'mem0')
})

await check('export of an unknown adapter is a 404 carrying its details', async () => {
  const { routes } = await boot({ adapters: fakeAdapters() })
  const res = await hit(routes, '/api/memento-tab/export', fakeRequest('/api/memento-tab/export?adapterId=nope', undefined, TAB_HEADERS))
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'ADAPTER_NOT_FOUND')
  assert.equal(res.json().adapterId, 'nope')
})

await check('export without an entry ledger is a 501, not a crash', async () => {
  const { routes } = await boot({ memory: fakeMemory({ noLedger: true }) })
  const res = await hit(routes, '/api/memento-tab/export', fakeRequest('/api/memento-tab/export', undefined, TAB_HEADERS))
  assert.equal(res.statusCode, 501)
  assert.equal(res.json().code, 'LEDGER_UNAVAILABLE')
})

await check('export refuses a request without the tab header', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/export', fakeRequest('/api/memento-tab/export'))
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'MISSING_TAB_HEADER')
})

console.log('data routes: import')

/** Boot with a seam that records the exact batch the route handed to `seed`. */
async function bootRecording(seed) {
  const seen = []
  const booted = await boot({
    memory: fakeMemory({ seed: async (inputs) => { seen.push(...inputs); return seed(inputs) } }),
  })
  return { seen, routes: booted.routes }
}

await check('import of a memento envelope seeds every entry', async () => {
  const { seen, routes } = await bootRecording(async (inputs) => ({ added: inputs.length }))
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: envelope([
      { track: 'user', scope: 'workspace', text: 'a', workspaceKey: '/w1' },
      { track: 'agent', scope: 'user-global', text: 'b', source: 'mem0' },
    ]),
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().added, 2)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].workspaceKey, '/w1', 'the file layer key is preserved by default')
  assert.equal(seen[1].source, 'mem0')
})

await check('import with overrideKeys re-homes the batch to this session', async () => {
  const { seen, routes } = await bootRecording(async (inputs) => ({ added: inputs.length }))
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: envelope([{ track: 'user', scope: 'workspace', text: 'a', workspaceKey: '/w1', agentKey: 'old' }]),
    sessionId: 's1',
    overrideKeys: true,
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 200)
  assert.equal(seen[0].workspaceKey, undefined)
  assert.equal(seen[0].agentKey, undefined)
})

await check('import rejects a foreign envelope', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: '{"plugin":"other","schema":"memory-export-v1","entries":[]}',
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'IMPORT_BAD_SCHEMA')
})

await check('import rejects an entry missing track/scope/text', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: envelope([{ track: 'user', scope: 'workspace' }]),
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'IMPORT_BAD_ENTRY')
})

await check('import refuses a batch over the upstream entry ceiling', async () => {
  const rows = Array.from({ length: PLUGIN.MAX_IMPORT_ENTRIES + 1 }, (_, index) => ({ track: 'user', scope: 'workspace', text: `t${index}` }))
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', { payload: envelope(rows), sessionId: 's1' }, TAB_HEADERS))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'INVALID_INPUT')
})

await check('import through a JSON adapter converts the payload', async () => {
  const seen = []
  const { routes } = await boot({
    adapters: fakeAdapters(),
    memory: fakeMemory({ seed: async (inputs) => { seen.push(...inputs); return { added: inputs.length } } }),
  })
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: JSON.stringify({ facts: [{ memory: 'from mem0' }] }),
    adapterId: 'mem0-facts',
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().added, 1)
  assert.equal(seen[0].text, 'from mem0')
  assert.equal(seen[0].scope, 'user-global')
})

await check('import through a markdown adapter accepts raw text', async () => {
  const seen = []
  const { routes } = await boot({
    adapters: fakeAdapters(),
    memory: fakeMemory({ seed: async (inputs) => { seen.push(...inputs); return { added: inputs.length } } }),
  })
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: '- one\n- two',
    adapterId: 'md-doc',
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 200, 'a payload that is not JSON must reach the adapter as text')
  assert.equal(res.json().added, 2)
  assert.equal(seen[1].text, 'two')
})

await check('import of an unknown adapter is a 404', async () => {
  const { routes } = await boot({ adapters: fakeAdapters() })
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: 'x',
    adapterId: 'nope',
    sessionId: 's1',
  }, TAB_HEADERS))
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'ADAPTER_NOT_FOUND')
})

await check('import surfaces a budget rejection with its details', async () => {
  const budget = new Error('memory budget exceeded: user/workspace at 1900/2000 chars, this write needs 300 chars; consolidate or remove entries, then retry')
  budget.code = 'BUDGET_EXCEEDED'
  budget.details = { track: 'user', scope: 'workspace', used: 1900, limit: 2000, needed: 300 }
  const { routes } = await boot({ memory: fakeMemory({ seed: async () => { throw budget } }) })
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', {
    payload: envelope([{ track: 'user', scope: 'workspace', text: 'x' }]),
    sessionId: 's1',
  }, TAB_HEADERS))
  const body = res.json()
  assert.equal(res.statusCode, 400)
  assert.equal(body.code, 'BUDGET_EXCEEDED')
  assert.equal(body.limit, 2000, 'the overage facts ride along so the tab can show them')
})

await check('import refuses a request with no sessionId before any write', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', { payload: envelope([{ track: 'user', scope: 'workspace', text: 'x' }]) }, TAB_HEADERS))
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'NO_SESSION')
})

await check('import refuses a request without the tab header', async () => {
  const { routes } = await boot()
  const res = await hit(routes, '/api/memento-tab/import', fakeRequest('/api/memento-tab/import', { payload: envelope([{ track: 'user', scope: 'workspace', text: 'x' }]), sessionId: 's1' }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'MISSING_TAB_HEADER')
})

console.log('approval composition')

/**
 * Compose this plugin's answerer with a stand-in for dsh-memento's prepended
 * one, then run one request through the real waterfall.
 * @param {{policy: 'ask'|'off'|'auto'}} upstream - what the stand-in decides.
 * @param {Record<string, unknown>} request - approval request to send.
 * @returns {Promise<string>} the winning outcome.
 */
async function runApproval(upstream, request) {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  PLUGIN.installTabAnswerer(ctx)
  // Upstream's answerer is PREPENDED and owns the hard decisions: `off` rejects
  // without consulting anything downstream, `ask` delegates onward.
  ctx.on('approval/request', async (req, next) => (upstream.policy === 'off' ? 'rejected' : next()), { prepend: true })
  return ctx.waterfall('approval/request', request, async () => 'unavailable')
}

await check('a tab write is allowed when upstream would have asked', async () => {
  const outcome = await runApproval({ policy: 'ask' }, {
    toolName: 'memory',
    reason: '[dsh-memento] add user/workspace\nx',
    [PLUGIN.TAB_REQUEST_FIELD]: true,
  })
  assert.equal(outcome, 'allowed-once')
})

await check('writePolicy off still wins over the tab answerer', async () => {
  const outcome = await runApproval({ policy: 'off' }, {
    toolName: 'memory',
    reason: '[dsh-memento] add user/workspace\nx',
    [PLUGIN.TAB_REQUEST_FIELD]: true,
  })
  assert.equal(outcome, 'rejected')
})

await check('a write without the tab marker still stops at the human-facing step', async () => {
  const outcome = await runApproval({ policy: 'ask' }, {
    toolName: 'memory',
    reason: '[dsh-memento] add user/workspace\nx',
  })
  assert.equal(outcome, 'unavailable', 'model-initiated writes must keep their approval')
})

await check('the tab marker predicate rejects foreign and malformed requests', () => {
  assert.equal(PLUGIN.isTabWriteRequest(null), false)
  assert.equal(PLUGIN.isTabWriteRequest('x'), false)
  assert.equal(PLUGIN.isTabWriteRequest({ toolName: 'memory' }), false)
  assert.equal(PLUGIN.isTabWriteRequest({ [PLUGIN.TAB_REQUEST_FIELD]: false }), false)
  assert.equal(PLUGIN.isTabWriteRequest({ [PLUGIN.TAB_REQUEST_FIELD]: true }), true)
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
