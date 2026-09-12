/**
 * dsh-memento-tab — host half.
 *
 * A companion to `dsh-memento`, deliberately *not* a fork of it. This half owns
 * three JSON routes on the composition's `webServer` and delegates every read
 * and every write to the public `ctx.memory` seam. Nothing here imports a
 * private module from the upstream package, so an upstream release can only
 * break this plugin by changing its published seam — never by refactoring
 * internals.
 *
 * ## The approval gate: composed, not removed
 *
 * Writes carry no privileged path. Each one asks `approval/request` exactly the
 * way the upstream `/memory` command does, so memento's prepended answerer
 * resolves the policy for the request FIRST:
 *
 *   - `writePolicy: off`  → rejected, and the rejection is audited. A hard switch.
 *   - `writePolicies` per `track/scope` → likewise decides before this plugin
 *     ever sees the request.
 *   - `writePolicy: auto` → allowed, with the `approval/asked` +
 *     `approval/decided` audit pair.
 *   - `writePolicy: ask`  → would fall through to the DSH approval UI. For a
 *     write this tab initiated, {@link installTabAnswerer} answers instead:
 *     the person who clicked Save IS the approver, so asking them to approve
 *     their own click is a second confirmation, not a safety property. The
 *     request never reaches the human-facing answerer.
 *
 * Model-initiated writes are untouched: they carry no tab marker and still stop
 * at the approval UI. A session-level `never` posture is honoured before the
 * waterfall is entered at all, because the approval service sits behind the
 * fallback this plugin supplies and would otherwise never run.
 *
 * ## The one deliberate coupling
 *
 * An approval `reason` must start with memento's request marker, because that
 * string is how the upstream answerer claims a write. The format is mirrored in
 * {@link writeReason} and asserted by the repo's smoke test; it is the only
 * piece of upstream knowledge duplicated here, and it is a documented protocol
 * constant rather than an internal. The tab's own marker cannot live in the
 * reason (upstream parses it byte-for-byte), so it rides a separate field on the
 * approval request object.
 *
 * @module dsh-memento-tab
 */

import path from 'node:path'

/** Cordis plugin name; also the bundle row id and the client graph id. */
export const name = 'dsh-memento-tab'

/**
 * Hard dependency on the memory seam. Without it this plugin has nothing to
 * show, so it simply never activates rather than half-working.
 *
 * `approval` is a hard dependency too: the seam's write methods are useless
 * without a gate to ask, and Cordis THROWS on `ctx.<name>` when `<name>` was
 * not injected.
 *
 * `webServer` is deliberately absent. This plugin is useful in any composition
 * that has memory, and one without a web server should still activate with no
 * data routes. {@link withService} waits for it instead — the only way to reach
 * a service without declaring it.
 */
export const inject = ['memory', 'approval']

/** Approval-reason marker claimed by dsh-memento's answerer. */
const REQUEST_MARKER = '[dsh-memento]'

/** The approval tool name memento stamps on its write requests. */
const APPROVAL_TOOL_NAME = 'memory'

/**
 * Field this plugin stamps on an approval request it raised from the tab UI.
 *
 * It cannot ride the `reason`: memento parses that string byte-for-byte. Unknown
 * fields on the request object are ignored by upstream and by the approval
 * service, so a private key is the safe carrier.
 */
export const TAB_REQUEST_FIELD = 'mementoTabInitiated'

/** Header a write must carry, so a random web page cannot drive the route. */
const TAB_HEADER = 'x-memento-tab'

/** The only accepted value of {@link TAB_HEADER}. */
const TAB_HEADER_VALUE = '1'

const TRACKS = /** @type {const} */ (['user', 'agent'])
const SCOPES = /** @type {const} */ (['user-global', 'workspace'])

const ROUTE_STATE = '/api/memento-tab/state'
const ROUTE_WRITE = '/api/memento-tab/write'
const ROUTE_DECIDE = '/api/memento-tab/decide'

/** Request bodies are tiny JSON documents; cap them rather than trusting a peer. */
const MAX_BODY_BYTES = 512 * 1024
const DEFAULT_ENTRY_LIMIT = 500
const MAX_ENTRY_LIMIT = 2000
const DEFAULT_AUDIT_LIMIT = 60
const MAX_AUDIT_LIMIT = 200
const MAX_PROPOSALS = 50

