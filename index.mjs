/**
 * dsh-memento-tab — host half.
 *
 * A companion to `dsh-memento`, deliberately *not* a fork of it. This half owns
 * five JSON routes on the composition's `webServer` and delegates every read
 * and every write to the public `ctx.memory` seam. Nothing here imports a
 * private module from the upstream package, so an upstream release can only
 * break this plugin by changing its published seam — never by refactoring
 * internals.
 *
 * ## Routes
 *
 *   - `GET  /state`  — the whole read model in one round trip (entries, budgets,
 *     audit tail, pending proposals, adapter list).
 *   - `POST /write`  — `add | replace | remove | consolidate` through the seam.
 *   - `POST /decide` — approve or dismiss one pending proposal.
 *   - `GET  /export` — the memento envelope, or one adapter's own format.
 *   - `POST /import` — seed a batch from a memento envelope or an adapter
 *     payload, through the same gate and the same budget pre-check as any write.
 *
 * The three mutating routes (and export, which is mass egress) require the
 * {@link TAB_HEADER} header; `/state` alone does not, so a stuck tab can still
 * be diagnosed from a plain `curl`.
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
 * ## The deliberate couplings
 *
 * Everything upstream-specific here is a documented constant rather than an
 * internal, and each one is pinned by the repo's smoke test:
 *
 *   - An approval `reason` must start with memento's request marker, because
 *     that string is how the upstream answerer claims a write. The format is
 *     mirrored in {@link writeReason}. The tab's own marker cannot live in the
 *     reason (upstream parses it byte-for-byte), so it rides a separate field on
 *     the approval request object.
 *   - {@link EXPORT_SCHEMA}, {@link EXPORT_PLUGIN} and {@link MAX_IMPORT_ENTRIES}
 *     define the interchange format `/memory export` and `/memory import` use.
 *   - `auditList` / `proposalList` / `proposalDecide` / `listEntries` live on the
 *     provider handle rather than on the typed seam, so they are called through
 *     feature-detected accessors that degrade to "unavailable".
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
const ROUTE_EXPORT = '/api/memento-tab/export'
const ROUTE_IMPORT = '/api/memento-tab/import'

/**
 * Export envelope `schema` value, mirrored from dsh-memento's `EXPORT_SCHEMA`.
 *
 * Duplicated rather than imported: this package deliberately depends on no
 * subpath of the upstream package, so a file written by `/memory export` can
 * only be recognised by copying the constant. The smoke test pins it against
 * the installed upstream, the same way {@link writeReason} is pinned.
 */
export const EXPORT_SCHEMA = 'memory-export-v1'

/** Export envelope `plugin` value, mirrored from the upstream export path. */
export const EXPORT_PLUGIN = 'dsh-memento'

/** Batch ceiling, mirrored from dsh-memento's `MAX_IMPORT_ENTRIES` (pinned by smoke test). */
export const MAX_IMPORT_ENTRIES = 1000

/**
 * Substring ceiling for one merge, mirrored from dsh-memento's
 * `MAX_CONSOLIDATE_MATCHES` (pinned by smoke test). The seam enforces it too;
 * the tab uses it to disable the button before a doomed round trip.
 */
export const MAX_MERGE_MATCHES = 20

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
 * Read the provider's whole entry list through one feature-detected accessor.
 *
 * Export needs every entry regardless of the resolved workspace/agent key, which
 * the typed seam does not offer — `ctx.memory.query()` is filtered and would
 * bump recall counters. Like {@link ledgerOf}, this is defensive: a renamed
 * accessor degrades export to "unavailable" rather than failing the tab.
 * @param {unknown} memory - the ctx.memory service.
 * @returns {(() => Array<Record<string, unknown>>) | null} bound listEntries when usable.
 */
function entriesOf(memory) {
  const store = /** @type {{store?: unknown}} */ (memory)?.store
  if (store === null || typeof store !== 'object') return null
  const list = /** @type {{listEntries?: unknown}} */ (store).listEntries
  if (typeof list !== 'function') return null
  return () => /** @type {Array<Record<string, unknown>>} */ (list.call(store))
}

