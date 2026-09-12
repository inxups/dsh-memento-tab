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
      const ROUTE_EXPORT = '/api/memento-tab/export'
      const ROUTE_IMPORT = '/api/memento-tab/import'

      /**
       * Headers every mutating (and egress) route requires. The custom header is
       * the routes' only admission check: a cross-origin page cannot set one
       * without a CORS preflight this server does not answer.
       */
      const TAB_HEADERS = { 'content-type': 'application/json', 'x-memento-tab': '1' }

      /** GET-only variant of {@link TAB_HEADERS}. */
      const TAB_HEADERS_GET = { 'x-memento-tab': '1' }

      /** Mirrors the host route's body cap, so an oversized file never leaves the browser. */
      const MAX_PAYLOAD_BYTES = 512 * 1024

      /** Fallback for the merge ceiling when the host does not report one (older host). */
      const MAX_MERGE_FALLBACK = 20

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
        composePlaceholder: '记一条…（直接写入，不再二次确认）',
        save: '保存',
        edit: '改写',
        remove: '删除',
        cancel: '取消',
        confirmRemove: '删除这条记忆？此操作立即生效。',
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
        pick: '勾选以合并',
        selected: '已选',
        merge: '合并',
        merged: '已合并',
        clearSelection: '取消选择',
        mergeIntro: '合并会删掉选中的条目，换成一整条新文本。同一层才能合并。',
        mergeMixed: '选中的条目不在同一层（轨道/作用域不同），无法合并。',
        mergeTooMany: '一次最多合并 20 条。',
        mergePlaceholder: '合并后的新文本（上面是选中的原文，删减后提交）…',
        mergeSubmit: '合并写入',
        data: '数据',
        entriesUnit: '条',
        exportTitle: '导出',
        exportMemento: 'memento JSON',
        exportAdapterLabel: '格式',
        exportRun: '导出',
        exportEmpty: '库里还没有条目，导出会是空信封。',
        copy: '复制',
        copied: '已复制到剪贴板',
        copyFailed: '复制失败，请手动选中下面的文本。',
        download: '下载',
        importTitle: '导入',
        importAdapterLabel: '来源格式',
        importPick: '选择文件…',
        importPlaceholder: '在此粘贴 JSON 或 Markdown，或从上面选一个文件…',
        importRun: '导入写入',
        importOverride: '按当前会话重写层键',
        importLimit: '单次最多',
        importFile: '文件',
        importConfirm: '确认导入并写入？',
        importConfirmCount: '确认导入并写入？将写入',
        importInvalid: '这不是一个 memento 导出文件（JSON 解析失败或结构不符）。',
        importTooBig: '文件超过 512 KB，本插件的请求体上限就是它。',
        importNothing: '还没有内容可导入。',
        imported: '已导入',
        adapters: '适配器',
        noAdapters: '此构建没有注册任何适配器。',
        adaptersUnavailable: '此构建未暴露适配器注册表。',
        exportUnavailable: '此构建未暴露条目账本，无法导出。',
        code: {
          BUDGET_EXCEEDED: '这一层已写满。先整合或删几条再试——它不会替你截断。',
          AMBIGUOUS_MATCH: '子串命中了多条。换一个更长的唯一子串。',
          ENTRY_NOT_FOUND: '没找到匹配的条目。',
          WRITE_DENIED: '写入被审批门拒绝。',
          WRITE_REQUIRES_AGENT: '写入需要会话上下文。',
          NO_SESSION: '缺少 sessionId。',
          LEDGER_UNAVAILABLE: '此版本未暴露所需的账本。',
          PROPOSAL_NOT_FOUND: '该提案已被裁决或不存在。',
          IMPORT_BAD_SCHEMA: '不是 dsh-memento 的 memory-export-v1 信封。',
          IMPORT_BAD_ENTRY: '有条目缺少 track / scope / text。',
          BAD_JSON: '内容不是合法 JSON。',
          ADAPTER_NOT_FOUND: '没有这个适配器。',
          ADAPTER_PAYLOAD: '内容不符合该适配器的格式。',
          ADAPTERS_UNAVAILABLE: '此构建未挂载适配器注册表。',
          MISSING_TAB_HEADER: '请求缺少来源标记，被路由拒绝。',
          BODY_TOO_LARGE: '内容超过了请求体上限。',
          INVALID_INPUT: '参数不合法。',
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
        composePlaceholder: 'Remember something… (writes straight away, no second confirm)',
        save: 'Save',
        edit: 'Rewrite',
        remove: 'Delete',
        cancel: 'Cancel',
        confirmRemove: 'Delete this entry? This takes effect immediately.',
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
        pick: 'Select to merge',
        selected: 'Selected',
        merge: 'Merge',
        merged: 'Merged',
        clearSelection: 'Clear selection',
        mergeIntro: 'Merging deletes the selected entries and replaces them with one new text. All of them must be in the same layer.',
        mergeMixed: 'The selected entries are not all in the same layer (track/scope), so they cannot be merged.',
        mergeTooMany: 'At most 20 entries can be merged at once.',
        mergePlaceholder: 'The merged text (above is the selected originals — edit, then submit)…',
        mergeSubmit: 'Merge and write',
        data: 'Data',
        entriesUnit: 'entries',
        exportTitle: 'Export',
        exportMemento: 'memento JSON',
        exportAdapterLabel: 'Format',
        exportRun: 'Export',
        exportEmpty: 'The store is empty, so the export will be an empty envelope.',
        copy: 'Copy',
        copied: 'Copied to the clipboard',
        copyFailed: 'Copy failed — select the text below by hand.',
        download: 'Download',
        importTitle: 'Import',
        importAdapterLabel: 'Source format',
        importPick: 'Choose a file…',
        importPlaceholder: 'Paste JSON or Markdown here, or pick a file above…',
        importRun: 'Import and write',
        importOverride: 'Re-home to this session',
        importLimit: 'Max per import',
        importFile: 'File',
        importConfirm: 'Import and write now?',
        importConfirmCount: 'Import and write now? Entries:',
        importInvalid: 'That is not a memento export (JSON parse failed, or the shape is wrong).',
        importTooBig: 'The file exceeds 512 KB, which is this plugin\u2019s request-body cap.',
        importNothing: 'Nothing to import yet.',
        imported: 'Imported',
        adapters: 'Adapters',
        noAdapters: 'This build registered no adapters.',
        adaptersUnavailable: 'This build exposes no adapter registry.',
        exportUnavailable: 'This build exposes no entry ledger, so it cannot export.',
        code: {
          BUDGET_EXCEEDED: 'This layer is full. Consolidate or remove entries first — it never truncates for you.',
          AMBIGUOUS_MATCH: 'That substring matched more than one entry. Use a longer, unique one.',
          ENTRY_NOT_FOUND: 'No entry matched.',
          WRITE_DENIED: 'The approval gate refused the write.',
          WRITE_REQUIRES_AGENT: 'A write needs session context.',
          NO_SESSION: 'Missing sessionId.',
          LEDGER_UNAVAILABLE: 'This dsh-memento build exposes no ledger for that.',
          PROPOSAL_NOT_FOUND: 'That proposal was already decided, or does not exist.',
          IMPORT_BAD_SCHEMA: 'Not a dsh-memento memory-export-v1 envelope.',
          IMPORT_BAD_ENTRY: 'An entry is missing track / scope / text.',
          BAD_JSON: 'That is not valid JSON.',
          ADAPTER_NOT_FOUND: 'No such adapter.',
          ADAPTER_PAYLOAD: 'The payload does not match that adapter\u2019s format.',
          ADAPTERS_UNAVAILABLE: 'This composition mounted no adapter registry.',
          MISSING_TAB_HEADER: 'The request carried no origin marker, so the route refused it.',
          BODY_TOO_LARGE: 'The payload exceeded the request-body cap.',
          INVALID_INPUT: 'Invalid argument.',
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
.mtt-entry { padding: 7px 9px; border-radius: 9px; margin-bottom: 5px; display: flex; gap: 8px;
  background: var(--dsw-alias-bg-layer-2, #f7f7f8); }
.mtt-entry.picked { outline: 1px solid var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-entry.focus { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #4d6bfe); }
/* The checkbox column is fixed and the text column absorbs the rest, so a long
   entry can never push the row wider than the conversation column. */
.mtt-entry > .pick { flex: none; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.mtt-entry-main { flex: 1 1 auto; min-width: 0; }
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
/* Rows wrap rather than shrink: a select plus three buttons on one line is wider
   than a narrow conversation column, and flex items never go below min-content. */
.mtt-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.mtt-row > label { color: var(--dsw-alias-label-secondary, #5b5b5b); }
.mtt-sub { display: grid; gap: 8px; margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.mtt-sub > h5 { margin: 0; font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5b5b5b); }
.mtt-file { min-width: 0; max-width: 100%; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b5b5b); }
.mtt-hint { margin: 0 0 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.mtt-sel { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; padding: 8px 10px;
  border-radius: 10px; border: 1px solid var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-bg-layer-2, #f4f4f5); }
.mtt-sel > strong { font-weight: 600; }
.mtt-sel .mtt-hint { margin: 0; flex: 1 1 12rem; }
.mtt-adapter { padding: 7px 9px; border-radius: 9px; margin-bottom: 6px;
  background: var(--dsw-alias-bg-layer-2, #f7f7f8); }
.mtt-adapter .id { font-weight: 600; }
.mtt-adapter .d { margin-top: 3px; color: var(--dsw-alias-label-secondary, #5b5b5b); }
.mtt-adapter .f { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
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
          error.status = response.status
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
          // Multi-select for `consolidate`. Kept as entry ids and matched against
          // the live list on every render, so a refresh that drops an entry
          // cannot leave a phantom in the merge.
          selected: /** @type {string[]} */ ([]),
          merging: false,
          mergeDraft: '',
          // Data card. `exportText` is the last fetched payload, held in state so
          // a re-render (which rebuilds the card's DOM) cannot lose it.
          exportAdapterId: '',
          exportText: '',
          exportName: '',
          importAdapterId: '',
          importText: '',
          importName: '',
          overrideKeys: false,
          busy: false,
        }

        const anchor = () => sessionHeader(ctx, sessionId)

        // The host paints its transcript width handles — two absolutely
        // positioned col-resize strips plus a glow line — whenever the session
        // is active, whichever view tab is selected (ConversationRoot gates
        // them on `phase === 'active'` alone, though the comment says
        // "only while a transcript is on screen"). They size the transcript's
        // content column, which this view does not have, so on this tab they
        // draw a stray draggable line across the content. Hide them for exactly
        // as long as this tab is mounted. `data-width-handle` is the stable hook
        // the host stamps on each strip — the class name is a hashed CSS module,
        // this attribute is not.
        const widthHandleHider = document.createElement('style')
        widthHandleHider.textContent = '[data-width-handle] { display: none !important; }'
        document.head.appendChild(widthHandleHider)

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

        /** Run one write and reload on success. Returns whether it landed. */
        async function write(payload, okMessage) {
          if (state.saving) return false
          state.saving = true
          saveBtn.disabled = true
          say(t('approving'), false)
          try {
            const header = anchor()
            await api(ROUTE_WRITE, {
              method: 'POST',
              headers: TAB_HEADERS,
              body: JSON.stringify({ ...payload, sessionId, ...header }),
            }, abort.signal)
            if (abort.signal.aborted) return false
            state.saving = false
            saveBtn.disabled = false
            await refresh()
            say(okMessage, false)
            return true
          } catch (error) {
            if (abort.signal.aborted) return false
            state.saving = false
            saveBtn.disabled = false
            say(describeError(t, error), true)
            return false
          }
        }

        /** Decide one proposal. */
        async function decide(id, decision) {
          say(t('approving'), false)
          try {
            const header = anchor()
            await api(ROUTE_DECIDE, {
              method: 'POST',
              headers: TAB_HEADERS,
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

        /** The live entries behind the current selection, in list order. */
        function selectedEntries() {
          const entries = Array.isArray(state.data?.entries) ? state.data.entries : []
          return entries.filter((entry) => state.selected.includes(entry.id))
        }

        /**
         * The merge ceiling, read live from the host's read model so the tab
         * cannot drift from the seam's own limit.
         * @returns {number} maximum matches in one `consolidate`.
         */
        function maxMerge() {
          const reported = state.data?.maxMergeMatches
          return typeof reported === 'number' && reported > 0 ? reported : MAX_MERGE_FALLBACK
        }

        /**
         * Whether the selection can be merged, and why not when it cannot.
         * @returns {{ok: boolean, reason: string, track: string, scope: string}} verdict.
         */
        function mergeVerdict() {
          const picked = selectedEntries()
          const track = picked.length > 0 ? picked[0].track : ''
          const scope = picked.length > 0 ? picked[0].scope : ''
          if (picked.length < 2) return { ok: false, reason: '', track, scope }
          if (picked.length > maxMerge()) return { ok: false, reason: `${t('mergeTooMany')} (${maxMerge()})`, track, scope }
          const mixed = picked.some((entry) => entry.track !== track || entry.scope !== scope)
          if (mixed) return { ok: false, reason: t('mergeMixed'), track, scope }
          return { ok: true, reason: '', track, scope }
        }

        /** Fetch the export payload for the selected format. */
        async function runExport() {
          if (state.busy) return
          state.busy = true
          say(t('approving'), false)
          try {
            const query = state.exportAdapterId.length > 0
              ? `?adapterId=${encodeURIComponent(state.exportAdapterId)}`
              : ''
            const payload = await api(`${ROUTE_EXPORT}${query}`, { headers: TAB_HEADERS_GET }, abort.signal)
            if (abort.signal.aborted) return
            state.busy = false
            state.exportText = typeof payload.text === 'string' ? payload.text : ''
            state.exportName = typeof payload.filename === 'string' ? payload.filename : 'dsh-memento-export.txt'
            render()
            say(`${t('exportRun')} · ${payload.count ?? 0} ${t('entriesUnit')}`, false)
          } catch (error) {
            if (abort.signal.aborted) return
            state.busy = false
            say(describeError(t, error), true)
          }
        }

        /** Hand the last export to the browser as a file download. */
        function downloadExport() {
          if (state.exportText.length === 0) return
          const blob = new Blob([state.exportText], { type: 'application/json;charset=utf-8' })
          const href = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = href
          link.download = state.exportName
          document.body.appendChild(link)
          link.click()
          link.remove()
          // Revoke on the next tick: the click has already been dispatched.
          setTimeout(() => URL.revokeObjectURL(href), 0)
        }

        /** Copy the last export, falling back to a manual selection. */
        async function copyExport() {
          if (state.exportText.length === 0) return
          try {
            await navigator.clipboard.writeText(state.exportText)
            say(t('copied'), false)
          } catch {
            const field = root.querySelector('.mtt-export-text')
            if (field !== null) {
              field.focus()
              field.select()
            }
            say(t('copyFailed'), true)
          }
        }

        /** Read one chosen file into the import buffer. */
        async function pickFile(file) {
          if (file.size > MAX_PAYLOAD_BYTES) {
            say(t('importTooBig'), true)
            return
          }
          try {
            state.importText = await file.text()
            state.importName = file.name
            render()
            say(`${t('importFile')} · ${file.name}`, false)
          } catch (error) {
            say(describeError(t, error), true)
          }
        }

        /**
         * The confirmation shown before a batch write.
         *
         * For a memento envelope the entry count and target layers are known
         * locally; for an adapter payload only the host can decode it, so the
         * dialog says what will happen without inventing a count.
         */
        function describeImport() {
          if (state.importAdapterId.length > 0) {
            return `${t('importConfirmCount')} ${state.importAdapterId} (${t('importAdapterLabel')})?`
          }
          try {
            const parsed = JSON.parse(state.importText)
            const rows = Array.isArray(parsed?.entries) ? parsed.entries : null
            if (rows === null) return t('importConfirm')
            const layers = [...new Set(rows.map((row) => `${row?.track ?? '?'}/${row?.scope ?? '?'}`))]
            return `${t('importConfirmCount')} ${rows.length} ${t('entriesUnit')} → ${layers.join(', ')}`
          } catch {
            return t('importConfirm')
          }
        }

        /** Seed one batch through the same gate a single write uses. */
        async function runImport() {
          if (state.busy || state.saving) return
          if (state.importText.trim().length === 0) {
            say(t('importNothing'), true)
            return
          }
          if (!window.confirm(describeImport())) return
          state.busy = true
          saveBtn.disabled = true
          say(t('approving'), false)
          try {
            const header = anchor()
            const payload = await api(ROUTE_IMPORT, {
              method: 'POST',
              headers: TAB_HEADERS,
              body: JSON.stringify({
                payload: state.importText,
                ...(state.importAdapterId.length > 0 ? { adapterId: state.importAdapterId } : {}),
                overrideKeys: state.overrideKeys,
                sessionId,
                ...header,
              }),
            }, abort.signal)
            if (abort.signal.aborted) return
            state.busy = false
            saveBtn.disabled = false
            state.importText = ''
            state.importName = ''
            await refresh()
            render()
            say(`${t('imported')} ${payload.added ?? 0} ${t('entriesUnit')}`, false)
          } catch (error) {
            if (abort.signal.aborted) return
            state.busy = false
            saveBtn.disabled = false
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
          const picked = state.selected.includes(entry.id)
          return `<div class="mtt-entry${isFocus && entry.scope === 'workspace' ? ' focus' : ''}${picked ? ' picked' : ''}" data-idx="${index}">
  <input type="checkbox" class="pick" data-pick="${esc(entry.id)}"${picked ? ' checked' : ''} title="${esc(t('pick'))}" aria-label="${esc(t('pick'))}" />
  <div class="mtt-entry-main">
    <div class="t">${esc(entry.text) || esc(t('untitled'))}</div>
    <div class="m">${meta.join('')}
      <button data-edit="${esc(entry.id)}">${esc(t('edit'))}</button>
      <button class="mtt-danger" data-remove="${esc(entry.id)}">${esc(t('remove'))}</button>
    </div>
    ${draft}
  </div>
</div>`
        }

        /** The multi-select action bar, shown while anything is picked. */
        function selectionHtml() {
          const picked = selectedEntries()
          if (picked.length === 0 && !state.merging) return ''
          const verdict = mergeVerdict()
          const bar = `<div class="mtt-sel">
  <strong>${esc(t('selected'))} ${picked.length} ${esc(t('entriesUnit'))}</strong>
  <button class="mtt-btn mtt-primary mtt-merge"${verdict.ok ? '' : ' disabled'}>${esc(t('merge'))}</button>
  <button class="mtt-btn mtt-clear">${esc(t('clearSelection'))}</button>
  ${verdict.reason.length > 0
    ? `<span class="mtt-hint">${esc(verdict.reason)}</span>`
    : `<span class="mtt-hint">${esc(t('mergeIntro'))}</span>`}
</div>`

          if (!state.merging) return bar
          const originals = picked.map((entry) => entry.text).join('\n')
          return `${bar}<div class="mtt-card">
  <h4>${esc(t('merge'))} · ${esc(groupTitle(t, verdict.track, verdict.scope))}</h4>
  <div class="mtt-empty">${esc(originals)}</div>
  <textarea class="mtt-edit mtt-merge-text" rows="4" placeholder="${esc(t('mergePlaceholder'))}">${esc(state.mergeDraft)}</textarea>
  <div class="mtt-edit-row">
    <button class="mtt-btn mtt-primary mtt-merge-go"${verdict.ok ? '' : ' disabled'}>${esc(t('mergeSubmit'))}</button>
    <button class="mtt-btn mtt-merge-cancel">${esc(t('cancel'))}</button>
  </div>
</div>`
        }

        /** One `<select>` of registered adapters, with a leading "raw" option. */
        function adapterOptionsHtml(selected, rawLabel) {
          const adapters = Array.isArray(state.data?.adapters) ? state.data.adapters : []
          const raw = `<option value=""${selected === '' ? ' selected' : ''}>${esc(rawLabel)}</option>`
          return raw + adapters.map((adapter) => `<option value="${esc(adapter.id)}"${selected === adapter.id ? ' selected' : ''}>${esc(adapter.id)}</option>`).join('')
        }

        /** The data card: export on the left of the divider, import under it. */
        function dataHtml() {
          const data = state.data
          const total = typeof data.total === 'number' ? data.total : 0
          const limit = typeof data.maxImportEntries === 'number' ? data.maxImportEntries : ''
          const canExport = data.exportAvailable === true
          const hasExport = state.exportText.length > 0

          const exportRow = canExport
            ? `<div class="mtt-row">
    <label>${esc(t('exportAdapterLabel'))}</label>
    <select class="mtt-select mtt-export-adapter">${adapterOptionsHtml(state.exportAdapterId, t('exportMemento'))}</select>
    <button class="mtt-btn mtt-export-run">${esc(t('exportRun'))}</button>
    <button class="mtt-btn mtt-copy"${hasExport ? '' : ' disabled'}>${esc(t('copy'))}</button>
    <button class="mtt-btn mtt-download"${hasExport ? '' : ' disabled'}>${esc(t('download'))}</button>
  </div>
  ${hasExport
    ? `<textarea class="mtt-edit mtt-export-text" rows="3" readonly>${esc(state.exportText)}</textarea>
       <p class="mtt-hint">${esc(state.exportName)}</p>`
    : `<p class="mtt-hint">${esc(total === 0 ? t('exportEmpty') : t('exportRun'))}</p>`}`
            : `<p class="mtt-hint">${esc(t('exportUnavailable'))}</p>`

          return `<div class="mtt-card">
  <h4>${esc(t('data'))}<span>${total} ${esc(t('entriesUnit'))}</span></h4>
  <div class="mtt-sub"><h5>${esc(t('exportTitle'))}</h5>${exportRow}</div>
  <div class="mtt-sub">
    <h5>${esc(t('importTitle'))}${limit === '' ? '' : ` · ${esc(t('importLimit'))} ${esc(limit)}`}</h5>
    <div class="mtt-row">
      <label>${esc(t('importAdapterLabel'))}</label>
      <select class="mtt-select mtt-import-adapter">${adapterOptionsHtml(state.importAdapterId, t('exportMemento'))}</select>
      <input type="file" class="mtt-file" accept=".json,.md,.txt,application/json,text/markdown,text/plain" />
    </div>
    <textarea class="mtt-edit mtt-import-text" rows="3" placeholder="${esc(t('importPlaceholder'))}">${esc(state.importText)}</textarea>
    <div class="mtt-row">
      <label class="mtt-check"><input type="checkbox" class="mtt-override"${state.overrideKeys ? ' checked' : ''} />${esc(t('importOverride'))}</label>
      <button class="mtt-btn mtt-primary mtt-import-run">${esc(t('importRun'))}</button>
      ${state.importName.length > 0 ? `<span class="mtt-hint">${esc(state.importName)}</span>` : ''}
    </div>
  </div>
</div>`
        }

        /** The adapter registry: what can be imported from and exported to. */
        function adaptersHtml() {
          const data = state.data
          if (data.adaptersAvailable !== true) {
            return `<div class="mtt-card"><h4>${esc(t('adapters'))}</h4><div class="mtt-empty">${esc(t('adaptersUnavailable'))}</div></div>`
          }
          const adapters = Array.isArray(data.adapters) ? data.adapters : []
          if (adapters.length === 0) {
            return `<div class="mtt-card"><h4>${esc(t('adapters'))}</h4><div class="mtt-empty">${esc(t('noAdapters'))}</div></div>`
          }
          return `<div class="mtt-card">
  <h4>${esc(t('adapters'))}<span>${adapters.length}</span></h4>
  ${adapters.map((adapter) => `<div class="mtt-adapter">
    <div><span class="id">${esc(adapter.id)}</span> · ${esc(adapter.name)} v${esc(adapter.version)}</div>
    <div class="d">${esc(adapter.description)}</div>
    <div class="f">import: ${esc((adapter.importFormats ?? []).join(', '))} · export: ${esc(adapter.exportFormat ?? '')}</div>
  </div>`).join('')}
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

          // Data and adapters sit above the audit tail: the audit is a log and
          // can run to dozens of rows, so nothing actionable belongs below it.
          cards.push(dataHtml())
          cards.push(adaptersHtml())

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

          body.innerHTML = selectionHtml() + cards.join('')
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
            .then((ok) => { if (ok === true) newText.value = '' })
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
          if (dismissId !== null) { void decide(dismissId, 'dismiss'); return }

          // ── multi-select merge ────────────────────────────────────────────
          if (button.classList.contains('mtt-clear')) {
            state.selected = []
            state.merging = false
            state.mergeDraft = ''
            render()
            return
          }
          if (button.classList.contains('mtt-merge-cancel')) {
            state.merging = false
            render()
            return
          }
          if (button.classList.contains('mtt-merge')) {
            // Seed the editor with the originals joined by newlines: the merge
            // still needs a human-authored text, this is only a starting point.
            state.merging = true
            state.mergeDraft = selectedEntries().map((entry) => entry.text).join('\n')
            render()
            return
          }
          if (button.classList.contains('mtt-merge-go')) {
            const verdict = mergeVerdict()
            const picked = selectedEntries()
            const text = state.mergeDraft.trim()
            if (!verdict.ok || text.length === 0) return
            void write({
              op: 'consolidate',
              track: verdict.track,
              scope: verdict.scope,
              matches: picked.map((entry) => entry.text),
              text,
            }, t('merged')).then((ok) => {
              if (ok) {
                state.selected = []
                state.merging = false
                state.mergeDraft = ''
                render()
              }
            })
            return
          }

          // ── data card ─────────────────────────────────────────────────────
          if (button.classList.contains('mtt-export-run')) { void runExport(); return }
          if (button.classList.contains('mtt-copy')) { void copyExport(); return }
          if (button.classList.contains('mtt-download')) { downloadExport(); return }
          if (button.classList.contains('mtt-import-run')) { void runImport() }
        })

        // Selections and the sticky data-card inputs live inside the re-rendered
        // body, so their values are mirrored into `state` on the way in and
        // re-emitted by `render()` — a refresh can then never lose a paste.
        body.addEventListener('change', (event) => {
          const target = /** @type {HTMLElement} */ (event.target)
          if (target.classList.contains('pick')) {
            const id = target.getAttribute('data-pick')
            if (id === null) return
            const element = /** @type {HTMLInputElement} */ (target)
            state.selected = element.checked
              ? [...state.selected, id]
              : state.selected.filter((candidate) => candidate !== id)
            render()
            return
          }
          if (target.classList.contains('mtt-export-adapter')) {
            state.exportAdapterId = /** @type {HTMLSelectElement} */ (target).value
            return
          }
          if (target.classList.contains('mtt-import-adapter')) {
            state.importAdapterId = /** @type {HTMLSelectElement} */ (target).value
            return
          }
          if (target.classList.contains('mtt-override')) {
            state.overrideKeys = /** @type {HTMLInputElement} */ (target).checked
            return
          }
          if (target.classList.contains('mtt-file')) {
            const file = /** @type {HTMLInputElement} */ (target).files?.[0]
            if (file !== undefined) void pickFile(file)
          }
        })

        body.addEventListener('input', (event) => {
          const target = /** @type {HTMLElement} */ (event.target)
          // Deliberately no render() here: rebuilding the body on every keystroke
          // would drop the caret out of the field being typed into.
          if (target.classList.contains('mtt-merge-text')) {
            state.mergeDraft = /** @type {HTMLTextAreaElement} */ (target).value
            return
          }
          if (target.classList.contains('mtt-import-text')) {
            state.importText = /** @type {HTMLTextAreaElement} */ (target).value
          }
        })

        void refresh()

        return () => {
          if (searchTimer !== null) clearTimeout(searchTimer)
          abort.abort()
          widthHandleHider.remove()
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