/** One HTTP-shaped failure carrying the status the route should answer with. */
class RouteError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} message - human-readable reason.
   * @param {string} [code] - stable machine code for the client to branch on.
   */
  constructor(status, message, code) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    if (code !== undefined) this.code = code
  }
}

/**
 * Serialize one JSON response and end it.
 * @param {import('node:http').ServerResponse} res - response to own.
 * @param {number} status - HTTP status code.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - request to drain.
 * @returns {Promise<Record<string, unknown>>} parsed object (empty for an empty body).
 * @throws {RouteError} when the body is oversized or not a JSON object.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RouteError(413, 'request body too large', 'BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RouteError(400, 'request body is not valid JSON', 'BAD_JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouteError(400, 'request body must be a JSON object', 'BAD_JSON')
  }
  return parsed
}

/**
 * Build the approval `reason` for one write payload.
 *
 * Mirrors dsh-memento's `buildWriteReason` exactly. The upstream parser is
 * `/^\[dsh-memento\] ([a-z]+)(?: \((\d+) entries\))? ([a-z]+)\/([a-z-]+)(?: \[source:([^\]]+)\])?\n([\s\S]*)$/`,
 * so the marker, the single space, the `track/scope` pair and the newline
 * before the text are all load-bearing.
 * @param {{action: string, track: string, scope: string, text: string, count?: number, source?: string}} payload - write payload.
 * @returns {string} approval reason carrying the marker and the full text.
 */
export function writeReason({ action, track, scope, text, count, source }) {
  const batch = count === undefined ? '' : ` (${count} entries)`
  const sourceTag = source === undefined ? '' : ` [source:${source}]`
  return `${REQUEST_MARKER} ${action}${batch} ${track}/${scope}${sourceTag}\n${text}`
}

/**
 * Canonicalize a session cwd into the workspace key dsh-memento uses.
 *
 * Reimplemented from upstream's `lib/workspace.mjs` (12 lines) rather than
 * imported, so this package depends on no subpath export. The rule is stable:
 * absolute-resolve, lowercase on Windows only, empty for a missing cwd.
 * @param {string | undefined} cwd - session cwd.
 * @returns {string} workspace key.
 */
export function workspaceKeyOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const resolved = path.resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Canonicalize a session's agent preset into the agent key dsh-memento uses.
 * @param {string | undefined} agentPreset - session header agent preset.
 * @returns {string} agent key ('' = the shared layer).
 */
export function agentKeyOf(agentPreset) {
  if (typeof agentPreset !== 'string' || agentPreset.length === 0) return ''
  const trimmed = agentPreset.trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Turn one client-supplied anchor into the write context dsh-memento expects.
 *
 * The anchor is `{sessionId, cwd, agentPreset}`: the browser reads `cwd` and
 * `agentPreset` off the live Session header it is already rendering, which is
 * the same source memento's own tool and command paths read. The values are
 * convenience scoping, not a security boundary — every write still rides the
 * approval gate and lands an audit row naming the session.
 * @param {Record<string, unknown>} body - parsed request body.
 * @returns {{agent: {session: {id: string, header: Record<string, string>}}}} write context (gate added per request).
 * @throws {RouteError} when `sessionId` is missing.
 */
function sessionAnchor(body) {
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new RouteError(400, 'sessionId is required', 'NO_SESSION')
  }
  /** @type {Record<string, string>} */
  const header = {}
  if (typeof body.cwd === 'string' && body.cwd.length > 0) header.cwd = body.cwd
  if (typeof body.agentPreset === 'string' && body.agentPreset.length > 0) header.agentPreset = body.agentPreset
  return { agent: { session: { id: sessionId, header } } }
}

/**
 * Ask the approval seam for one write.
 *
 * This is the turn-external transport: `ctx.memory`'s write methods would
 * otherwise use the turn-scoped gate, which has no in-flight tool call to hang
 * an approval on outside a model turn. Asking `approval/request` directly keeps
 * memento's prepended answerer in the chain, so write policies still govern the
 * request — this gate only replaces the FALLBACK (the human-facing answerer),
 * never the policy decision ahead of it.
 *
 * The supplied fallback is `unavailable`, i.e. fail closed, so a request nobody
 * claims is denied rather than silently allowed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{action: string, track: string, scope: string, text: string, count?: number, source?: string}} payload - write payload.
 * @param {{agent?: unknown}} write - write context carrying the session.
 * @returns {Promise<string>} approval outcome (`allowed-once`, `rejected`, `unavailable`, …).
 */