/**
 * Read the dsh-memory-protocol adapter registry, if this composition mounted one.
 *
 * `memoryAdapters` is provided by dsh-memento itself, so it is reached through
 * `ctx.get` (never `ctx.<name>`, which throws for a service that is not in
 * {@link inject}) and every capability is checked before use.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {{list: Function, adapt: Function, export: Function} | null} usable registry.
 */
function adapterRegistryOf(ctx) {
  const registry = serviceOf(ctx, 'memoryAdapters')
  if (registry === null || registry === undefined) return null
  if (typeof registry.list !== 'function' || typeof registry.adapt !== 'function' || typeof registry.export !== 'function') return null
  return registry
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
 * `AMBIGUOUS_MATCH`, `ENTRY_NOT_FOUND`, `WRITE_DENIED`, …) plus a JSON-safe
 * `.details`; both surface verbatim so the tab can offer "consolidate and retry"
 * with the exact overage instead of a wall of text.
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
  // dsh-memento puts the machine-readable facts in `details` (budget usage,
  // ambiguous-match candidates, the adapter id). They are JSON-safe by contract
  // and the client can act on them, so pass them through.
  const details = /** @type {{details?: unknown}} */ (error)?.details
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    Object.assign(payload, details)
  }
  const candidates = /** @type {{candidates?: unknown}} */ (error)?.candidates
  if (Array.isArray(candidates)) payload.candidates = candidates
  // A refused write is a normal outcome of the gate, not a server fault.
  const status = code === 'WRITE_DENIED' || code === 'WRITE_REQUIRES_AGENT'
    ? 403
    : code === 'ADAPTER_NOT_FOUND'
      ? 404
      : 400
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

  let adapters = []
  let adaptersAvailable = false
  const registry = adapterRegistryOf(ctx)
  if (registry !== null) {
    try {
      adapters = registry.list()
      adaptersAvailable = true
    } catch {
      adaptersAvailable = false
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
    adapters,
    adaptersAvailable,
    exportAvailable: entriesOf(memory) !== null,
    maxImportEntries: MAX_IMPORT_ENTRIES,
    maxMergeMatches: MAX_MERGE_MATCHES,
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

/** Compact local timestamp for a download filename (`2026-09-12-1830`). */
function stampOf(/** @type {Date} */ now = new Date()) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Decode one adapter payload the way the upstream file path does.
 *
 * `/memory import --adapter=<id> <path>` reads the file and tries JSON, falling
 * back to the raw text because the markdown adapters take prose. The tab always
 * receives a string, so it reproduces that branch exactly.
 * @param {string} payload - raw payload text.
 * @returns {unknown} parsed JSON when it parses, else the original string.
 */
function parseOrText(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

/**
 * Project one entry into the export payload, mirroring `/memory export`.
 *
 * Ids, timestamps and recall counters ride along for fidelity; the import path
 * ignores them and re-mints, exactly as upstream does.
 * @param {Record<string, unknown>} entry - store entry.
 * @returns {Record<string, unknown>} JSON-safe projection.
 */
function publicEntry(entry) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of ['id', 'track', 'scope', 'workspaceKey', 'agentKey', 'text', 'source', 'tags', 'version', 'createdAt', 'updatedAt', 'lastRecalled', 'recallCount']) {
    if (entry[key] !== undefined) out[key] = entry[key]
  }
  // The one field upstream's own export omits but its validator requires:
  // `validateMemoryEntry` demands `sessionId` be null or a string, so a document
  // without the key is rejected by `validateExportEnvelope`. Carrying it costs
  // nothing (import ignores it) and makes the file acceptable to any third-party
  // importer that validates instead of hand-rolling a shape check.
  out.sessionId = entry.sessionId ?? null
  return out
}

/**
 * Build the memento export document.
 *
 * Exported as a pure function so the smoke test can assert the exact document
 * against dsh-memento's own `validateExportEnvelope` — which is the only way to
 * be sure the file this tab writes is one `/memory import` will accept.
 * @param {Array<Record<string, unknown>>} entries - store entries.
 * @param {Array<Record<string, unknown>>} budgets - `memory.budgets()` output.
 * @returns {Record<string, unknown>} the envelope.
 */
export function exportEnvelope(entries, budgets) {
  return {
    plugin: EXPORT_PLUGIN,
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    budgets,
    entries: entries.map(publicEntry),
  }
}

/**
 * Resolve one adapter's export format label, for the download extension.
 * @param {{list: Function}} registry - adapter registry.
 * @param {string} adapterId - adapter id.
 * @returns {string} the adapter's `exportFormat`, or '' when unknown.
 */
function exportFormatOf(registry, adapterId) {
  try {
    const row = registry.list().find((/** @type {{id?: string}} */ adapter) => adapter.id === adapterId)
    return typeof /** @type {{exportFormat?: unknown}} */ (row)?.exportFormat === 'string'
      ? String(/** @type {{exportFormat?: string}} */ (row).exportFormat)
      : ''
  } catch {
    return ''
  }
}

/**
 * Build one export payload: the memento envelope, or one adapter's own format.
 * @param {Record<string, any>} memory - the ctx.memory service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} body - parsed request body.
 * @returns {Record<string, unknown>} `{ok, text, filename, format, adapterId, count}`.
 * @throws {RouteError} when the entry ledger or the adapter registry is missing.
 */
function runExport(memory, ctx, body) {
  const list = entriesOf(memory)
  if (list === null) {
    throw new RouteError(501, 'this dsh-memento build exposes no entry ledger', 'LEDGER_UNAVAILABLE')
  }
  const entries = list()
  const adapterId = body.adapterId

  if (adapterId === undefined || adapterId === null || adapterId === '') {
    return {
      ok: true,
      adapterId: null,
      format: EXPORT_SCHEMA,
      filename: `dsh-memento-export-${stampOf()}.json`,
      count: entries.length,
      text: JSON.stringify(exportEnvelope(entries, memory.budgets()), null, 2),
    }
  }
  if (typeof adapterId !== 'string') throw new RouteError(400, 'adapterId must be a string', 'INVALID_INPUT')

  const registry = adapterRegistryOf(ctx)
  if (registry === null) {
    throw new RouteError(501, 'this composition mounted no memory adapter registry', 'ADAPTERS_UNAVAILABLE')
  }
  const payload = registry.export(adapterId, entries)
  const format = exportFormatOf(registry, adapterId)
  const isText = typeof payload === 'string'
  const extension = isText ? (format.endsWith('-md') ? 'md' : 'txt') : 'json'
  return {
    ok: true,
    adapterId,
    format,
    filename: `dsh-memento-${adapterId}-${stampOf()}.${extension}`,
    count: entries.length,
    // Upstream prints `JSON.stringify(payload, null, 2)` for object payloads and
    // the bare string otherwise; mirror that so the two paths round-trip alike.
    text: isText ? /** @type {string} */ (payload) : JSON.stringify(payload, null, 2),
  }
}

/**
 * Parse a memento export envelope into entries, mirroring `/memory import`.
 *
 * Only `track`/`scope`/`text` are required; `source`/`workspaceKey`/`agentKey`
 * are carried when present and the seam validates the vocabulary afterwards.
 * @param {string} payload - raw JSON text.
 * @returns {Array<Record<string, unknown>>} validated entry inputs.
 * @throws {RouteError} when the envelope or one entry is malformed.
 */
function envelopeEntries(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new RouteError(400, 'the payload is not valid JSON', 'BAD_JSON')
  }
  const shape = parsed !== null && typeof parsed === 'object'
    ? /** @type {{plugin?: unknown, schema?: unknown, entries?: unknown}} */ (parsed)
    : undefined
  const valid = shape !== undefined && shape.plugin === EXPORT_PLUGIN && shape.schema === EXPORT_SCHEMA && Array.isArray(shape.entries)
  if (!valid) {
    throw new RouteError(400, `expected a ${EXPORT_PLUGIN} ${EXPORT_SCHEMA} export envelope`, 'IMPORT_BAD_SCHEMA')
  }
  const rows = /** @type {unknown[]} */ (shape.entries)
  /** @type {Array<Record<string, unknown>>} */
  const entries = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') {
      throw new RouteError(400, 'every entry needs string track, scope and non-empty text', 'IMPORT_BAD_ENTRY')
    }
    const entry = /** @type {{track?: unknown, scope?: unknown, text?: unknown}} */ (raw)
    if (typeof entry.track !== 'string' || typeof entry.scope !== 'string' || typeof entry.text !== 'string' || entry.text.length === 0) {
      throw new RouteError(400, 'every entry needs string track, scope and non-empty text', 'IMPORT_BAD_ENTRY')
    }
    entries.push(/** @type {Record<string, unknown>} */ (raw))
  }
  return entries
}

