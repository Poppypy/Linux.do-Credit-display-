// ==UserScript==
// @name         Linux.do Credit display
// @namespace    https://tampermonkey.net/
// @version      0.2.9
// @description  每天最多完整刷新一次 credit.linux.do 排行榜并缓存；支持断点续抓(指定页继续)、翻页、失败重试、429 等30s重试；在 linux.do 用户名旁显示 available_balance；带可折叠控制面板与缓存排行查看。
// @author       popy
// @match        https://linux.do/*
// @match        https://credit.linux.do/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      credit.linux.do
// @connect      github.com
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Poppypy/Linux.do-Credit-display-/main/Linux.do-Credit-display.user.js
// @downloadURL  https://raw.githubusercontent.com/Poppypy/Linux.do-Credit-display-/main/Linux.do-Credit-display.user.js
// @icon         https://linux.do/uploads/default/optimized/4X/6/a/6/6a6affc7b1ce8140279e959d32671304db06d5ab_2_180x180.png
// ==/UserScript==

(function () {
  'use strict';

  /***********************
   * 0) 基础常量/工具
   ***********************/
  const ORIGIN_LINUX = 'https://linux.do';
  const ORIGIN_CREDIT = 'https://credit.linux.do';
  const API_LEADERBOARD = `${ORIGIN_CREDIT}/api/v1/leaderboard`;

  const STORE = {
    meta: 'ldc_lb_meta_v2',
    list: 'ldc_lb_list_v2',          // [[id, username, balanceStr], ...] 按排名顺序
    idxById: 'ldc_lb_idx_id_v2',     // { "9797": 8, ... } => index in list
    idxByName: 'ldc_lb_idx_name_v2', // { "zh-heng": 8, ... } => index in list
    settings: 'ldc_lb_settings_v2',
    panel: 'ldc_lb_panel_v2',
  };

  const DEFAULT_SETTINGS = {
    pageSize: 50,
    delayMs: 1500,          // 每页基础间隔
    jitterMs: 900,          // 抖动
    retryCount: 3,          // 普通错误重试次数
    retryBaseDelayMs: 1500, // 普通错误退避基数
    saveEveryPages: 5,      // 每抓N页落盘一次
    injectEnabled: true,

    // ✅429：限速等待
    retry429DelayMs: 30000,       // 30 秒
    max429RetriesPerPage: 50,     // 单页最多等 50 次（防止无穷等待）
  };

  const TAB_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const LOCK_KEY = 'ldc_lb_fetch_lock_v2';
  const LOCK_TTL = 60 * 1000; // 1 分钟
  const LOCK_HEARTBEAT = 15 * 1000;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function dayKeyLocal(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function formatBalance(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return String(val ?? '');
    const s = n.toFixed(2)
      .replace(/\.00$/, '')
      .replace(/(\.\d)0$/, '$1');
    return s;
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /*******************************************************
   * 1) credit.linux.do：桥接端（同域 fetch 自动带 cookie）
   *******************************************************/
  if (location.origin === ORIGIN_CREDIT) {
    window.addEventListener('message', async (e) => {
      if (e.origin !== ORIGIN_LINUX) return;
      if (!e.data || e.data.type !== 'ldc-lb-request') return;

      const { requestId, url, method = 'GET' } = e.data;

      try {
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });

        let data = null;
        try {
          data = await res.json();
        } catch {
          const txt = await res.text().catch(() => '');
          data = { _error: 'JSON_PARSE_FAILED', _raw: txt.slice(0, 300) };
        }

        window.parent?.postMessage({
          type: 'ldc-lb-response',
          requestId,
          status: res.status,
          data
        }, ORIGIN_LINUX);

      } catch (err) {
        window.parent?.postMessage({
          type: 'ldc-lb-response',
          requestId,
          status: 0,
          data: { _error: 'NETWORK_ERROR', message: String(err) }
        }, ORIGIN_LINUX);
      }
    });

    return;
  }

  if (location.origin !== ORIGIN_LINUX) return;

  /***********************
   * 2) 存储读取
   ***********************/
  function loadSettings() {
    const s = GM_getValue(STORE.settings, null);
    return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  }
  function saveSettings(s) { GM_setValue(STORE.settings, s); }

  function loadMeta() {
    const m = GM_getValue(STORE.meta, null);
    return (m && typeof m === 'object') ? m : {
      lastFullFetchDay: null,
      lastFullFetchTs: 0,
      total: 0,
      pages: 0,
      pageSize: DEFAULT_SETTINGS.pageSize,
      fetchedPages: 0,    // 已成功抓取到的最大页
      fetchedItems: 0,    // 已写入条数
      partial: false,     // 是否未完成
      lastError: '',
    };
  }
  function saveMeta(m) { GM_setValue(STORE.meta, m); }

  function loadCache() {
    const list = GM_getValue(STORE.list, null);
    const idxById = GM_getValue(STORE.idxById, null);
    const idxByName = GM_getValue(STORE.idxByName, null);
    return {
      list: Array.isArray(list) ? list : [],
      idxById: (idxById && typeof idxById === 'object') ? idxById : {},
      idxByName: (idxByName && typeof idxByName === 'object') ? idxByName : {},
    };
  }
  function saveCache({ list, idxById, idxByName }) {
    GM_setValue(STORE.list, list);
    GM_setValue(STORE.idxById, idxById);
    GM_setValue(STORE.idxByName, idxByName);
  }

  let settings = loadSettings();
  let meta = loadMeta();
  let cache = loadCache();

  /***********************
   * 3) 互斥锁（多标签页互斥抓取）
   ***********************/
  function readLock() {
    const raw = localStorage.getItem(LOCK_KEY);
    const j = raw ? safeJsonParse(raw) : null;
    return j && typeof j === 'object' ? j : null;
  }

  function writeLock(obj) {
    try { localStorage.setItem(LOCK_KEY, JSON.stringify(obj)); } catch {}
  }

  function acquireLock() {
    const now = Date.now();
    const lock = readLock();
    if (lock && lock.tabId && lock.ts && (now - lock.ts) < LOCK_TTL && lock.tabId !== TAB_ID) {
      return false;
    }
    writeLock({ tabId: TAB_ID, ts: now });
    return true;
  }

  function heartbeatLock() {
    const lock = readLock();
    if (!lock || lock.tabId !== TAB_ID) return;
    writeLock({ tabId: TAB_ID, ts: Date.now() });
  }

  function releaseLock() {
    const lock = readLock();
    if (lock && lock.tabId === TAB_ID) {
      try { localStorage.removeItem(LOCK_KEY); } catch {}
    }
  }

  /***********************
   * 4) Bridge：linux.do -> (iframe) credit.linux.do
   ***********************/
  let bridgeFrame = null;
  let bridgeReady = null;
  let bridgeReqId = 0;
  const pending = new Map();

  function initBridge() {
    if (bridgeFrame) return;

    window.addEventListener('message', (e) => {
      if (e.origin !== ORIGIN_CREDIT) return;
      if (!e.data || e.data.type !== 'ldc-lb-response') return;

      const { requestId, status, data } = e.data;
      const resolver = pending.get(requestId);
      if (resolver) {
        pending.delete(requestId);
        resolver({ status, data });
      }
    });

    bridgeFrame = document.createElement('iframe');
    bridgeFrame.src = `${ORIGIN_CREDIT}/home`;
    bridgeFrame.style.cssText = 'width:0;height:0;opacity:0;position:absolute;left:-9999px;top:-9999px;border:0;pointer-events:none;';
    document.body.appendChild(bridgeFrame);

    bridgeReady = new Promise((resolve) => {
      const t = setTimeout(resolve, 6000);
      bridgeFrame.onload = () => {
        clearTimeout(t);
        setTimeout(resolve, 250);
      };
    });
  }

  async function bridgeRequest(url, method = 'GET', timeoutMs = 15000) {
    initBridge();
    await bridgeReady;

    if (!bridgeFrame || !bridgeFrame.contentWindow) {
      return { status: 0, data: { _error: 'BRIDGE_NOT_READY' } };
    }

    return new Promise((resolve) => {
      const id = ++bridgeReqId;

      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 0, data: { _error: 'TIMEOUT' } });
      }, timeoutMs);

      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });

      try {
        bridgeFrame.contentWindow.postMessage(
          { type: 'ldc-lb-request', requestId: id, url, method },
          ORIGIN_CREDIT
        );
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ status: 0, data: { _error: 'POSTMESSAGE_FAILED', message: String(e) } });
      }
    });
  }

  async function gmRequest(url, timeoutMs = 15000) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        withCredentials: true,
        timeout: timeoutMs,
        headers: {
          'Accept': 'application/json',
          'Referer': `${ORIGIN_CREDIT}/leaderboard`
        },
        onload: (r) => {
          const j = safeJsonParse(r.responseText);
          resolve({ status: r.status, data: j || { _error: 'JSON_PARSE_FAILED', _raw: (r.responseText || '').slice(0, 300) } });
        },
        onerror: () => resolve({ status: 0, data: { _error: 'NETWORK_ERROR' } }),
        ontimeout: () => resolve({ status: 0, data: { _error: 'TIMEOUT' } }),
      });
    });
  }

  async function apiGet(url) {
    const r1 = await bridgeRequest(url, 'GET');
    if (r1 && r1.status === 200 && r1.data && !r1.data._error) return r1;
    return await gmRequest(url);
  }

  function unwrapLeaderboardResponse(resp) {
    if (!resp || typeof resp !== 'object') return null;
    const d = resp.data;
    if (d && Array.isArray(d.items)) return d;
    if (Array.isArray(resp.items)) return resp;
    return null;
  }

  /***********************
   * 5) 控制面板 UI
   ***********************/
  GM_addStyle(`
    .ldc-lb-panel{position:fixed;right:14px;bottom:14px;z-index:999999;background:var(--secondary, #111);color:var(--primary, #fff);
      border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:360px;max-height:72vh;overflow:hidden;font-size:12px}
    .ldc-lb-panel.light{background:#fff;color:#111;border:1px solid rgba(0,0,0,.12)}
    .ldc-lb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 10px;border-bottom:1px solid rgba(255,255,255,.10)}
    .ldc-lb-panel.light .ldc-lb-header{border-bottom:1px solid rgba(0,0,0,.10)}
    .ldc-lb-title{font-weight:700}
    .ldc-lb-actions{display:flex;gap:6px;align-items:center}
    .ldc-btn{cursor:pointer;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:inherit;border-radius:8px;padding:6px 8px;font-size:12px}
    .ldc-lb-panel.light .ldc-btn{border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.05)}
    .ldc-btn:disabled{opacity:.5;cursor:not-allowed}
    .ldc-lb-body{padding:10px;overflow:auto;max-height:calc(72vh - 46px)}
    .ldc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
    .ldc-kv{opacity:.9}
    .ldc-muted{opacity:.65}
    .ldc-progress{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace}
    .ldc-hr{height:1px;background:rgba(255,255,255,.12);margin:10px 0}
    .ldc-lb-panel.light .ldc-hr{background:rgba(0,0,0,.12)}
    .ldc-input{box-sizing:border-box;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;padding:7px 9px;font-size:12px}
    .ldc-lb-panel.light .ldc-input{border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.04)}
    .ldc-list{margin-top:8px;border:1px solid rgba(255,255,255,.12);border-radius:10px;overflow:hidden}
    .ldc-lb-panel.light .ldc-list{border:1px solid rgba(0,0,0,.12)}
    .ldc-item{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px 9px;border-top:1px solid rgba(255,255,255,.08)}
    .ldc-item:first-child{border-top:none}
    .ldc-rank{min-width:54px;opacity:.8}
    .ldc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ldc-val{font-weight:700}
    .ldc-toast{position:fixed;right:14px;bottom:92px;z-index:999999;background:rgba(0,0,0,.78);color:#fff;padding:10px 12px;border-radius:10px;max-width:420px;font-size:12px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
    .ldc-badge{display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:2px 6px;border-radius:999px;font-size:11px;line-height:1.4;white-space:nowrap;
      border:1px solid rgba(0,0,0,.08);background:rgba(255,215,0,.18)}
    .ldc-badge .ldc-coin{opacity:.85}
  `);

  let panelEl = null;
  let bodyEl = null;
  let statusEl = null;
  let progressEl = null;
  let searchInputEl = null;
  let searchResultEl = null;
  let injectToggleEl = null;

  let rankListEl = null;
  let rankPageEl = null;
  let rankPrevBtn = null;
  let rankNextBtn = null;

  let startPageEl = null;

  let running = false;
  let stopFlag = false;
  let lockTimer = null;

  const panelState = (GM_getValue(STORE.panel, null) && typeof GM_getValue(STORE.panel, null) === 'object')
    ? GM_getValue(STORE.panel, null)
    : { collapsed: false, light: false, rankPage: 1 };

  function savePanelState() { GM_setValue(STORE.panel, panelState); }

  function toast(msg, ms = 3000) {
    const t = document.createElement('div');
    t.className = 'ldc-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function humanTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch { return '—'; }
  }

  function canFetchToday() {
    return meta.lastFullFetchDay !== dayKeyLocal();
  }

  function createPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'ldc-lb-panel' + (panelState.light ? ' light' : '');
    panelEl.innerHTML = `
      <div class="ldc-lb-header">
        <div class="ldc-lb-title">💳 Credit 排行榜缓存</div>
        <div class="ldc-lb-actions">
          <button class="ldc-btn" data-act="theme" title="切换主题">🌓</button>
          <button class="ldc-btn" data-act="collapse" title="折叠/展开">${panelState.collapsed ? '➕' : '➖'}</button>
        </div>
      </div>
      <div class="ldc-lb-body" style="${panelState.collapsed ? 'display:none' : ''}">
        <div class="ldc-row">
          <button class="ldc-btn" data-act="fetch">开始获取</button>
          <button class="ldc-btn" data-act="force">强制刷新</button>
          <button class="ldc-btn" data-act="stop" disabled>停止</button>
          <button class="ldc-btn" data-act="clear">清空缓存</button>
        </div>

        <!-- ✅续传：指定页继续 -->
        <div class="ldc-row">
          <span class="ldc-muted">从第</span>
          <input class="ldc-input" data-k="startPage" style="width:90px" />
          <span class="ldc-muted">页开始</span>
          <button class="ldc-btn" data-act="resume">继续获取</button>
        </div>

        <div class="ldc-row ldc-kv">
          <span>缓存条数：</span><b data-k="count">0</b>
          <span class="ldc-muted">｜最后更新：</span><span data-k="time">—</span>
        </div>

        <div class="ldc-row ldc-kv">
          <span>今日状态：</span><b data-k="today">—</b>
          <span class="ldc-muted">｜注入：</span>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" data-k="inject" style="transform:translateY(1px)"/>
            <span class="ldc-muted">显示余额</span>
          </label>
        </div>

        <div class="ldc-row ldc-progress" data-k="progress">就绪</div>
        <div class="ldc-row ldc-muted" data-k="status"></div>

        <div class="ldc-hr"></div>

        <div class="ldc-row" style="margin-bottom:4px"><b>🔎 搜索用户</b></div>
        <input class="ldc-input" data-k="search" style="width:100%" placeholder="输入 user_id 或 username（不区分大小写）"/>
        <div class="ldc-row ldc-kv" data-k="searchResult"></div>

        <div class="ldc-hr"></div>

        <div class="ldc-row" style="margin-bottom:4px"><b>🏆 缓存排行（分页查看）</b></div>
        <div class="ldc-row">
          <button class="ldc-btn" data-k="rankPrev">上一页</button>
          <span class="ldc-muted" data-k="rankPageText">—</span>
          <button class="ldc-btn" data-k="rankNext">下一页</button>
        </div>
        <div class="ldc-list" data-k="rankList"></div>

        <div class="ldc-hr"></div>

<div class="ldc-row" style="margin-bottom:4px"><b>⚙️ 抓取参数</b></div>

<div class="ldc-row">
  <span class="ldc-muted">每页间隔(ms)：</span>
  <input class="ldc-input" data-k="delay" style="width:110px" />
</div>

<div class="ldc-row">
  <span class="ldc-muted">抖动(ms)：</span>
  <input class="ldc-input" data-k="jitter" style="width:110px" />
</div>

<div class="ldc-row">
  <span class="ldc-muted">重试次数：</span>
  <input class="ldc-input" data-k="retry" style="width:110px" />
</div>

<div class="ldc-row">
  <span class="ldc-muted">落盘频率(页)：</span>
  <input class="ldc-input" data-k="saveEvery" style="width:110px" />
</div>

<div class="ldc-row">
  <span class="ldc-muted">429等待(ms)：</span>
  <input class="ldc-input" data-k="retry429" style="width:110px" />
</div>

<div class="ldc-row">
  <span class="ldc-muted">429上限/页：</span>
  <input class="ldc-input" data-k="max429" style="width:110px" />
</div>
<div class="ldc-row">
  <button class="ldc-btn" data-act="support5">支持 5LDC</button>
  <button class="ldc-btn" data-act="support10">支持 10LDC</button>
  <button class="ldc-btn" data-act="support20">支持 20LDC</button>
</div>
<div class="ldc-row">
  <button class="ldc-btn" data-act="saveSettings">保存设置</button>
  <span class="ldc-muted">（太快可能触发 CF/429，建议间隔 ≥ 1200ms）</span>


</div>


      </div>
    `;
    document.body.appendChild(panelEl);

    bodyEl = panelEl.querySelector('.ldc-lb-body');
    statusEl = panelEl.querySelector('[data-k="status"]');
    progressEl = panelEl.querySelector('[data-k="progress"]');
    searchInputEl = panelEl.querySelector('[data-k="search"]');
    searchResultEl = panelEl.querySelector('[data-k="searchResult"]');
    startPageEl = panelEl.querySelector('input[data-k="startPage"]');

    injectToggleEl = panelEl.querySelector('input[data-k="inject"]');
    injectToggleEl.checked = !!settings.injectEnabled;

    rankListEl = panelEl.querySelector('[data-k="rankList"]');
    rankPageEl = panelEl.querySelector('[data-k="rankPageText"]');
    rankPrevBtn = panelEl.querySelector('[data-k="rankPrev"]');
    rankNextBtn = panelEl.querySelector('[data-k="rankNext"]');

    // 绑定事件：按钮
    panelEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const act = btn.getAttribute('data-act');

      if (act === 'collapse') {
        panelState.collapsed = !panelState.collapsed;
        savePanelState();
        btn.textContent = panelState.collapsed ? '➕' : '➖';
        bodyEl.style.display = panelState.collapsed ? 'none' : '';
        return;
      }
      if (act === 'theme') {
        panelState.light = !panelState.light;
        savePanelState();
        panelEl.classList.toggle('light', panelState.light);
        return;
      }
      if (act === 'fetch') { startFetch({ force: false, resume: false, startPage: 1 }); return; }
      if (act === 'force') {
        if (confirm('确定要强制刷新吗？这会忽略“每天一次”的限制，并重新抓取全部页面（可能触发限速）。')) {
          startFetch({ force: true, resume: false, startPage: 1 });
        }
        return;
      }
      if (act === 'resume') {
        const sp = Number(startPageEl?.value);
        startFetch({ force: false, resume: true, startPage: sp });
        return;
      }
      if (act === 'stop') { stopFetch(); return; }
      if (act === 'clear') {
        if (confirm('确定清空缓存吗？')) {
          cache = { list: [], idxById: {}, idxByName: {} };
          meta = {
            lastFullFetchDay: null, lastFullFetchTs: 0, total: 0, pages: 0,
            pageSize: settings.pageSize, fetchedPages: 0, fetchedItems: 0, partial: false, lastError: ''
          };
          saveCache(cache);
          saveMeta(meta);
          toast('已清空缓存');
          renderPanel();
          if (settings.injectEnabled) scheduleDecorate(document);
        }
        return;
      }
      if (act === 'saveSettings') {
        const d = Number(panelEl.querySelector('input[data-k="delay"]').value);
        const j = Number(panelEl.querySelector('input[data-k="jitter"]').value);
        const r = Number(panelEl.querySelector('input[data-k="retry"]').value);
        const se = Number(panelEl.querySelector('input[data-k="saveEvery"]').value);
        const r429 = Number(panelEl.querySelector('input[data-k="retry429"]').value);
        const m429 = Number(panelEl.querySelector('input[data-k="max429"]').value);

        settings.delayMs = Number.isFinite(d) ? Math.max(0, Math.floor(d)) : settings.delayMs;
        settings.jitterMs = Number.isFinite(j) ? Math.max(0, Math.floor(j)) : settings.jitterMs;
        settings.retryCount = Number.isFinite(r) ? Math.max(0, Math.floor(r)) : settings.retryCount;
        settings.saveEveryPages = Number.isFinite(se) ? Math.max(1, Math.floor(se)) : settings.saveEveryPages;

        settings.retry429DelayMs = Number.isFinite(r429) ? Math.max(1000, Math.floor(r429)) : settings.retry429DelayMs;
        settings.max429RetriesPerPage = Number.isFinite(m429) ? Math.max(1, Math.floor(m429)) : settings.max429RetriesPerPage;

        saveSettings(settings);
        toast('设置已保存');
        renderPanel();
        return;
      }