async function routeGate(ctx, payload, write) {
  const approval = ctx.approval
  const session = /** @type {{session?: unknown} | undefined} */ (write?.agent)?.session
  // Honour a session-level `never` posture before asking: the approval service
  // decides it ahead of every answerer, but it sits BEHIND the fallback below,
  // so it would never run. Short-circuiting here reproduces its outcome.
  const override = typeof approval?.overrideOf === 'function' && session !== undefined
    ? approval.overrideOf(session)
    : undefined
  const effective = override ?? approval?.config?.policy ?? 'ask'
  if (effective === 'never') return 'rejected'
  return ctx.waterfall('approval/request', {
    agent: write.agent,
    toolName: APPROVAL_TOOL_NAME,
    reason: writeReason(payload),
    [TAB_REQUEST_FIELD]: true,
  }, async () => 'unavailable')
}

/**
 * Whether one approval request was raised by this tab's own UI.
 * @param {unknown} req - approval request shape.
 * @returns {boolean} true when this plugin stamped its tab marker.
 */
export function isTabWriteRequest(req) {
  return req !== null && typeof req === 'object'
    && /** @type {Record<string, unknown>} */ (req)[TAB_REQUEST_FIELD] === true
}

/**
 * Answer approvals raised by this tab with `allowed-once`.
 *
 * Registered WITHOUT `prepend`, so memento's prepended answerer runs first and
 * keeps every hard decision: `writePolicy: off` and a `writePolicies` row for
 * the request's `track/scope` both resolve to `rejected` before this handler is
 * reached. What this handler replaces is only the last step — the human-facing
 * question — for writes whose approver is the person who just clicked Save.
 *
 * Requests without the tab marker fall through untouched, so the model's
 * `memory` tool and the `/memory` command keep their own approval behaviour.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function installTabAnswerer(ctx) {
  ctx.on('approval/request', async (/** @type {unknown} */ req, /** @type {() => Promise<string>} */ next) => {
    if (!isTabWriteRequest(req)) return next()
    return 'allowed-once'
  })
}

/**
 * Refuse a write whose request did not come from this plugin's own client.
 *
 * Every plugin route on the loopback server is unauthenticated, and a write here
 * is auto-allowed — so a drive-by web page must not be able to reach it. A
 * custom request header is the cheap defence: a cross-origin fetch cannot set
 * one without a CORS preflight this server does not satisfy. It does NOT stop a
 * local process that forges the header; nothing on this server does.
 * @param {import('node:http').IncomingMessage} req - request to inspect.
 * @throws {RouteError} when the header is absent.
 */
function requireTabHeader(req) {
  if (req.headers?.[TAB_HEADER] !== TAB_HEADER_VALUE) {
    throw new RouteError(403, `missing ${TAB_HEADER}: ${TAB_HEADER_VALUE}`, 'MISSING_TAB_HEADER')
  }
}

/**
 * Read the upstream provider ledger through one feature-detected accessor.
 *
 * `auditList` / `proposalList` / `proposalDecide` live on the provider handle
 * rather than on the typed seam, so they are called defensively: a future
 * upstream that renames them degrades the audit tail and the proposal panel to
 * "unavailable" instead of failing the whole tab.
 * @param {unknown} memory - the ctx.memory service.
 * @returns {Record<string, Function> | null} ledger handle when it looks usable.
 */
function ledgerOf(memory) {
  const store = /** @type {{store?: unknown}} */ (memory)?.store
  if (store === null || typeof store !== 'object') return null
  const candidate = /** @type {Record<string, unknown>} */ (store)
  if (typeof candidate.auditList !== 'function' || typeof candidate.proposalList !== 'function') return null
  return /** @type {Record<string, Function>} */ (candidate)
}

