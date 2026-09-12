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

/** A memory seam stub shaped like the real one. */
function fakeMemory() {
  return {
    language: 'zh',
    query: () => ({ entries: [{ id: 'e1', track: 'user', scope: 'workspace', text: 'hi', workspaceKey: '/w', agentKey: '', tags: [] }], total: 1, truncated: false }),
    budgets: () => [{ track: 'user', scope: 'workspace', used: 2, limit: 2000 }],
    store: { auditList: () => [{ ts: Date.now(), action: 'snapshot', outcome: 'ok' }], proposalList: () => [] },
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
 * @returns {any} a request-shaped object.
 */
function fakeRequest(url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

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

await check('activates and registers all three routes when a web server exists', async () => {
  const ctx = new Context()
  ctx.provide('memory', fakeMemory())
  ctx.provide('approval', fakeApproval())
  const routes = new Map()
  ctx.provide('webServer', fakeWebServer(routes))
  await ctx.plugin(PLUGIN)
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/memento-tab/decide',
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
  assert.equal(routes.size, 3, 'routes should register once the service is announced')
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
    fakeRequest('/api/memento-tab/write', { op: 'add', track: 'user', scope: 'workspace', text: 'x' }),
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
    fakeRequest('/api/memento-tab/write', { op: 'add', track: 'nope', scope: 'workspace', text: 'x', sessionId: 's1' }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'INVALID_INPUT')
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