if (act === 'support5') {
  window.open('https://credit.linux.do/paying/online?token=36ca0bae4257df6ae6208f7051ad7094f50cf1f993aee13d9389b7a66326899e', '_blank', 'noopener');
  return;
}
if (act === 'support10') {
  window.open('https://credit.linux.do/paying/online?token=6861b422541da92d3d2d150ec0fdbae50f934dacede2eabfb3550b4468c93c00', '_blank', 'noopener');
  return;
}
if (act === 'support20') {
  window.open('https://credit.linux.do/paying/online?token=1b375a20d1e6bcdcb24efbe1e8bce2c762d9ee99b207fb51f167916055f01d9f', '_blank', 'noopener');
  return;
}




    });

    // 排行翻页
    rankPrevBtn.addEventListener('click', () => {
      panelState.rankPage = Math.max(1, (panelState.rankPage || 1) - 1);
      savePanelState();
      renderRankList();
    });
    rankNextBtn.addEventListener('click', () => {
      panelState.rankPage = (panelState.rankPage || 1) + 1;
      savePanelState();
      renderRankList();
    });

    // 注入开关
    injectToggleEl.addEventListener('change', () => {
      settings.injectEnabled = !!injectToggleEl.checked;
      saveSettings(settings);
      toast(settings.injectEnabled ? '已开启：页面显示余额' : '已关闭：页面显示余额');
      if (settings.injectEnabled) scheduleDecorate(document);
      else removeAllBadges();
    });

    // 搜索
    searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch(searchInputEl.value);
    });
    searchInputEl.addEventListener('input', () => {
      if (!searchInputEl.value.trim()) searchResultEl.textContent = '';
    });
  }

  function renderPanel() {
    if (!panelEl) return;

    panelEl.querySelector('[data-k="count"]').textContent = String(cache.list.length || 0);
    panelEl.querySelector('[data-k="time"]').textContent = meta.lastFullFetchTs ? humanTime(meta.lastFullFetchTs) : '—';
    panelEl.querySelector('[data-k="today"]').textContent = canFetchToday() ? '可刷新' : (meta.partial ? '今日已刷新(未完成，可续传)' : '今日已刷新');

    // 按钮状态
    const btnFetch = panelEl.querySelector('button[data-act="fetch"]');
    const btnForce = panelEl.querySelector('button[data-act="force"]');
    const btnResume = panelEl.querySelector('button[data-act="resume"]');
    const btnStop = panelEl.querySelector('button[data-act="stop"]');

    btnFetch.disabled = running || (!canFetchToday()); // “开始获取”仍遵守每天一次
    btnForce.disabled = running;
    btnResume.disabled = running || !(meta.partial && cache.list.length > 0);
    btnStop.disabled = !running;

    // 参数回显
    panelEl.querySelector('input[data-k="delay"]').value = String(settings.delayMs);
    panelEl.querySelector('input[data-k="jitter"]').value = String(settings.jitterMs);
    panelEl.querySelector('input[data-k="retry"]').value = String(settings.retryCount);
    panelEl.querySelector('input[data-k="saveEvery"]').value = String(settings.saveEveryPages);
    panelEl.querySelector('input[data-k="retry429"]').value = String(settings.retry429DelayMs);
    panelEl.querySelector('input[data-k="max429"]').value = String(settings.max429RetriesPerPage);

    // 续传默认页：未运行时自动填“下一页”
    if (startPageEl && !running) {
      startPageEl.value = String((meta.fetchedPages || 0) + 1);
    }

    progressEl.textContent = running
      ? `抓取中：页 ${meta.fetchedPages}/${meta.pages || '？'} ｜ 已抓 ${meta.fetchedItems}/${meta.total || '？'}`
      : `就绪｜总缓存 ${cache.list.length} 条`;

    statusEl.textContent = meta.lastError ? `最近错误：${meta.lastError}` : '';

    renderRankList();
  }

  function renderRankList() {
    if (!rankListEl) return;

    const pageSize = 50;
    const total = cache.list.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(Math.max(1, panelState.rankPage || 1), totalPages);

    panelState.rankPage = p;
    savePanelState();

    rankPageEl.textContent = total
      ? `第 ${p}/${totalPages} 页（每页 ${pageSize}）`
      : '暂无缓存（先点击“开始获取”）';

    const start = (p - 1) * pageSize;
    const end = Math.min(total, start + pageSize);
    const slice = cache.list.slice(start, end);

    rankListEl.innerHTML = slice.map((it, i) => {
      const rank = start + i + 1;
      const id = it[0];
      const name = it[1];
      const bal = it[2];
      const url = `/u/${encodeURIComponent(name)}`;
      return `
        <div class="ldc-item" title="user_id=${escapeHtml(id)}">
          <div class="ldc-rank">#${rank}</div>
          <div class="ldc-name"><a href="${url}" style="color:inherit;text-decoration:none" target="_blank" rel="noopener">${escapeHtml(name)}</a></div>
          <div class="ldc-val">💰${escapeHtml(bal)}</div>
        </div>
      `;
    }).join('');
  }

  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;

    const lower = q.toLowerCase();
    let idx = null;

    if (/^\d+$/.test(q)) idx = cache.idxById[q] ?? null;
    if (idx == null) idx = cache.idxByName[lower] ?? null;

    if (idx == null || !cache.list[idx]) {
      searchResultEl.textContent = '未命中（缓存里找不到这个用户）';
      return;
    }

    const [id, name, bal] = cache.list[idx];
    const rank = idx + 1;
    searchResultEl.innerHTML = `命中：<b>#${rank}</b> ｜ <b>${escapeHtml(name)}</b>（user_id=${escapeHtml(id)}）｜ 💰<b>${escapeHtml(bal)}</b>`;
  }

  /***********************
   * 6) 抓取逻辑（翻页 + 重试 + 429等待 + 续传 + 分段落盘）
   ***********************/
  async function fetchPage(page) {
    const url = `${API_LEADERBOARD}?page=${page}&page_size=${settings.pageSize}`;
    const resp = await apiGet(url);

    if (!resp || resp.status !== 200) {
      return { ok: false, error: `HTTP_${resp?.status || 0}`, raw: resp?.data };
    }

    const data = unwrapLeaderboardResponse(resp.data);
    if (!data) {
      return { ok: false, error: 'BAD_JSON_SHAPE', raw: resp.data };
    }
    return { ok: true, data };
  }

  // ✅核心：429 不停止，等 30 秒再试
  async function fetchPageWithRetry(page) {
    let normalAttempt = 0;
    let hit429 = 0;

    while (true) {
      if (stopFlag) return { ok: false, error: 'STOPPED' };

      const r = await fetchPage(page);
      if (r.ok) return r;

      const is403 = (r.error === 'HTTP_403');
      const is429 = (r.error === 'HTTP_429');

      if (is403) return { ok: false, error: r.error };

      if (is429) {
        hit429++;
        if (settings.max429RetriesPerPage && hit429 > settings.max429RetriesPerPage) {
          return { ok: false, error: 'HTTP_429_TOO_MANY' };
        }

        const waitMs = (settings.retry429DelayMs || 30000) + Math.floor(Math.random() * 2000);
        const msg = `第 ${page} 页被限速：HTTP_429｜等待 ${Math.round(waitMs / 1000)} 秒后重试（第 ${hit429} 次）`;
        meta.lastError = msg;
        saveMeta(meta);
        renderPanel();
        toast(msg, 2500);

        await sleep(waitMs);
        continue;
      }

      // 其它错误：走普通 retryCount
      normalAttempt++;
      const msg = `第 ${page} 页失败（${r.error}），第 ${normalAttempt}/${settings.retryCount} 次`;
      meta.lastError = msg;
      saveMeta(meta);
      renderPanel();
      toast(msg, 1800);

      if (normalAttempt >= settings.retryCount) return { ok: false, error: 'RETRY_EXHAUSTED' };

      const backoff = settings.retryBaseDelayMs * normalAttempt + Math.floor(Math.random() * 500);
      await sleep(backoff);
    }
  }

  function calcDelay() {
    return settings.delayMs + Math.floor(Math.random() * settings.jitterMs);
  }

  function ingestPageItems(items, list, idxById, idxByName) {
    if (!Array.isArray(items)) return;

    for (const it of items) {
      const id = it.user_id;
      const name = it.username;
      const bal = formatBalance(it.available_balance);

      const row = [id, name, bal];
      const idx = list.length;
      list.push(row);

      idxById[String(id)] = idx;
      if (name) idxByName[String(name).toLowerCase()] = idx;
    }
  }

  async function startFetch({ force = false, resume = false, startPage = 1 } = {}) {
    if (running) return;

    if (!acquireLock()) {
      toast('另一个标签页正在抓取（或锁未释放），请稍后再试');
      return;
    }

    // ✅每天一次限制：如果是 resume 且 partial=true，允许继续
    if (!force && !canFetchToday() && !(resume && meta.partial)) {
      toast('今日已刷新过一次（已按“每天一次”限制阻止）');
      releaseLock();
      return;
    }

    running = true;
    stopFlag = false;

    lockTimer = setInterval(heartbeatLock, LOCK_HEARTBEAT);
    heartbeatLock();

    initBridge();

    // ✅决定 beginPage
    let beginPage = Math.max(1, Math.floor(Number(startPage) || 1));

    // ✅续传：沿用已有缓存
    let newList = [];
    let newIdxById = {};
    let newIdxByName = {};

    const canResume = resume && meta.partial && cache.list.length > 0;

    if (canResume) {
      newList = cache.list.slice();
      newIdxById = { ...cache.idxById };
      newIdxByName = { ...cache.idxByName };

      const nextPage = (meta.fetchedPages || 0) + 1;
      beginPage = Math.max(beginPage, nextPage);

      meta.lastError = '';
      saveMeta(meta);
      renderPanel();
      toast(`继续抓取：从第 ${beginPage}/${meta.pages || '？'} 页开始`, 2500);
    } else {
      // 非续传：清空重来
      beginPage = 1;
      newList = [];
      newIdxById = {};
      newIdxByName = {};

      meta.partial = true;
      meta.fetchedPages = 0;
      meta.fetchedItems = 0;
      meta.total = 0;
      meta.pages = 0;
      meta.pageSize = settings.pageSize;
      meta.lastError = '';
      saveMeta(meta);
      renderPanel();

      toast('开始抓取排行榜（注意：几万条会花一段时间）', 2600);
    }

    try {
      // ✅确保知道 total/pages（如果没有就抓第1页拿 meta；beginPage=1 时顺便 ingest）
      if (!meta.pages || !meta.total) {
        const firstMeta = await fetchPageWithRetry(1);
        if (!firstMeta.ok) throw new Error(`第一页失败：${firstMeta.error}`);

        const total = Number(firstMeta.data.total) || 0;
        const pages = total ? Math.ceil(total / settings.pageSize) : 0;

        meta.total = total;
        meta.pages = pages;
        meta.pageSize = settings.pageSize;
        saveMeta(meta);
        renderPanel();

        if (beginPage === 1) {
          ingestPageItems(firstMeta.data.items, newList, newIdxById, newIdxByName);
          meta.fetchedPages = 1;
          meta.fetchedItems = newList.length;
          saveMeta(meta);
          renderPanel();
          toast(`已获取第 1/${pages} 页`, 1200);
        }
      }

      const pages = meta.pages || 0;
      if (!pages) throw new Error('无法确定总页数（可能未登录 credit.linux.do 或被拦截）');

      if (beginPage > pages) {
        toast(`开始页 ${beginPage} 超过总页数 ${pages}，已停止`, 3500);
        throw new Error(`beginPage(${beginPage}) > pages(${pages})`);
      }

      // ✅主循环：从 beginPage 开始（如果 beginPage=1，第1页已处理，则从2开始）
      let loopStart = beginPage;
      if (beginPage === 1) loopStart = 2;

      for (let p = loopStart; p <= pages; p++) {
        if (stopFlag) throw new Error('用户停止');

        await sleep(calcDelay());

        const r = await fetchPageWithRetry(p);
        if (!r.ok) throw new Error(`第 ${p} 页失败：${r.error}`);

        ingestPageItems(r.data.items, newList, newIdxById, newIdxByName);

        meta.fetchedPages = p;
        meta.fetchedItems = newList.length;
        meta.lastError = '';
        saveMeta(meta);
        renderPanel();

        // 分段落盘
        if (p % settings.saveEveryPages === 0) {
          saveCache({ list: newList, idxById: newIdxById, idxByName: newIdxByName });
          toast(`已缓存到第 ${p}/${pages} 页（已落盘）`, 1200);
        } else {
          toast(`已获取第 ${p}/${pages} 页`, 900);
        }
      }

      // ✅完成：落盘 + 更新 meta
      saveCache({ list: newList, idxById: newIdxById, idxByName: newIdxByName });
      cache = { list: newList, idxById: newIdxById, idxByName: newIdxByName };

      meta.partial = false;
      meta.lastFullFetchDay = dayKeyLocal();
      meta.lastFullFetchTs = Date.now();
      meta.lastError = '';
      saveMeta(meta);

      toast(`✅ 抓取完成：共 ${cache.list.length} 条`, 3500);
      renderPanel();

      if (settings.injectEnabled) {
        cleanupWrongBadges(); // 先清理误插入的
        scheduleDecorate(document);
      }

    } catch (err) {
      meta.lastError = String(err?.message || err);
      saveMeta(meta);
      toast(`❌ 抓取中断：${meta.lastError}`, 4200);
      renderPanel();

      // 中断时：依旧把当前 newList 落盘（避免丢）
      try {
        saveCache({ list: newList, idxById: newIdxById, idxByName: newIdxByName });
        cache = { list: newList, idxById: newIdxById, idxByName: newIdxByName };
        meta.partial = true;
        saveMeta(meta);
      } catch {}
    } finally {
      running = false;
      stopFlag = false;

      if (lockTimer) clearInterval(lockTimer);
      lockTimer = null;
      releaseLock();

      renderPanel();
    }
  }

  function stopFetch() {
    if (!running) return;
    stopFlag = true;
    toast('已请求停止（将在当前页结束后停）', 2000);
  }

  /***********************
   * 7) 页面注入：用户名旁显示余额（跳过头像/侧边栏/导航）
   ***********************/
  function lookupInfo(userId, username) {
    let idx = null;
    if (userId != null) idx = cache.idxById[String(userId)] ?? null;
    if (idx == null && username) idx = cache.idxByName[String(username).toLowerCase()] ?? null;
    if (idx == null) return null;

    const row = cache.list[idx];
    if (!row) return null;
    return { userId: row[0], username: row[1], balance: row[2], rank: idx + 1 };
  }

  function findUserIdNear(el) {
    const holder = el.closest('article[data-user-id]') || el.closest('[data-user-id]');
    if (!holder) return null;
    const v = holder.getAttribute('data-user-id');
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function findUsernameFromLink(a) {
    const uc = a.getAttribute('data-user-card');
    if (uc) return uc;
    return null;
  }

  function isAvatarUserLink(a) {
    // 头像链接通常包着 img.avatar 或位于 avatar 容器
    if (a.querySelector && a.querySelector('img.avatar')) return true;
    if (a.closest && a.closest('.topic-avatar, .poster-avatar, .avatar-wrapper, .user-image, .user-card-avatar')) return true;
    // 没有文字也大概率不是用户名文本链接
    const txt = (a.textContent || '').trim();
    if (!txt) return true;
    return false;
  }

  function isBadAreaLink(a) {
    // 侧边栏/导航/头部/菜单里不要插
    return !!a.closest('.sidebar-wrapper, .sidebar-sections, .sidebar-section-link-wrapper, nav, header, .d-header, .menu-panel');
  }

  function ensureBadgeForLink(a) {
    if (!settings.injectEnabled) return;
    if (!a || a.nodeType !== 1) return;

    if (isBadAreaLink(a)) return;
    if (isAvatarUserLink(a)) return;

    const username = findUsernameFromLink(a);
    if (!username) return; // ✅关键：只处理带 data-user-card 的“用户名链接”，跳过所有 /u/ 导航链接

    const userId = findUserIdNear(a);
    const info = lookupInfo(userId, username);
    if (!info) return;

    const key = userId != null ? `id:${userId}` : `u:${String(username).toLowerCase()}`;

    // 优先插到用户名同一行的勋章容器
    const namesWrap = a.closest('.names') || a.closest('.trigger-user-card') || a.parentElement;
    let targetContainer = null;
    if (namesWrap) targetContainer = namesWrap.querySelector('.poster-icon-container') || null;

    const scope = targetContainer || namesWrap || a.parentElement || document;
    const existed = scope.querySelector(`.ldc-badge[data-ldc-key="${CSS.escape(key)}"]`);

    const title = `Credit余额：${info.balance}｜排名 #${info.rank}｜user_id=${info.userId}`;

    if (existed) {
      if (existed.getAttribute('data-ldc-balance') !== info.balance) {
        existed.setAttribute('data-ldc-balance', info.balance);
        existed.title = title;
        const num = existed.querySelector('.ldc-num');
        if (num) num.textContent = info.balance;
      }
      return;
    }

    const badge = document.createElement('span');
    badge.className = 'ldc-badge';
    badge.setAttribute('data-ldc-key', key);
    badge.setAttribute('data-ldc-balance', info.balance);
    badge.title = title;
    badge.innerHTML = `<span class="ldc-coin">💰</span><span class="ldc-num">${escapeHtml(info.balance)}</span>`;

    if (targetContainer) targetContainer.appendChild(badge);
    else a.insertAdjacentElement('afterend', badge);
  }

  function removeAllBadges() {
    document.querySelectorAll('.ldc-badge[data-ldc-key]').forEach(el => el.remove());
  }

  function cleanupWrongBadges() {
    // 清理插在头像区/侧边栏/导航的 badge（历史遗留）
    document.querySelectorAll('.ldc-badge[data-ldc-key]').forEach(b => {
      if (b.closest('.topic-avatar, .poster-avatar, .avatar-wrapper, .user-image, .user-card-avatar') ||
          b.closest('.sidebar-wrapper, .sidebar-sections, .sidebar-section-link-wrapper, nav, header, .d-header, .menu-panel')) {
        b.remove();
      }
    });
  }

  // MutationObserver：增量装饰
  const pendingRoots = new Set();
  let decorateTimer = null;

  function scheduleDecorate(root) {
    if (!settings.injectEnabled) return;
    if (root && root.nodeType === 1) pendingRoots.add(root);
    else pendingRoots.add(document);

    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      flushDecorate();
    }, 350);
  }

  function flushDecorate() {
    if (!settings.injectEnabled) return;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    for (const r of roots) decorateContainer(r);
  }

  // ✅只抓 a[data-user-card]（避免 sidebar 的 /u/ 链接误伤）
  function decorateContainer(root) {
    if (!root || (root.nodeType !== 1 && root !== document)) return;

    const links = (root === document)
      ? document.querySelectorAll('a[data-user-card]')
      : root.querySelectorAll
        ? root.querySelectorAll('a[data-user-card]')
        : [];

    for (const a of links) ensureBadgeForLink(a);
  }

  function initObserver() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of (m.addedNodes || [])) {
          if (n && n.nodeType === 1) scheduleDecorate(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /***********************
   * 8) 启动
   ***********************/
  function startup() {
    createPanel();
    cleanupWrongBadges();
    renderPanel();

    if (settings.injectEnabled) {
      scheduleDecorate(document);
      initObserver();
    }

    GM_registerMenuCommand('打开/关闭面板', () => {
      panelState.collapsed = !panelState.collapsed;
      savePanelState();
      const btn = panelEl.querySelector('button[data-act="collapse"]');
      btn.textContent = panelState.collapsed ? '➕' : '➖';
      bodyEl.style.display = panelState.collapsed ? 'none' : '';
    });

    GM_registerMenuCommand('开始获取（遵守每天一次）', () => startFetch({ force: false, resume: false, startPage: 1 }));
    GM_registerMenuCommand('继续获取（断点续传）', () => startFetch({ force: false, resume: true, startPage: (meta.fetchedPages || 0) + 1 }));
    GM_registerMenuCommand('强制刷新（不建议频繁）', () => startFetch({ force: true, resume: false, startPage: 1 }));
    GM_registerMenuCommand('清空缓存', () => {
      if (!confirm('确定清空缓存吗？')) return;
      cache = { list: [], idxById: {}, idxByName: {} };
      meta = {
        lastFullFetchDay: null, lastFullFetchTs: 0, total: 0, pages: 0,
        pageSize: settings.pageSize, fetchedPages: 0, fetchedItems: 0, partial: false, lastError: ''
      };
      saveCache(cache);
      saveMeta(meta);
      removeAllBadges();
      renderPanel();
      toast('已清空缓存');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup, { once: true });
  } else {
    startup();
  }

})();