/**
 * Split one `track` value, rejecting anything outside the vocabulary.
 * @param {unknown} value - raw value.
 * @param {readonly string[]} allowed - permitted values.
 * @param {string} field - field name for the error message.
 * @returns {string} the validated value.
 * @throws {RouteError} when the value is not permitted.
 */
function requireEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new RouteError(400, `${field} must be one of ${allowed.join('|')}`, 'INVALID_INPUT')
  }
  return value
}

/**
 * Clamp an optional integer query parameter.
 * @param {string | null} raw - raw query value.
 * @param {number} fallback - value used when absent or unusable.
 * @param {number} max - hard ceiling.
 * @returns {number} the clamped limit.
 */
function clampLimit(raw, fallback, max) {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, max)
}

/**
 * Project one thrown error into the response body the client branches on.
 *
 * dsh-memento's domain errors carry a stable `.code` (`BUDGET_EXCEEDED`,
 * `AMBIGUOUS_MATCH`, `ENTRY_NOT_FOUND`, `WRITE_DENIED`, …); those surface
 * verbatim so the tab can offer "consolidate and retry" instead of a wall of
 * text.
 * @param {unknown} error - thrown value.
 * @returns {{status: number, payload: Record<string, unknown>}} status plus body.
 */
function errorResponse(error) {
  if (error instanceof RouteError) {
    return {
      status: error.status,
      payload: { ok: false, code: error.code ?? 'ROUTE_ERROR', error: error.message },
    }
  }
  const code = typeof (/** @type {{code?: unknown}} */ (error)?.code) === 'string'
    ? String(/** @type {{code?: string}} */ (error).code)
    : 'INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  /** @type {Record<string, unknown>} */
  const payload = { ok: false, code, error: message }
  const candidates = /** @type {{candidates?: unknown}} */ (error)?.candidates
  if (Array.isArray(candidates)) payload.candidates = candidates
  // A refused write is a normal outcome of the gate, not a server fault.
  const status = code === 'WRITE_DENIED' || code === 'WRITE_REQUIRES_AGENT' ? 403 : 400
  return { status, payload }
}

/**
 * Serve the tab's whole read model in one round trip.
 *
 * Deliberately called without `sessionId`: this is a management view of the
 * store, and passing a session would make every refresh land a `recalled` audit
 * row and bump every entry's recall count.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} memory - the ctx.memory service.
 * @param {import('node:http').IncomingMessage} req - request carrying filters.
 * @param {import('node:http').ServerResponse} res - response to own.
 */
function handleState(ctx, memory, req, res) {
  const url = new URL(req.url ?? '', 'http://localhost')
  const text = url.searchParams.get('text')
  const track = url.searchParams.get('track')
  const scope = url.searchParams.get('scope')
  /** @type {Record<string, unknown>} */
  const filter = { limit: clampLimit(url.searchParams.get('limit'), DEFAULT_ENTRY_LIMIT, MAX_ENTRY_LIMIT) }
  if (text !== null && text.length > 0) filter.text = text
  if (track !== null && TRACKS.includes(track)) filter.track = track
  if (scope !== null && SCOPES.includes(scope)) filter.scope = scope

  const result = memory.query(filter)
  const ledger = ledgerOf(memory)
  const auditLimit = clampLimit(url.searchParams.get('auditLimit'), DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT)

  let audit = []
  let auditAvailable = false
  if (ledger !== null && typeof ledger.auditList === 'function') {
    try {
      audit = ledger.auditList(auditLimit)
      auditAvailable = true
    } catch {
      auditAvailable = false
    }
  }

  let proposals = []
  let proposalsAvailable = false
  if (ledger !== null && typeof ledger.proposalList === 'function') {
    try {
      proposals = ledger.proposalList('pending', MAX_PROPOSALS)
      proposalsAvailable = true
    } catch {
      proposalsAvailable = false
    }
  }

  sendJson(res, 200, {
    ok: true,
    entries: result.entries,
    total: result.total,
    truncated: result.truncated,
    budgets: memory.budgets(),
    language: memory.language,
    focus: {
      workspaceKey: workspaceKeyOf(url.searchParams.get('cwd') ?? undefined),
      agentKey: agentKeyOf(url.searchParams.get('agentPreset') ?? undefined),
    },
    audit,
    auditAvailable,
    proposals,
    proposalsAvailable,
  })
}

