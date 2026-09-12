// SPDX-License-Identifier: MIT
// client/client.js — dsh-memento-tab 浏览器半侧（零构建 vanilla，单模块）。
//
// The host's dsh.client scan injects this file as a classic script into the
// __DSH_BOOT__ graph; at execution it registers exactly one factory through
// window.__ModuleLoader__.load (id = package name; a second load in the same
// file would leave an orphan factory that never materializes).
//
// apply() contributes one `conversation.view` entry — a session tab beside
// Chat / Trajectory / Context. It is a management surface over the whole
// dsh-memento store: every layer with its budget bar, substring search,
// proposals waiting for a decision, and the audit tail.
//
// Reads go to this plugin's own /api/memento-tab/state. Writes go to
// /api/memento-tab/write and /decide, and every one of them stops at
// dsh-memento's approval gate before it touches the store — approving a
// proposal here asks the same question the model would.
//
// Styling rides the host's own design tokens (--dsw-alias-*), so the tab
// follows the active light/dark theme instead of hardcoding a palette.

;(function () {
  'use strict'
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return
  window.__ModuleLoader__.load({
    id: 'dsh-memento-tab',
    factory: function (require) {
      const react = require('react')
      /** createElement shorthand (the host platform supplies react; no JSX build step). */
      const jsx = react.createElement

      const NS = 'dsh-memento-tab'
      const STYLE_ID = 'dsh-memento-tab-style'
      const ROUTE_STATE = '/api/memento-tab/state'
      const ROUTE_WRITE = '/api/memento-tab/write'
      const ROUTE_DECIDE = '/api/memento-tab/decide'

      const TRACKS = ['user', 'agent']
      const SCOPES = ['user-global', 'workspace']

      const zh = {
        tab: '记忆',
        search: '搜索记忆…',
        trackAll: '全部轨道',
        trackUser: '用户',
        trackAgent: '环境',
        scopeAll: '全部层',
        scopeGlobal: '全局',
        scopeWorkspace: '工作区',
        onlyMine: '仅本会话',
        refresh: '刷新',
        composePlaceholder: '记一条…（保存时会走审批门）',
        save: '保存',
        edit: '改写',
        remove: '删除',
        cancel: '取消',
        confirmRemove: '删除这条记忆？会走审批门。',
        approving: '处理中…',
        approve: '批准',
        dismiss: '驳回',
        proposals: '待批提案',
        noProposals: '暂无待批提案。',
        audit: '审计尾',
        noAudit: '暂无审计记录。',
        auditUnavailable: '此 dsh-memento 版本未暴露审计账本。',
        empty: '这个筛选下没有条目。',
        loading: '读取中…',
        loadFailed: '读取失败',
        saved: '已保存',
        removed: '已删除',
        replaced: '已改写',
        dismissed: '已驳回',
        approved: '已批准并写入',
        chars: '字符',
        focusTag: '本会话',
        untitled: '（空）',
        noSession: '没有活动会话，记忆 tab 暂不可用。',
        code: {
          BUDGET_EXCEEDED: '这一层已写满。先整合或删几条再试——它不会替你截断。',
          AMBIGUOUS_MATCH: '子串命中了多条。换一个更长的唯一子串。',
          ENTRY_NOT_FOUND: '没找到匹配的条目。',
          WRITE_DENIED: '写入被审批门拒绝。',
          WRITE_REQUIRES_AGENT: '写入需要会话上下文。',
          NO_SESSION: '缺少 sessionId。',
          LEDGER_UNAVAILABLE: '此 dsh-memento 版本不提供提案账本。',
          PROPOSAL_NOT_FOUND: '该提案已被裁决或不存在。',
        },
      }
      const en = {
        tab: 'Memory',
        search: 'Search memory…',
        trackAll: 'All tracks',
        trackUser: 'User',
        trackAgent: 'Agent',
        scopeAll: 'All layers',
        scopeGlobal: 'Global',
        scopeWorkspace: 'Workspace',
        onlyMine: 'This session',
        refresh: 'Refresh',
        composePlaceholder: 'Remember something… (saving goes through the approval gate)',
        save: 'Save',
        edit: 'Rewrite',
        remove: 'Delete',
        cancel: 'Cancel',
        confirmRemove: 'Delete this entry? It will go through the approval gate.',
        approving: 'Working…',
        approve: 'Approve',
        dismiss: 'Dismiss',
        proposals: 'Pending proposals',
        noProposals: 'No pending proposals.',
        audit: 'Audit tail',
        noAudit: 'No audit rows yet.',
        auditUnavailable: 'This dsh-memento build exposes no audit ledger.',
        empty: 'No entries match this filter.',
        loading: 'Loading…',
        loadFailed: 'Load failed',
        saved: 'Saved',
        removed: 'Deleted',
        replaced: 'Rewritten',
        dismissed: 'Dismissed',
        approved: 'Approved and written',
        chars: 'chars',
        focusTag: 'session',
        untitled: '(empty)',
        noSession: 'No active session; the memory tab is unavailable.',
        code: {
          BUDGET_EXCEEDED: 'This layer is full. Consolidate or remove entries first — it never truncates for you.',
          AMBIGUOUS_MATCH: 'That substring matched more than one entry. Use a longer, unique one.',
          ENTRY_NOT_FOUND: 'No entry matched.',
          WRITE_DENIED: 'The approval gate refused the write.',
          WRITE_REQUIRES_AGENT: 'A write needs session context.',
          NO_SESSION: 'Missing sessionId.',
          LEDGER_UNAVAILABLE: 'This dsh-memento build exposes no proposal ledger.',
          PROPOSAL_NOT_FOUND: 'That proposal was already decided, or does not exist.',
        },
      }

      /** Track/scope display names, resolved from the active locale. */
      function groupTitle(t, track, scope) {
        const layer = scope === 'user-global' ? t('scopeGlobal') : t('scopeWorkspace')
        const kind = track === 'user' ? t('trackUser') : t('trackAgent')
        return `${kind} · ${layer}`
      }

      /** Escape a value before it reaches innerHTML. */
      function esc(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      }

      /** Last path segment, for labelling a workspace key without its full path. */
      function basename(key) {
        if (typeof key !== 'string' || key.length === 0) return ''
        const parts = key.split(/[\\/]/).filter((part) => part.length > 0)
        return parts.length === 0 ? key : parts[parts.length - 1]
      }

      /** Inject the tab's stylesheet once per page. */
      function installStyles() {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = `
.mtt-root { height: 100%; min-width: 0; box-sizing: border-box; overflow-x: hidden; overflow-y: auto;
  padding: 14px 18px 28px; color: var(--dsw-alias-label-primary, #1b1b1b);
  font-family: system-ui, "Segoe UI", "PingFang SC", sans-serif; font-size: 13px; line-height: 1.55; }
.mtt-root * { box-sizing: border-box; }
.mtt-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.mtt-search { flex: 1 1 12rem; min-width: 0; height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; }
.mtt-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-select { min-width: 0; max-width: 100%; height: 32px; padding: 0 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; }
.mtt-check { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary, #5b5b5b); cursor: pointer; }
.mtt-btn { flex: none; height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer; font: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-2, #f4f4f5); color: var(--dsw-alias-label-primary, #1b1b1b); }
.mtt-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.mtt-btn[disabled] { opacity: .5; cursor: default; }
.mtt-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff); }
.mtt-primary:hover { background: var(--dsw-alias-button-primary-hover, #3d5bee); }
.mtt-danger { color: var(--dsw-alias-state-error-primary, #d33); }
/* Two lines, not one: a single flex row of two selects + a textarea cannot shrink
   below its min-content width, so in a narrow conversation column it pushed the
   textarea off-screen. The controls wrap on line 1; the textarea owns line 2. */
.mtt-compose { display: grid; gap: 8px; margin-bottom: 12px; }
.mtt-compose-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mtt-compose textarea { width: 100%; min-width: 0; padding: 6px 10px; border-radius: 8px; resize: vertical; font: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.mtt-msg { margin: 0 0 10px; padding: 7px 11px; border-radius: 8px; display: none; white-space: pre-wrap;
  background: var(--dsw-alias-bg-layer-2, #f4f4f5); border-left: 3px solid var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-msg.on { display: block; }
.mtt-msg.bad { border-left-color: var(--dsw-alias-state-error-primary, #d33); }
.mtt-card { margin-bottom: 14px; padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-1, #fff); }
.mtt-card > h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.mtt-card > h4 span { margin-left: auto; font-weight: 400; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.mtt-bar-track { height: 5px; border-radius: 3px; margin: 4px 0 9px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.08)); }
.mtt-bar-fill { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-bar-fill.warn { background: var(--dsw-alias-state-warn-primary, #e08b00); }
.mtt-bar-fill.full { background: var(--dsw-alias-state-error-primary, #d33); }
.mtt-entry { padding: 7px 9px; border-radius: 9px; margin-bottom: 5px;
  background: var(--dsw-alias-bg-layer-2, #f7f7f8); }
.mtt-entry.focus { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-entry .t { white-space: pre-wrap; word-break: break-word; }
.mtt-entry .m { margin-top: 4px; font-size: 11px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.mtt-entry .m button { padding: 2px 7px; font-size: 11px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: transparent; color: var(--dsw-alias-label-secondary, #5b5b5b); }
.mtt-entry .m button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.mtt-chip { padding: 1px 6px; border-radius: 999px; font-size: 10px;
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.07)); }
.mtt-edit { width: 100%; margin-top: 5px; padding: 5px 8px; border-radius: 7px; font: inherit; resize: vertical;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.mtt-edit-row { display: flex; gap: 6px; margin-top: 5px; }
.mtt-prop { padding: 8px 9px; border-radius: 9px; margin-bottom: 6px;
  background: var(--dsw-alias-bg-layer-2, #f7f7f8); }
.mtt-prop .m { font-size: 11px; margin-bottom: 4px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.mtt-prop .x { display: flex; gap: 6px; margin-top: 6px; }
.mtt-audit { display: flex; gap: 10px; padding: 3px 0; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5b5b5b); border-bottom: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.mtt-audit .ts { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-variant-numeric: tabular-nums; }
.mtt-empty { margin: 8px 0; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
`
        document.head.appendChild(style)
      }

      /**
       * One JSON round trip against this plugin's own routes.
       * @param {string} path - route pathname.
       * @param {RequestInit} [init] - fetch options.
       * @param {AbortSignal} [signal] - caller lifetime.
       * @returns {Promise<any>} the parsed body.
       */
      async function api(path, init, signal) {
        const response = await fetch(path, { credentials: 'same-origin', ...init, signal })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          const error = new Error(payload.error ?? `HTTP ${response.status}`)
          error.code = payload.code
          throw error
        }
        return payload
      }

      /**
       * Read the live Session header this tab is rendered for.
       *
       * This is the same source dsh-memento's own tool path reads, so a write
       * started here lands in the layer the session actually sees.
       * @param {any} ctx - client context.
       * @param {string} sessionId - session view identity.
       * @returns {{cwd?: string, agentPreset?: string}} header slice.
       */
      function sessionHeader(ctx, sessionId) {
        try {
          const header = ctx.sessions?.binding?.(sessionId)?.session?.header
          const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
          const agentPreset = typeof header?.agentPreset === 'string' ? header.agentPreset : undefined
          return { cwd, agentPreset }
        } catch {
          return {}
        }
      }

      /** Localized message for one failure, preferring the stable code. */
      function describeError(t, error) {
        const code = error && typeof error === 'object' ? error.code : undefined
        const hint = code !== undefined && t.code[code] !== undefined ? `${t.code[code]}\n` : ''
        return `${hint}${error && error.message ? error.message : String(error)}`
      }

      /**
       * Mount the imperative body of the tab and return its disposer.
       * @param {HTMLElement} root - container element owned by the React shell.
       * @param {any} ctx - client context.
       * @param {string} sessionId - session view identity.
       * @param {Function} t - bound translator.
       * @returns {() => void} cleanup.
       */
      function mountTab(root, ctx, sessionId, t) {
        const abort = new AbortController()
        const state = {
          text: '',
          track: '',
          scope: '',
          onlyMine: false,
          editing: /** @type {string | null} */ (null),
          draft: '',
          saving: false,
          data: /** @type {any} */ (null),
          error: /** @type {string} */ (''),
          notice: /** @type {string} */ (''),
        }

        const anchor = () => sessionHeader(ctx, sessionId)

        root.innerHTML = `
<div class="mtt-bar">
  <input class="mtt-search" placeholder="${esc(t('search'))}" />
  <select class="mtt-select mtt-track">
    <option value="">${esc(t('trackAll'))}</option>
    <option value="user">${esc(t('trackUser'))}</option>
    <option value="agent">${esc(t('trackAgent'))}</option>
  </select>
  <select class="mtt-select mtt-scope">
    <option value="">${esc(t('scopeAll'))}</option>
    <option value="user-global">${esc(t('scopeGlobal'))}</option>
    <option value="workspace">${esc(t('scopeWorkspace'))}</option>
  </select>
  <label class="mtt-check"><input type="checkbox" class="mtt-only" />${esc(t('onlyMine'))}</label>
  <button class="mtt-btn mtt-refresh">${esc(t('refresh'))}</button>
</div>
<div class="mtt-compose">
  <div class="mtt-compose-row">
    <select class="mtt-select mtt-new-track">
      <option value="user">${esc(t('trackUser'))}</option>
      <option value="agent">${esc(t('trackAgent'))}</option>
    </select>
    <select class="mtt-select mtt-new-scope">
      <option value="workspace">${esc(t('scopeWorkspace'))}</option>
      <option value="user-global">${esc(t('scopeGlobal'))}</option>
    </select>
    <button class="mtt-btn mtt-primary mtt-save">${esc(t('save'))}</button>
  </div>
  <textarea class="mtt-new-text" rows="2" placeholder="${esc(t('composePlaceholder'))}"></textarea>
</div>
<div class="mtt-msg"></div>
<div class="mtt-body"></div>`

        const $ = (selector) => root.querySelector(selector)
        const search = $('.mtt-search')
        const trackSelect = $('.mtt-track')
        const scopeSelect = $('.mtt-scope')
        const onlyMine = $('.mtt-only')
        const newTrack = $('.mtt-new-track')
        const newScope = $('.mtt-new-scope')
        const newText = $('.mtt-new-text')
        const saveBtn = $('.mtt-save')
        const msg = $('.mtt-msg')
        const body = $('.mtt-body')

        /** Show one status line; `bad` marks a failure. */
        function say(text, bad) {
          state.notice = bad ? '' : text
          state.error = bad ? text : ''
          msg.textContent = text
          msg.classList.toggle('on', text.length > 0)
          msg.classList.toggle('bad', bad === true)
        }

        /** Reload the whole read model. */
        async function refresh() {
          const params = new URLSearchParams()
          if (state.text.length > 0) params.set('text', state.text)
          if (state.track.length > 0) params.set('track', state.track)
          if (state.scope.length > 0) params.set('scope', state.scope)
          const header = anchor()
          if (header.cwd !== undefined) params.set('cwd', header.cwd)
          if (header.agentPreset !== undefined) params.set('agentPreset', header.agentPreset)
          try {
            state.data = await api(`${ROUTE_STATE}?${params.toString()}`, {}, abort.signal)
            state.error = ''
          } catch (error) {
            if (abort.signal.aborted) return
            state.data = null
            state.error = `${t('loadFailed')}: ${describeError(t, error)}`
          }
          render()
        }

        /** Run one write and reload on success. */
        async function write(payload, okMessage) {
          if (state.saving) return
          state.saving = true
          saveBtn.disabled = true
          say(t('approving'), false)
          try {
            const header = anchor()
            await api(ROUTE_WRITE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...payload, sessionId, ...header }),
            }, abort.signal)
            if (abort.signal.aborted) return
            state.saving = false
            saveBtn.disabled = false
            await refresh()
            say(okMessage, false)
          } catch (error) {
            if (abort.signal.aborted) return
            state.saving = false
            saveBtn.disabled = false
            say(describeError(t, error), true)
          }
        }

        /** Decide one proposal. */
        async function decide(id, decision) {
          say(t('approving'), false)
          try {
            const header = anchor()
            await api(ROUTE_DECIDE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, decision, sessionId, ...header }),
            }, abort.signal)
            if (abort.signal.aborted) return
            await refresh()
            say(decision === 'approve' ? t('approved') : t('dismissed'), false)
          } catch (error) {
            if (abort.signal.aborted) return
            say(describeError(t, error), true)
          }
        }

        /** Render one entry row. */
        function entryHtml(entry, focus, index) {
          const isFocus = (focus.workspaceKey === '' || entry.workspaceKey === focus.workspaceKey)
            && (entry.agentKey === '' || entry.agentKey === focus.agentKey)
          const meta = []
          if (entry.workspaceKey) meta.push(`<span class="mtt-chip">${esc(basename(entry.workspaceKey))}</span>`)
          if (entry.agentKey) meta.push(`<span class="mtt-chip">${esc(entry.agentKey)}</span>`)
          if (isFocus && entry.scope === 'workspace') meta.push(`<span class="mtt-chip">${esc(t('focusTag'))}</span>`)
          if (Array.isArray(entry.tags)) {
            for (const tag of entry.tags) meta.push(`<span class="mtt-chip">#${esc(tag)}</span>`)
          }
          const editing = state.editing === entry.id
          const draft = editing
            ? `<textarea class="mtt-edit" rows="3">${esc(state.draft)}</textarea>
               <div class="mtt-edit-row">
                 <button class="mtt-btn mtt-primary" data-commit="${esc(entry.id)}">${esc(t('save'))}</button>
                 <button class="mtt-btn" data-cancel="${esc(entry.id)}">${esc(t('cancel'))}</button>
               </div>`
            : ''
          return `<div class="mtt-entry${isFocus && entry.scope === 'workspace' ? ' focus' : ''}" data-idx="${index}">
  <div class="t">${esc(entry.text) || esc(t('untitled'))}</div>
  <div class="m">${meta.join('')}
    <button data-edit="${esc(entry.id)}">${esc(t('edit'))}</button>
    <button class="mtt-danger" data-remove="${esc(entry.id)}">${esc(t('remove'))}</button>
  </div>
  ${draft}
</div>`
        }

        /** Render the layer cards, proposals and audit tail. */
        function render() {
          const data = state.data
          if (data === null) {
            body.innerHTML = `<div class="mtt-empty">${esc(state.error || t('loading'))}</div>`
            return
          }
          const focus = data.focus ?? { workspaceKey: '', agentKey: '' }
          const entries = Array.isArray(data.entries) ? data.entries : []
          const visible = state.onlyMine
            ? entries.filter((entry) => (focus.workspaceKey === '' || entry.workspaceKey === focus.workspaceKey)
              && (entry.agentKey === '' || entry.agentKey === focus.agentKey))
            : entries

          const budgetOf = (track, scope) => {
            const row = (data.budgets ?? []).find((candidate) => candidate.track === track && candidate.scope === scope)
            return row ?? { used: 0, limit: 0 }
          }

          const cards = []
          for (const track of TRACKS) {
            for (const scope of SCOPES) {
              const group = visible.filter((entry) => entry.track === track && entry.scope === scope)
              const budget = budgetOf(track, scope)
              if (group.length === 0 && budget.limit === 0) continue
              const ratio = budget.limit > 0 ? Math.min(1, budget.used / budget.limit) : 0
              const tone = ratio >= 1 ? ' full' : ratio >= 0.8 ? ' warn' : ''
              cards.push(`<div class="mtt-card">
  <h4>${esc(groupTitle(t, track, scope))}<span>${budget.used}/${budget.limit} ${esc(t('chars'))}</span></h4>
  <div class="mtt-bar-track"><div class="mtt-bar-fill${tone}" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
  ${group.length === 0
    ? `<div class="mtt-empty">${esc(t('empty'))}</div>`
    : group.map((entry, index) => entryHtml(entry, focus, index)).join('')}
</div>`)
            }
          }

          const proposals = Array.isArray(data.proposals) ? data.proposals : []
          if (proposals.length > 0) {
            cards.push(`<div class="mtt-card">
  <h4>${esc(t('proposals'))}<span>${proposals.length}</span></h4>
  ${proposals.map((proposal) => {
    const preview = proposal.text.length > 220 ? `${proposal.text.slice(0, 220)}…` : proposal.text
    return `<div class="mtt-prop">
  <div class="m">${esc(proposal.track)}/${esc(proposal.scope)} · ${esc(proposal.source ?? '')} · ${proposal.text.length} ${esc(t('chars'))}</div>
  <div class="t">${esc(preview)}</div>
  <div class="x">
    <button class="mtt-btn mtt-primary" data-approve="${esc(proposal.id)}">${esc(t('approve'))}</button>
    <button class="mtt-btn" data-dismiss="${esc(proposal.id)}">${esc(t('dismiss'))}</button>
  </div>
</div>`
  }).join('')}
</div>`)
          } else if (data.proposalsAvailable === false) {
            cards.push(`<div class="mtt-card"><h4>${esc(t('proposals'))}</h4><div class="mtt-empty">${esc(t('auditUnavailable'))}</div></div>`)
          }

          const audit = Array.isArray(data.audit) ? data.audit : []
          cards.push(`<div class="mtt-card">
  <h4>${esc(t('audit'))}<span>${audit.length}</span></h4>
  ${audit.length === 0
    ? `<div class="mtt-empty">${esc(data.auditAvailable === false ? t('auditUnavailable') : t('noAudit'))}</div>`
    : audit.map((row) => `<div class="mtt-audit">
    <span class="ts">${esc(new Date(row.ts).toLocaleTimeString())}</span>
    <span>${esc(row.action)}${row.track ? ` ${esc(row.track)}/${esc(row.scope)}` : ''}</span>
    <span>${esc(row.outcome ?? '')}</span>
  </div>`).join('')}
</div>`)

          body.innerHTML = cards.join('')
        }

        // ── wiring ──────────────────────────────────────────────────────────
        let searchTimer = /** @type {any} */ (null)
        search.addEventListener('input', () => {
          state.text = search.value.trim()
          if (searchTimer !== null) clearTimeout(searchTimer)
          searchTimer = setTimeout(() => { void refresh() }, 220)
        })
        trackSelect.addEventListener('change', () => { state.track = trackSelect.value; void refresh() })
        scopeSelect.addEventListener('change', () => { state.scope = scopeSelect.value; void refresh() })
        onlyMine.addEventListener('change', () => { state.onlyMine = onlyMine.checked; render() })
        $('.mtt-refresh').addEventListener('click', () => { void refresh() })

        saveBtn.addEventListener('click', () => {
          const text = newText.value.trim()
          if (text.length === 0) return
          void write({ op: 'add', track: newTrack.value, scope: newScope.value, text }, t('saved'))
            .then(() => { newText.value = '' })
        })

        body.addEventListener('click', (event) => {
          const target = /** @type {HTMLElement} */ (event.target)
          const button = target.closest('button')
          if (button === null) return
          const data = state.data
          const entries = Array.isArray(data?.entries) ? data.entries : []

          const removeId = button.getAttribute('data-remove')
          if (removeId !== null) {
            const entry = entries.find((candidate) => candidate.id === removeId)
            if (entry === undefined) return
            if (!window.confirm(t('confirmRemove'))) return
            // The seam addresses entries by a unique substring; the full text is
            // the only value guaranteed unique without a second round trip.
            void write({ op: 'remove', track: entry.track, scope: entry.scope, match: entry.text }, t('removed'))
            return
          }
          const editId = button.getAttribute('data-edit')
          if (editId !== null) {
            const entry = entries.find((candidate) => candidate.id === editId)
            state.editing = editId
            state.draft = entry?.text ?? ''
            render()
            return
          }
          const cancelId = button.getAttribute('data-cancel')
          if (cancelId !== null) {
            state.editing = null
            state.draft = ''
            render()
            return
          }
          const commitId = button.getAttribute('data-commit')
          if (commitId !== null) {
            const entry = entries.find((candidate) => candidate.id === commitId)
            const field = root.querySelector('.mtt-edit')
            const next = field !== null ? field.value.trim() : ''
            if (entry === undefined || next.length === 0) return
            state.editing = null
            void write({ op: 'replace', track: entry.track, scope: entry.scope, match: entry.text, text: next }, t('replaced'))
            return
          }
          const approveId = button.getAttribute('data-approve')
          if (approveId !== null) { void decide(approveId, 'approve'); return }
          const dismissId = button.getAttribute('data-dismiss')
          if (dismissId !== null) { void decide(dismissId, 'dismiss') }
        })

        void refresh()

        return () => {
          if (searchTimer !== null) clearTimeout(searchTimer)
          abort.abort()
        }
      }

      /**
       * The session tab body. Holds no state of its own: the imperative mount
       * owns the DOM, and remounts when the addressed session changes.
       * @param {{sessionId?: string}} props - conversation.view render props.
       * @returns {import('react').ReactElement} the tab element.
       */
      function makeMemoryTab(ctx, t) {
        return function MemoryTab(props) {
          const host = react.useRef(/** @type {HTMLElement | null} */ (null))
          const sessionId = props.sessionId
          react.useEffect(() => {
            const element = host.current
            if (element === null || sessionId === undefined) return undefined
            return mountTab(element, ctx, sessionId, t)
          }, [sessionId])
          if (sessionId === undefined) {
            return jsx('div', { className: 'mtt-root' }, jsx('div', { className: 'mtt-empty' }, t('noSession')))
          }
          return jsx('div', { className: 'mtt-root', ref: host })
        }
      }

      /** Client plugin body: dictionaries, stylesheet, and the session tab. */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memento-tab: dictionaries')
        const t = ctx.locale.bind(NS)
        installStyles()
        const MemoryTab = makeMemoryTab(ctx, t)
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'memory',
          // Chat 0 / Trajectory 10 / Context 20: the memory tab sits at the end.
          order: 30,
          locale: NS,
          label: () => t('tab'),
        }, (props) => jsx(MemoryTab, props)))
      }

      return {
        name: 'dsh-memento-tab-client',
        inject: ['slots', 'locale'],
        apply,
      }
    },
  })
})()