/**
 * Seed a batch of entries from an uploaded document.
 *
 * The write rides `memory.seed`, which is one approval for the whole batch, a
 * full budget pre-check, and a single transaction: an over-budget batch is
 * rejected whole (no partial import) and the exact overage comes back through
 * {@link errorResponse}.
 * @param {Record<string, any>} memory - the ctx.memory service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} body - parsed request body.
 * @param {{agent: unknown, gate: Function}} write - write context.
 * @returns {Promise<Record<string, unknown>>} `{ok, added}`.
 * @throws {RouteError} on a malformed payload or a missing adapter registry.
 */
async function runImport(memory, ctx, body, write) {
  const payload = body.payload
  if (typeof payload !== 'string' || payload.trim().length === 0) {
    throw new RouteError(400, 'payload is required', 'INVALID_INPUT')
  }
  const adapterId = body.adapterId
  const overrideKeys = body.overrideKeys === true

  /** @type {Array<Record<string, unknown>>} */
  let entries
  if (typeof adapterId === 'string' && adapterId.length > 0) {
    const registry = adapterRegistryOf(ctx)
    if (registry === null) {
      throw new RouteError(501, 'this composition mounted no memory adapter registry', 'ADAPTERS_UNAVAILABLE')
    }
    const adapted = registry.adapt(adapterId, parseOrText(payload))
    if (adapted === null || typeof adapted !== 'object' || !Array.isArray(adapted.entries)) {
      throw new RouteError(400, `adapter ${JSON.stringify(adapterId)} produced no entry list`, 'ADAPTER_PAYLOAD')
    }
    entries = adapted.entries
  } else {
    entries = envelopeEntries(payload)
  }

  if (entries.length === 0) throw new RouteError(400, 'the payload contains no entries', 'INVALID_INPUT')
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw new RouteError(400, `a single import is limited to ${MAX_IMPORT_ENTRIES} entries`, 'INVALID_INPUT')
  }

  // Layer keys come from the file by default, so an entry imported back into its
  // original workspace stays there. `overrideKeys` re-homes the whole batch to
  // the session doing the import.
  const normalized = entries.map((entry) => {
    /** @type {Record<string, unknown>} */
    const out = { track: entry.track, scope: entry.scope, text: entry.text }
    if (typeof entry.source === 'string' && entry.source.length > 0) out.source = entry.source
    if (!overrideKeys) {
      if (typeof entry.workspaceKey === 'string' && entry.workspaceKey.length > 0) out.workspaceKey = entry.workspaceKey
      if (typeof entry.agentKey === 'string' && entry.agentKey.length > 0) out.agentKey = entry.agentKey
    }
    if (Array.isArray(entry.tags)) out.tags = entry.tags
    return out
  })

  const result = await memory.seed(normalized, write)
  return { ok: true, added: result.added }
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

    // Read-only, so it takes the header without a session anchor: the gate here
    // is about mass egress, not about scoping a write.
    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_EXPORT,
      handler: (req, res) => {
        try {
          requireTabHeader(req)
          const url = new URL(req.url ?? '', 'http://localhost')
          const adapterId = url.searchParams.get('adapterId')
          sendJson(res, 200, runExport(memory, ctx, adapterId === null || adapterId === '' ? {} : { adapterId }))
        } catch (error) {
          const { status, payload } = errorResponse(error)
          sendJson(res, status, payload)
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: ROUTE_IMPORT,
      handler: async (req, res) => {
        try {
          requireTabHeader(req)
          const body = await readJsonBody(req)
          const anchor = sessionAnchor(body)
          const write = {
            ...anchor,
            gate: (/** @type {any} */ payload, /** @type {any} */ context) => routeGate(ctx, payload, context),
          }
          sendJson(res, 200, await runImport(memory, ctx, body, write))
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