/**
 * Run one write through the seam.
 * @param {Record<string, any>} memory - the ctx.memory service.
 * @param {Record<string, unknown>} body - parsed request body.
 * @param {{agent: unknown, gate: Function}} write - write context.
 * @returns {Promise<unknown>} the seam's own result shape.
 * @throws {RouteError} on an unsupported operation.
 */
async function runWrite(memory, body, write) {
  const track = requireEnum(body.track, TRACKS, 'track')
  const scope = requireEnum(body.scope, SCOPES, 'scope')
  const op = body.op
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string') : undefined
  const tagged = tags === undefined || tags.length === 0 ? {} : { tags }

  switch (op) {
    case 'add': {
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw new RouteError(400, 'text is required', 'INVALID_INPUT')
      }
      return memory.add({ track, scope, text: body.text, ...tagged }, write)
    }
    case 'replace': {
      if (typeof body.match !== 'string' || body.match.length === 0) {
        throw new RouteError(400, 'match is required', 'INVALID_INPUT')
      }
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw new RouteError(400, 'text is required', 'INVALID_INPUT')
      }
      return memory.replace({ track, scope, match: body.match, text: body.text, ...tagged }, write)
    }
    case 'remove': {
      if (typeof body.match !== 'string' || body.match.length === 0) {
        throw new RouteError(400, 'match is required', 'INVALID_INPUT')
      }
      return memory.remove({ track, scope, match: body.match }, write)
    }
    case 'consolidate': {
      const matches = Array.isArray(body.matches) ? body.matches.filter((item) => typeof item === 'string' && item.length > 0) : []
      if (matches.length === 0) throw new RouteError(400, 'matches must be a non-empty array of substrings', 'INVALID_INPUT')
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        throw new RouteError(400, 'text is required', 'INVALID_INPUT')
      }
      return memory.consolidate({ track, scope, matches, text: body.text, ...tagged }, write)
    }
    default:
      throw new RouteError(400, `unsupported op ${JSON.stringify(op)}`, 'INVALID_INPUT')
  }
}

/**
 * Approve or dismiss one pending proposal.
 *
 * Approval does not flip a flag and hope: it re-adds the proposal's text through
 * the same gate the model's tool would use, then marks the proposal decided.
 * A concurrent decision is reported as a 404 rather than masking a write that
 * already succeeded — the upstream command path makes the same trade.
 * @param {Context} ctx - plugin context.
 * @param {Record<string, any>} memory - the ctx.memory service.
 * @param {Record<string, unknown>} body - parsed request body.
 * @param {{agent: unknown, gate: Function}} write - write context.
 * @returns {Promise<Record<string, unknown>>} outcome for the client.
 */
async function runDecide(ctx, memory, body, write) {
  const ledger = ledgerOf(memory)
  if (ledger === null || typeof ledger.proposalDecide !== 'function') {
    throw new RouteError(501, 'this dsh-memento build exposes no proposal ledger', 'LEDGER_UNAVAILABLE')
  }
  const id = body.id
  if (typeof id !== 'string' || id.length === 0) throw new RouteError(400, 'id is required', 'INVALID_INPUT')
  const decision = body.decision

  if (decision === 'dismiss') {
    ledger.proposalDecide(id, 'dismissed')
    return { ok: true, decision: 'dismissed', id }
  }
  if (decision !== 'approve') {
    throw new RouteError(400, 'decision must be approve|dismiss', 'INVALID_INPUT')
  }

  const pending = /** @type {Array<Record<string, any>>} */ (ledger.proposalList('pending', 1000))
  const proposal = pending.find((candidate) => candidate.id === id)
  if (proposal === undefined) throw new RouteError(404, `proposal ${JSON.stringify(id)} is not pending`, 'PROPOSAL_NOT_FOUND')

  const result = await memory.add({
    track: proposal.track,
    scope: proposal.scope,
    text: proposal.text,
    source: 'proposal',
    workspaceKey: proposal.workspaceKey,
    agentKey: proposal.agentKey,
  }, write)
  try {
    ledger.proposalDecide(id, 'approved')
  } catch {
    // Concurrent decision: the write already landed, so do not fail the request.
  }
  void ctx
  return { ok: true, decision: 'approved', id, entry: result.entry, usage: result.usage }
}

/**
 * Read one optional service without declaring a hard dependency on it.
 *
 * Cordis THROWS on `ctx.<name>` when `<name>` was not injected — so a bare
 * `if (ctx.x === undefined)` guard never runs, because the property access is
 * itself the failure. Optional services must go through `ctx.get`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} serviceName - service key.
 * @returns {any} the service, or undefined when this composition has none.
 */
function serviceOf(ctx, serviceName) {
  const service = ctx.get(serviceName)
  return service === undefined || service === null ? undefined : service
}

/**
 * Run `fn` with one optional service, now or as soon as it appears.
 *
 * The idiom upstream uses for its own optional services: look now, otherwise
 * wait on the loader's `internal/service` announcement. The listener rides the
 * plugin fiber, so an unload while waiting cannot leak it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} serviceName - service key to await.
 * @param {(service: any) => void} fn - consumer, called at most once.
 */
function withService(ctx, serviceName, fn) {
  const existing = serviceOf(ctx, serviceName)
  if (existing !== undefined) {
    fn(existing)
    return
  }
  const off = ctx.on('internal/service', (/** @type {string} */ announced) => {
    if (announced !== serviceName) return
    const service = serviceOf(ctx, serviceName)
    if (service === undefined) return
    off()
    fn(service)
  })
  ctx.effect(() => off, `dsh-memento-tab: waiting for ${serviceName}`)
}

/**
 * Mount the tab's routes on the composition's web server.
 *
 * Routes are torn down with the plugin fiber: `webServer.register` returns the
 * only disposer, and a duplicate (kind, path) throws, so every handle is
 * collected and released in reverse.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} memory - the ctx.memory service.
 */
function registerRoutes(ctx, memory) {
  withService(ctx, 'webServer', (webServer) => {
    if (typeof webServer.register !== 'function') {
      serviceOf(ctx, 'logger')?.warn?.('dsh-memento-tab: webServer exposes no register(); the tab has no data routes')
      return
    }

    /** @type {Array<(() => void) | undefined>} */
    const disposers = []
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0).reverse()) dispose?.()
    }, 'dsh-memento-tab: routes')

    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      handler: (req, res) => {
        try {
          handleState(ctx, memory, req, res)
        } catch (error) {
          const { status, payload } = errorResponse(error)
          sendJson(res, status, payload)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_WRITE,
      handler: async (req, res) => {
        try {
          requireTabHeader(req)
          const body = await readJsonBody(req)
          const anchor = sessionAnchor(body)
          const write = {
            ...anchor,
            gate: (/** @type {any} */ payload, /** @type {any} */ context) => routeGate(ctx, payload, context),
          }
          const result = await runWrite(memory, body, write)
          sendJson(res, 200, { ok: true, result })
        } catch (error) {
          const { status, payload } = errorResponse(error)
          sendJson(res, status, payload)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_DECIDE,
      handler: async (req, res) => {
        try {
          requireTabHeader(req)
          const body = await readJsonBody(req)
          const anchor = sessionAnchor(body)
          const write = {
            ...anchor,
            gate: (/** @type {any} */ payload, /** @type {any} */ context) => routeGate(ctx, payload, context),
          }
          const result = await runDecide(ctx, memory, body, write)
          sendJson(res, 200, result)
        } catch (error) {
          const { status, payload } = errorResponse(error)
          sendJson(res, status, payload)
        }
      },
    }))
  })
}

/**
 * Register the tab's host half.
 *
 * The whole body is guarded on purpose. A throw from a plugin's `apply` fails
 * the entire loader tree, which means a bug in THIS plugin would stop dsh from
 * booting at all — the harness must never be hostage to a UI tab. Failures are
 * logged loudly and the plugin degrades to "no data routes" instead.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying `ctx.memory`.
 */
export function apply(ctx) {
  try {
    const memory = /** @type {Record<string, any>} */ (ctx.memory)
    installTabAnswerer(ctx)
    registerRoutes(ctx, memory)
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    serviceOf(ctx, 'logger')?.error?.(`dsh-memento-tab: failed to mount; the memory tab will have no data routes\n${message}`)
  }
}
