/* =====================================================================
 * FUNNOW 一鍵上架工具（主程式）
 * ---------------------------------------------------------------------
 * 用法：由書籤小工具載入本檔，會在頁面右下角顯示操作面板。
 * 資料來源：Google Sheet 發佈的 CSV（見下方 CONFIG.CSV_URL）。
 * 流程：偵測/指定「館別+專案+頻道」→ 依主檔逐一時段填入 →
 *       每填好一個時段就停住，等你檢查後手動按「儲存」→ 按面板「下一步」。
 * ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  設定區（部署時需修改）
   * ------------------------------------------------------------------ */
  const CONFIG = {
    // ★ 換成你的 Google Sheet「發佈到網路 → CSV」網址
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTdMlu5-eNo4Dpo7L1Oj-3WzdGsMvPPpYEYv-QRQeg46gZLBTqPpP7iKYZKS5dGyGYppKDliYo_0vHZ/pub?gid=0&single=true&output=csv',

    // 選填欄留空時套用的預設值
    DEFAULTS: {
      startDate: '2026-07-01',
      endDate: '2026-12-31',
      hour: '16',
      minute: '00',
    },

    VERSION: 'v1.4.4',
  };

  /* 若已載入過，直接切換顯示 / 隱藏面板 */
  if (window.__FUNNOW__ && window.__FUNNOW__.panel) {
    window.__FUNNOW__.toggle();
    return;
  }

  /* ================================================================== *
   *  共用小工具（沿用自既有腳本，略作整理）
   * ================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (t) => String(t || '').replace(/\s+/g, '').trim();
  // 比對用正規化：統一全形冒號/間隔號、去掉截斷符號
  const keyNorm = (s) => norm(s)
    .replace(/[：]/g, ':').replace(/[・･]/g, '·')
    .replace(/[…]+$/, '').replace(/\.{2,}$/, '');

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const visible = (sel, root = document) =>
    [...root.querySelectorAll(sel)].filter(isVisible);

  // 提示條（儲存成功 toast）不是對話框，須排除
  const isToast = (o) => !!(o && ((o.classList && o.classList.contains('v-snackbar__wrapper')) || (o.closest && o.closest('.v-snackbar'))));
  // 真正的對話框/浮層（排除面板自身與 toast）
  const realOverlays = () => visible('.v-overlay__content, [role="dialog"]')
    .filter((o) => !o.closest('#fn-panel') && !isToast(o));

  const waitFor = async (getter, timeout = 8000, interval = 150) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let r;
      try { r = getter(); } catch (e) { r = null; }
      if (r) return r;
      await sleep(interval);
    }
    return null;
  };

  const safeClick = async (el, wait = 350) => {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(80);
    el.click();
    await sleep(wait);
    return true;
  };

  // 紮實點擊：完整滑鼠事件序列（有些 Vuetify 按鈕 .click() 不夠）
  const firmClick = async (el, wait = 500) => {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(80);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true })));
    await sleep(wait);
    return true;
  };

  const dispatchInput = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  const setInputValue = (input, value) => {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    dispatchInput(input);
  };

  const parseYM = (d) => { const [y, m] = d.split('-').map(Number); return { y, m }; };
  const monthDiff = (fy, fm, ty, tm) => (ty - fy) * 12 + (tm - fm);

  /* ================================================================== *
   *  CSV 解析（支援雙引號、內含逗號 / 換行）
   * ================================================================== */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');            // 去掉 BOM
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (inQuotes) {
        if (c === '"' && n === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* 忽略 */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  /* 把表頭中文欄名對應到內部鍵（容忍空白 / 全形） */
  const HEADER_MAP = {
    '館別': 'store', '專案': 'project', '頻道': 'channel',
    '類型': 'type', '時段名稱': 'name', '價格': 'price',
    '星期': 'days', '開始日': 'startDate', '結束日': 'endDate',
    '時': 'hour', '分': 'minute', '特殊場次': 'sessions',
  };

  function rowsToObjects(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => HEADER_MAP[norm(h)] || norm(h));
    return rows.slice(1).map((r) => {
      const o = {};
      header.forEach((key, i) => { o[key] = (r[i] != null ? String(r[i]).trim() : ''); });
      return o;
    });
  }

  /* ================================================================== *
   *  值處理：星期、特殊場次、預設值
   * ================================================================== */
  const ALL_DAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function parseDays(cell, name) {
    if (cell && cell.trim()) {
      const found = [...cell].filter((ch) => ALL_DAYS.includes(ch));
      if (found.length) return [...new Set(found)];
    }
    // 留空 → 依名稱推測預設：含「假」→ 六；否則 日一二三四五
    return /假/.test(name || '') ? ['六'] : ['日', '一', '二', '三', '四', '五'];
  }

  function parseSessions(cell) {
    if (!cell) return [];
    return cell
      .split(/[;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tok) => {
        // 例："2026-09-25 16:00" 或 "2026/09/25 16：00"
        const m = tok.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2})[:：](\d{1,2})/);
        if (!m) return null;
        const pad = (x) => String(x).padStart(2, '0');
        return {
          date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
          hour: String(Number(m[4])),
          minute: pad(m[5]),
        };
      })
      .filter(Boolean);
  }

  /* 把一列主檔轉成填表用 config */
  function toStepConfig(row) {
    const type = /特殊/.test(row.type) ? 'special' : 'cyclic';
    const base = {
      type,
      name: row.name || (type === 'special' ? '特殊' : '時段'),
      price: (row.price || '').replace(/[,\s]/g, ''),
    };
    if (type === 'cyclic') {
      return Object.assign(base, {
        days: parseDays(row.days, row.name),
        startDate: row.startDate || CONFIG.DEFAULTS.startDate,
        endDate: row.endDate || CONFIG.DEFAULTS.endDate,
        hour: String(Number(row.hour || CONFIG.DEFAULTS.hour)),
        minute: (row.minute || CONFIG.DEFAULTS.minute).padStart(2, '0'),
      });
    }
    return Object.assign(base, { sessions: parseSessions(row.sessions) });
  }

  /* ================================================================== *
   *  頁面偵測：專案名稱 / 頻道 / 館別（best-effort，可被面板手動覆蓋）
   * ================================================================== */
  const inPanel = (el) => !!(el && el.closest && el.closest('#fn-panel'));

  // 頂端內容區（header 下方、專案選擇框所在）大致範圍
  const inTopContent = (el) => {
    const r = el.getBoundingClientRect();
    return r.top > 80 && r.top < 250 && r.left < 820 && r.width > 60;
  };

  // 專案下拉選單目前選取的區塊（含專案名與頻道 icon）
  const projectSelectionEl = () =>
    document.querySelector('.base-select .v-select__selection') ||
    document.querySelector('.v-select__selection');

  function detectProjectName() {
    // 精準：專案下拉目前選取的文字
    const precise = document.querySelector('.base-select .v-select__selection .wd-truncate')
      || document.querySelector('.v-select__selection .wd-truncate');
    if (precise && isVisible(precise)) return precise.textContent.trim();
    // 後援：頂端內容區的短文字（名稱不一定含「｜」，例：標準雙人房）
    const cands = [...document.querySelectorAll('div, span, p, input')].filter((el) => {
      if (inPanel(el) || !isVisible(el) || !inTopContent(el)) return false;
      if (el.closest('table') || el.closest('.v-overlay__content')) return false;
      const t = (el.value || el.textContent || '').trim();
      return t && t.length >= 2 && t.length < 40 && el.children.length <= 2
        && !/兌換訂單|限時促銷|新增預訂|檢視|列表|方案設定|今日起|已開放預訂/.test(t);
    });
    cands.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
      || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return cands.length ? (cands[0].value || cands[0].textContent).trim() : '';
  }

  function channelIconBlob() {
    const scope = projectSelectionEl() || document.body;
    return [...scope.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').join(' | ');
  }
  function detectChannel() {
    // 依專案選取區塊的 icon 檔名判定：funnow.svg=funnow、funbook.svg=官網、兩者皆有=都有
    const scope = projectSelectionEl();
    const imgs = scope ? [...scope.querySelectorAll('img')].map((i) => (i.getAttribute('src') || '').toLowerCase()) : [];
    const hasFunnow = imgs.some((s) => /funnow\.svg/.test(s));
    const hasFunbook = imgs.some((s) => /funbook\.svg/.test(s));
    if (hasFunnow && hasFunbook) return '都有';
    if (hasFunnow) return 'funnow';
    if (hasFunbook) return '官網';
    return '';
  }

  function detectStore() {
    // 右上館別按鈕文字（可能被截斷成「蟬說：旭…」）
    const cands = [...document.querySelectorAll('button, span, div')].filter((el) => {
      if (inPanel(el) || !isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top > 90 || r.left < 900) return false; // 右上角
      const t = (el.textContent || '').trim();
      return t && t.length >= 2 && t.length < 40 && el.children.length <= 2;
    });
    cands.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const hit = cands.find((el) => /[：:｜·]/.test(el.textContent) || /說|館|店|飯店|旅|莊/.test(el.textContent));
    return hit ? hit.textContent.trim() : (cands[0] ? cands[0].textContent.trim() : '');
  }

  /* ================================================================== *
   *  開啟對話框
   * ================================================================== */
  const getEditorRoot = () => {
    const saveBtn = visible('button, .v-btn, button[type="submit"]')
      .find((b) => norm(b.textContent) === '儲存');
    if (!saveBtn) return null;
    return saveBtn.closest('[role="dialog"], .v-overlay__content, form, .wd-overflow-y-auto, .wd-flex-col')
      || saveBtn.parentElement;
  };

  const hasNameInput = (el) => !!(el && el.querySelector && el.querySelector('input[placeholder="請輸入時段名稱"]'));

  /* 找彈窗內的「＋ 新增」按鈕（圖示，無文字），排除關閉(×) */
  function findAddButton(root) {
    const btns = [...root.querySelectorAll('button, .v-btn, [role="button"]')].filter(isVisible);
    const isClose = (b) => /close|關閉|mdi-close/i.test((b.className || '') + (b.getAttribute('aria-label') || '') + b.innerHTML);
    // 1) 明確標示 plus / add / 新增
    let c = btns.find((b) => !isClose(b) &&
      (/plus|[-_]add\b|add[-_]|新增/i.test((b.className || '') + b.innerHTML) || /新增|add|plus/i.test(b.getAttribute('aria-label') || '')));
    if (c) return c;
    // 2) 文字就是 + / ＋
    c = btns.find((b) => /^[+＋]$/.test(norm(b.textContent)));
    if (c) return c;
    // 3) 純圖示按鈕（無文字），排除關閉，取第一個
    const iconBtns = btns.filter((b) => !norm(b.textContent) && !isClose(b));
    return iconBtns[0] || null;
  }

  function stashOverlayHTML(el) {
    try { STATE.lastOverlayHTML = dumpEl(el, 3500); } catch (e) {}
    log('已把目前視窗 HTML 記入診斷；請按「🩺 匯出診斷」回傳。', 'err');
  }

  /* 統一的「開新增表單」：點 setting-btn → 若出現清單彈窗，再點其中的＋ → 進表單 */
  async function openAddDialog(label) {
    // 表單已經開著就直接用
    let root = getEditorRoot();
    if (hasNameInput(root)) return root;

    const findModal = () => realOverlays()
      .find((o) => new RegExp(label).test(o.textContent) && !hasNameInput(o));

    let modal = findModal();
    if (!modal) {
      // 若有「不相干」的彈窗開著（例如要開特殊、但循環清單還開著），先關掉以免擋住按鈕
      const others = realOverlays();
      if (others.length) await closeAnyDialog();
      const btn = visible('button.setting-btn, button, .v-btn')
        .find((b) => norm(b.textContent) === label);
      if (!btn) throw new Error('找不到「' + label + '」按鈕');
      await safeClick(btn, 900);
      // 等：表單直接出現、或清單彈窗出現
      const got = await waitFor(() => {
        const r = getEditorRoot();
        if (hasNameInput(r)) return { form: r };
        const m = findModal();
        return m ? { modal: m } : null;
      }, 9000);
      if (!got) throw new Error('點「' + label + '」後沒有出現視窗');
      if (got.form) return got.form;
      modal = got.modal;
    }

    // 等清單彈窗穩定，並「先」記錄它的 HTML（就算之後關閉，診斷也留得住）
    await sleep(500);
    modal = findModal() || modal;
    STATE.lastOverlayHTML = dumpEl(modal, 3800);
    // 點清單彈窗內的「＋」
    const addBtn = findAddButton(modal);
    if (!addBtn) throw new Error('找不到「' + label + '」視窗內的＋新增鈕（已把清單HTML記入診斷）');
    await firmClick(addBtn, 700);
    root = await waitFor(() => (hasNameInput(getEditorRoot()) ? getEditorRoot() : null), 10000);
    if (!root) throw new Error('點＋後仍找不到新增表單（已把清單HTML記入診斷，請按🩺匯出診斷）');
    return root;
  }

  const openCyclicDialog = () => openAddDialog('循環設定');
  const openSpecialDialog = () => openAddDialog('特殊設定');

  /* ---- 批次用：自動儲存、關閉彈窗、切換專案/館別 ---- */
  const channelFromImgs = (imgs) => {
    const s = imgs.join(' ').toLowerCase();
    const fn = /funnow\.svg/.test(s), fb = /funbook\.svg/.test(s);
    if (fn && fb) return '都有';
    if (fn) return 'funnow';
    if (fb) return '官網';
    return '';
  };

  async function autoSaveDialog(root) {
    const btn = visible('button, .v-btn', root || document).find((b) => norm(b.textContent) === '儲存')
      || visible('button, .v-btn').find((b) => norm(b.textContent) === '儲存');
    if (!btn) { stashOverlayHTML(getEditorRoot()); throw new Error('找不到「儲存」按鈕（自動儲存失敗）'); }
    await safeClick(btn, 900);
    const closed = await waitFor(() => (hasNameInput(getEditorRoot()) ? null : true), 8000);
    if (!closed) throw new Error('按了儲存但表單沒關閉（可能有錯誤或必填未過，請檢查）');
    await sleep(1200); // 等「儲存成功」提示與頁面重繪完成
    return true;
  }

  async function closeAnyDialog() {
    for (let i = 0; i < 4; i++) {
      const ovs = realOverlays();
      if (!ovs.length) return true;
      const ov = ovs[ovs.length - 1];
      const btn = visible('button, .v-btn', ov).find((b) => norm(b.textContent) === '取消')
        || ov.querySelector('.close-icon')
        || visible('button, .v-btn', ov).find((b) => /close|關閉|cancel/i.test((b.className || '') + b.innerHTML));
      if (btn) await safeClick(btn, 500);
      else { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); await sleep(400); }
    }
    return !realOverlays().length;
  }

  async function switchProject(project, channel) {
    const want = keyNorm(project);
    // 已在目標專案（且頻道相符）就不用切
    if (keyNorm(detectProjectName()) === want) {
      const curCh = detectChannel();
      if (!channel || channel === '(未填)' || curCh === channel) { log('（已在目標專案，略過切換）'); return; }
    }
    const field = document.querySelector('.base-select .v-field[role="combobox"]')
      || document.querySelector('.base-select .v-field')
      || document.querySelector('.base-select');
    if (!field) throw new Error('找不到專案選擇框');
    const menuId = field.getAttribute('aria-owns')
      || (field.querySelector('[aria-owns]') && field.querySelector('[aria-owns]').getAttribute('aria-owns'));
    await safeClick(field, 600);
    // 只在該 select 專屬選單 / 浮層內找（排除左側導覽的 .v-list）
    const menu = await waitFor(() => {
      let m = menuId ? document.getElementById(menuId) : null;
      if (!m) m = visible('.v-overlay__content').filter((o) => !o.closest('#fn-panel')).find((o) => o.querySelector('.v-list-item, [role="option"]'));
      return (m && isVisible(m) && m.querySelector('.v-list-item, [role="option"]')) ? m : null;
    }, 6000);
    if (!menu) { stashOverlayHTML(visible('.v-overlay__content').filter((o) => !o.closest('#fn-panel')).pop()); throw new Error('專案清單沒展開'); }
    const items = [...menu.querySelectorAll('.v-list-item, [role="option"]')].filter(isVisible);
    const cands = items.filter((it) => { const t = keyNorm(it.textContent); return t.includes(want) || want.includes(t); });
    const target = cands.find((it) => {
      const ch = channelFromImgs([...it.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''));
      return !channel || channel === '(未填)' || ch === channel;
    }) || cands[0];
    if (!target) { stashOverlayHTML(menu); throw new Error('清單找不到專案：' + project + '（' + channel + '）'); }
    await safeClick(target, 1000);
    await waitFor(() => { const n = keyNorm(detectProjectName()); return (n === want || n.includes(want)) ? true : null; }, 5000);
  }

  const storeCore = (s) => keyNorm(s).replace(/^蟬說[:：]?/, '');
  const storeMatches = (store) => {
    const cur = keyNorm(detectStore());
    return cur.includes(storeCore(store)) || storeCore(store).includes(cur.replace(/^蟬說[:：]?/, ''));
  };
  async function switchStore(store) {
    const storeBtn = document.querySelector('header [aria-haspopup="menu"]')
      || [...document.querySelectorAll('header button')].filter(isVisible).pop();
    if (!storeBtn) throw new Error('找不到館別選單按鈕');
    await safeClick(storeBtn, 700);
    const sw = await waitFor(() => visible('*').find((el) => !el.closest('#fn-panel') && norm(el.textContent) === '切換分店' && el.children.length <= 1), 5000);
    if (!sw) { stashOverlayHTML(visible('.v-overlay__content').pop()); throw new Error('找不到「切換分店」'); }
    await safeClick(sw, 900);
    const core = store.replace(/^蟬說\s*[：:]\s*/, '').trim();
    const search = await waitFor(() => visible('input').find((i) => /店名|分店|搜尋/.test(i.getAttribute('placeholder') || '')), 5000);
    if (search) { setInputValue(search, core); await sleep(1000); }
    const target = await waitFor(() => {
      const chooses = visible('button, .v-btn').filter((b) => norm(b.textContent) === '選擇');
      return chooses.find((b) => { const box = b.closest('div'); const t = box ? keyNorm(box.textContent) : ''; return t.includes(keyNorm(store)) || t.includes(keyNorm(core)); }) || null;
    }, 6000);
    if (!target) { stashOverlayHTML(visible('.v-overlay__content').pop()); throw new Error('切換分店清單找不到：' + store); }
    await safeClick(target, 1500);
    await waitFor(() => (keyNorm(detectStore()).includes(keyNorm(core)) ? true : null), 8000);
  }

  /* ================================================================== *
   *  填「循環設定」（平日 / 假日）—— 沿用平日.txt 邏輯，改為吃 config
   * ================================================================== */
  async function fillCyclic(root, cfg) {
    const nameInput = root.querySelector('input[placeholder="請輸入時段名稱"]');
    if (!nameInput) throw new Error('找不到名稱輸入框');
    setInputValue(nameInput, cfg.name);

    const priceInput = root.querySelector('.price-input input');
    if (!priceInput) throw new Error('找不到銷售價輸入框');
    setInputValue(priceInput, cfg.price);
    await sleep(200);

    // 開重複選單
    const activator = [...document.querySelectorAll('.custom-input__value, .custom-input')]
      .find((el) => el.textContent.trim().includes('永遠不停止'));
    if (!activator) throw new Error('找不到「永遠不停止」');
    await safeClick(activator, 500);

    // 切到「設定重複起訖日」
    const rangeLabel = [...document.querySelectorAll('label')]
      .find((el) => el.textContent.trim().includes('設定重複起訖日'));
    if (!rangeLabel) throw new Error('找不到「設定重複起訖日」');
    await safeClick(rangeLabel, 700);
    if (!document.querySelector('[data-testid="date-range-picker__content"]'))
      throw new Error('日期區間日曆沒打開');

    const getRangeMonths = () =>
      [...document.querySelectorAll('[data-testid="date-range-picker__content"] .wd-grid')]
        .map((el) => el.textContent.trim())
        .filter((t) => /\d{4}\s*年\s*\d{1,2}\s*月/.test(t))
        .map((t) => { const m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/); return { y: +m[1], m: +m[2] }; });

    const rangeNav = async (dir) => {
      const b = document.querySelector(`[data-testid="date-range-picker__${dir}-month-button"]`);
      if (!b) return false; b.click(); await sleep(350); return true;
    };
    const gotoRangeMonth = async (dateStr) => {
      const t = parseYM(dateStr);
      for (let i = 0; i < 24; i++) {
        const vis = getRangeMonths();
        if (!vis.length) return false;
        if (vis.some((v) => v.y === t.y && v.m === t.m)) return true;
        const diff = monthDiff(vis[0].y, vis[0].m, t.y, t.m);
        if (!(await rangeNav(diff > 0 ? 'next' : 'prev'))) return false;
      }
      return false;
    };
    const clickDate = async (dateStr) => {
      const el = document.querySelector(`[data-date="${dateStr}"]`);
      if (!el) return false; el.click(); await sleep(400); return true;
    };

    if (!(await gotoRangeMonth(cfg.startDate))) throw new Error('無法切到開始月份：' + cfg.startDate);
    if (!(await clickDate(cfg.startDate))) throw new Error('找不到開始日：' + cfg.startDate);
    if (!(await gotoRangeMonth(cfg.endDate))) throw new Error('無法切到結束月份：' + cfg.endDate);
    if (!(await clickDate(cfg.endDate))) throw new Error('找不到結束日：' + cfg.endDate);

    // 日期區間「確認」
    await confirmInOverlay('[data-testid="date-range-picker__content"]');

    // 星期
    const getDayBtn = (day) => {
      const inRoot = [...root.querySelectorAll('.day-toggle .v-btn')]
        .find((b) => b.textContent.trim() === day);
      if (inRoot) return inRoot;
      return [...document.querySelectorAll('.day-toggle .v-btn')]
        .find((b) => b.textContent.trim() === day);
    };
    const isActive = (b) => !!b && (b.classList.contains('is-active') || b.classList.contains('v-btn--active'));
    for (const day of ALL_DAYS) {
      const b = getDayBtn(day);
      if (!b) continue;
      if (cfg.days.includes(day) !== isActive(b)) { b.click(); await sleep(350); }
    }

    // 場次時間
    const sessionLabel = [...root.querySelectorAll('label'), ...document.querySelectorAll('label')]
      .find((el) => el.textContent.trim().includes('場次'));
    if (sessionLabel) { await safeClick(sessionLabel, 500); }

    const timeActivator = document.querySelector('[data-testid="date-picker__activator"]');
    if (!timeActivator) throw new Error('找不到場次時間 activator');
    await safeClick(timeActivator, 500);

    await pickTime('hour', cfg.hour);
    await pickTime('minute', cfg.minute);
    await confirmInOverlay('[data-type="hour"]');
  }

  /* 時間選擇：點 data-value */
  async function pickTime(type, val) {
    const container = document.querySelector(`[data-type="${type}"]`);
    if (!container) throw new Error(`找不到 ${type} 選擇區`);
    const el = [...container.querySelectorAll('[data-value]')]
      .find((n) => n.getAttribute('data-value') === String(Number(val)) && n.getAttribute('disabled') !== 'true');
    if (!el) throw new Error(`找不到 ${type}: ${val}`);
    await safeClick(el, 300);
  }

  /* 通用「確認」按鈕（在含 anchorSel 的浮層 / 對話框內找） */
  async function confirmInOverlay(anchorSel) {
    const anchor = document.querySelector(anchorSel);
    const rootEl = (anchor && (anchor.closest('[role="dialog"]') || anchor.parentElement.parentElement)) || document.body;
    let btn = visible('button, .v-btn', rootEl).find((el) => norm(el.textContent) === '確認');
    if (!btn) btn = visible('button, .v-btn').find((el) => norm(el.textContent) === '確認');
    if (!btn) throw new Error('找不到「確認」按鈕');
    btn.scrollIntoView({ block: 'center' });
    await sleep(200);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) =>
      btn.dispatchEvent(new MouseEvent(t, { bubbles: true })));
    await sleep(700);
  }

  /* ================================================================== *
   *  填「特殊設定」—— 沿用特殊.txt 邏輯，改為吃 config
   * ================================================================== */
  async function fillSpecial(root, cfg) {
    if (!cfg.sessions || !cfg.sessions.length) throw new Error('此特殊時段沒有任何場次');

    const nameInput = root.querySelector('input[placeholder="請輸入時段名稱"]');
    if (!nameInput) throw new Error('找不到名稱輸入框');
    setInputValue(nameInput, cfg.name);
    await sleep(150);
    const priceInput = root.querySelector('.price-input input');
    if (!priceInput) throw new Error('找不到銷售價輸入框');
    setInputValue(priceInput, cfg.price);
    await sleep(150);

    // 切到「場次」
    const sessionLabel = [...root.querySelectorAll('label')].find((el) => norm(el.textContent) === '場次');
    if (sessionLabel) {
      const forId = sessionLabel.getAttribute('for');
      const input = forId ? root.querySelector('#' + CSS.escape(forId)) : null;
      if (input && !input.checked) {
        input.click();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await sleep(300);

    const getRows = () => [...root.querySelectorAll('.wd-mb-4.wd-flex')]
      .filter((r) => r.querySelector('[data-testid="date-picker__activator"]'));

    const configureRow = async (index, s) => {
      const row = getRows()[index];
      if (!row) throw new Error(`找不到第 ${index + 1} 列場次`);
      const activator = row.querySelector('[data-testid="date-picker__activator"]');
      const before = activator.textContent.trim();
      if (activator.getAttribute('aria-expanded') !== 'true') await safeClick(activator, 600);
      const menuId = activator.getAttribute('aria-owns');
      const picker = await waitFor(() => {
        const el = menuId ? document.getElementById(menuId) : null;
        return el && isVisible(el) && el.querySelector('[data-date]') ? el : null;
      }, 5000) || document;

      // 切到該場次月份
      const monthTitle = () => (visible('div, span', picker)
        .map((e) => (e.textContent || '').trim())
        .find((t) => /^\d{4}\s*年\s*\d{1,2}\s*月$/.test(t)) || '');
      const t = parseYM(s.date);
      for (let i = 0; i < 24; i++) {
        const mm = monthTitle().match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (!mm) { await sleep(200); continue; }
        if (+mm[1] === t.y && +mm[2] === t.m) break;
        const diff = monthDiff(+mm[1], +mm[2], t.y, t.m);
        const nav = picker.querySelector(`[data-testid="date-picker__${diff > 0 ? 'next' : 'prev'}-month-button"]`);
        if (!nav) throw new Error('特殊：找不到月份切換鈕');
        await safeClick(nav, 400);
      }
      const cell = picker.querySelector(`[data-date="${s.date}"]`);
      if (!cell) throw new Error('特殊：找不到日期 ' + s.date);
      await safeClick(cell, 350);

      const pick = async (type, val) => {
        const c = picker.querySelector(`[data-type="${type}"]`);
        if (!c) throw new Error('特殊：找不到 ' + type);
        const el = [...c.querySelectorAll('[data-value]')]
          .find((n) => n.getAttribute('data-value') === String(Number(val)) && n.getAttribute('disabled') !== 'true');
        if (!el) throw new Error(`特殊：找不到 ${type}:${val}`);
        await safeClick(el, 300);
      };
      await pick('hour', s.hour);
      await pick('minute', s.minute);

      let cbtn = visible('button, .v-btn', picker).find((e) => norm(e.textContent) === '確認')
        || visible('button, .v-btn').find((e) => norm(e.textContent) === '確認');
      if (!cbtn) throw new Error('特殊：找不到確認');
      await safeClick(cbtn, 700);
      await waitFor(() => { const x = activator.textContent.trim(); return x && x !== before ? x : null; }, 3000);
    };

    const addRow = async () => {
      const before = getRows().length;
      const addBtn = visible('button, .v-btn', root).find((e) => norm(e.textContent).includes('新增時段'));
      if (!addBtn) throw new Error('找不到「新增時段」');
      await safeClick(addBtn, 800);
      await waitFor(() => getRows().length > before, 5000);
    };

    await configureRow(0, cfg.sessions[0]);
    for (let i = 1; i < cfg.sessions.length; i++) {
      if (getRows().length <= i) await addRow();
      await configureRow(i, cfg.sessions[i]);
    }
  }

  /* ================================================================== *
   *  狀態
   * ================================================================== */
  const STATE = {
    allRows: [],       // 全部主檔（已轉物件）
    tree: {},          // store -> project -> channel -> [rows]
    steps: [],         // 目前選定群組要做的時段 config 陣列
    stepIndex: 0,
    running: false,
    mode: 'step',      // step | project | store | full
    lastOverlayHTML: '', // 最近一次開視窗失敗時的彈窗 HTML（供診斷）
  };

  // 某館別底下所有 專案+頻道 群組
  function projectGroupsOf(store) {
    const groups = [];
    const s = STATE.tree[store] || {};
    Object.keys(s).forEach((project) => Object.keys(s[project]).forEach((channel) => groups.push({ project, channel })));
    return groups;
  }

  function buildTree(rows) {
    const tree = {};
    rows.forEach((r) => {
      if (!r.store || !r.project) return;
      const ch = r.channel || '(未填)';
      (((tree[r.store] = tree[r.store] || {})[r.project] =
        tree[r.store][r.project] || {})[ch] =
        tree[r.store][r.project][ch] || []).push(r);
    });
    return tree;
  }

  /* ================================================================== *
   *  UI 面板
   * ================================================================== */
  const UI = {};
  function h(tag, props = {}, kids = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'style') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return el;
  }

  const C = {
    wrap: { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      width: '340px', background: '#fff', border: '1px solid #e2534a',
      borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,.25)',
      font: '13px/1.5 "Microsoft JhengHei",sans-serif', color: '#222', overflow: 'hidden' },
    head: { background: '#e2534a', color: '#fff', padding: '10px 12px', display: 'flex',
      justifyContent: 'space-between', alignItems: 'center', cursor: 'move', fontWeight: '700' },
    body: { padding: '12px', maxHeight: '70vh', overflowY: 'auto' },
    sel: { width: '100%', padding: '6px', margin: '3px 0 8px', border: '1px solid #ccc', borderRadius: '6px' },
    btn: { padding: '8px 10px', margin: '4px 4px 0 0', border: 'none', borderRadius: '6px',
      cursor: 'pointer', fontWeight: '700', color: '#fff', background: '#e2534a' },
    btnGray: { background: '#888' },
    log: { marginTop: '8px', padding: '8px', background: '#f6f6f6', borderRadius: '6px',
      maxHeight: '140px', overflowY: 'auto', fontSize: '12px', whiteSpace: 'pre-wrap' },
  };

  const LOGS = [];
  function log(msg, kind) {
    LOGS.push((kind === 'err' ? '[錯誤] ' : '') + msg);
    const line = h('div', { style: { color: kind === 'err' ? '#c0392b' : kind === 'ok' ? '#27ae60' : '#333' } }, '• ' + msg);
    if (UI.log) { UI.log.appendChild(line); UI.log.scrollTop = UI.log.scrollHeight; }
    console.log('[FUNNOW]', msg);
  }

  /* ---- 診斷蒐集：把我校準所需的畫面結構一次匯出 ---- */
  function dumpEl(el, max = 2500) {
    if (!el) return '(找不到元素)';
    let s = el.outerHTML || '';
    return s.length > max ? s.slice(0, max) + ' …[截斷]' : s;
  }
  function collectDiagnostics() {
    const L = [];
    L.push('==== FUNNOW 診斷報告 ' + CONFIG.VERSION + ' ====');
    try { L.push('時間: ' + new Date().toString()); } catch (e) {}
    L.push('網址: ' + location.href);
    L.push('瀏覽器: ' + navigator.userAgent);
    L.push('');
    L.push('---- 主檔 ----');
    L.push('列數: ' + STATE.allRows.length);
    L.push('館別清單: ' + Object.keys(STATE.tree).join(' | '));
    try {
      Object.keys(STATE.tree).forEach((s) =>
        Object.keys(STATE.tree[s]).forEach((p) =>
          L.push('  · ' + s + ' > ' + p + ' > 頻道:' + Object.keys(STATE.tree[s][p]).join(','))));
    } catch (e) {}
    L.push('');
    L.push('---- 自動偵測結果 ----');
    try { L.push('偵測館別: ' + detectStore()); } catch (e) { L.push('偵測館別 例外:' + e.message); }
    try { L.push('偵測專案: ' + detectProjectName()); } catch (e) { L.push('偵測專案 例外:' + e.message); }
    try { L.push('偵測頻道: ' + detectChannel()); } catch (e) { L.push('偵測頻道 例外:' + e.message); }
    L.push('面板選擇: 館別=' + (UI.storeSel && UI.storeSel.value) + ' / 專案=' + (UI.projSel && UI.projSel.value) + ' / 頻道=' + (UI.chanSel && UI.chanSel.value));
    L.push('');
    L.push('---- 開視窗按鈕候選（含「循環設定/特殊設定/＋」）----');
    const btns = [...document.querySelectorAll('button, .v-btn, .setting-btn')].filter(isVisible);
    btns.filter((b) => /循環設定|特殊設定|限時促銷/.test(b.textContent) || /^[+＋]$/.test(norm(b.textContent)))
      .slice(0, 30).forEach((b) =>
        L.push('  <' + b.tagName.toLowerCase() + ' class="' + (b.className || '') + '"> 文字="' + norm(b.textContent).slice(0, 24) + '"'));
    L.push('（可見按鈕總數: ' + btns.length + '）');
    L.push('');
    L.push('---- 「＋」類小圖示候選 ----');
    [...document.querySelectorAll('button,[class*="add"],[class*="plus"],i,span,svg')]
      .filter((el) => isVisible(el) && /^[+＋]$/.test((el.textContent || '').trim())).slice(0, 15)
      .forEach((el) => L.push('  <' + el.tagName.toLowerCase() + ' class="' + (el.className || '') + '">'));
    L.push('');
    L.push('---- 目前開啟的彈窗(overlay) HTML（看＋新增鈕/表單結構）----');
    const ovs = visible('.v-overlay__content, [role="dialog"]').filter((o) => !o.closest('#fn-panel'));
    if (!ovs.length) L.push('(目前沒有開啟的彈窗)');
    ovs.slice(0, 2).forEach((o, i) => { L.push('[彈窗' + (i + 1) + ']'); L.push(dumpEl(o, 3500)); });
    L.push('');
    if (STATE.lastOverlayHTML) {
      L.push('---- 最近一次「開視窗失敗」時的彈窗 HTML ----');
      L.push(STATE.lastOverlayHTML);
      L.push('');
    }
    L.push('---- 頻道 icon 候選（頂端內容區的 img/svg/i）----');
    [...document.querySelectorAll('img, svg, i, use')]
      .filter((el) => isVisible(el) && !inPanel(el) && inTopContent(el))
      .slice(0, 15).forEach((el) => L.push('  ' + dumpEl(el, 240)));
    L.push('channelBlob = ' + channelIconBlob().slice(0, 500));
    L.push('');
    L.push('---- 專案選擇框 HTML（看結構與頻道 icon）----');
    let projEl = null;
    try {
      const t = detectProjectName();
      if (t) projEl = [...document.querySelectorAll('div,span,p,input')].find((el) => !inPanel(el) && ((el.value || el.textContent || '').trim() === t));
    } catch (e) {}
    L.push(dumpEl(projEl && (projEl.closest('[class*="custom-input"],[class*="v-select"],[class*="v-field"]') || (projEl.parentElement && projEl.parentElement.parentElement)), 2000));
    L.push('');
    L.push('---- 頂端列 HTML（看館別全名/帳號區）----');
    L.push(dumpEl(document.querySelector('header, .v-toolbar, .v-app-bar')));
    L.push('');
    L.push('---- 訊息紀錄（最後 40 筆）----');
    L.push(LOGS.slice(-40).join('\n'));
    return L.join('\n');
  }
  function showDiag() {
    const text = collectDiagnostics();
    if (!UI.diagBox) {
      UI.diagBox = h('textarea', { style: { width: '100%', height: '160px', marginTop: '8px', fontSize: '11px', fontFamily: 'monospace' } });
      UI.body.appendChild(UI.diagBox);
    }
    UI.diagBox.value = text;
    UI.diagBox.style.display = 'block';
    UI.diagBox.focus(); UI.diagBox.select();
    try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (e) {}
    log('已產生診斷（見下方文字框）。Ctrl+A → Ctrl+C 複製後回傳。', 'ok');
  }

  function buildPanel() {
    UI.storeSel = h('select', { style: C.sel });
    UI.projSel = h('select', { style: C.sel });
    UI.chanSel = h('select', { style: C.sel });
    UI.steps = h('div', {});
    UI.log = h('div', { style: C.log });

    UI.detectBtn = h('button', { style: Object.assign({}, C.btn, C.btnGray), onclick: autoDetect }, '🔍 自動偵測');
    UI.startBtn = h('button', { style: C.btn, onclick: onStart }, '▶ 開始');
    UI.reloadBtn = h('button', { style: Object.assign({}, C.btn, C.btnGray), onclick: loadData }, '↻ 重新載入主檔');
    UI.diagBtn = h('button', { style: Object.assign({}, C.btn, { background: '#2c7be5' }), onclick: showDiag }, '🩺 匯出診斷');
    UI.gate = h('div', { style: { marginTop: '6px' } });

    UI.modeSel = h('select', { style: C.sel });
    [['step', '逐步確認（每格我手動存）'],
     ['project', '專案確認（自動存，每專案停）'],
     ['store', '館別確認（自動跑完整館，換館停）'],
     ['full', '全自動（含跨館別，不停）']].forEach(([v, t]) => UI.modeSel.appendChild(h('option', { value: v }, t)));
    UI.modeSel.value = STATE.mode;
    UI.modeSel.addEventListener('change', () => { STATE.mode = UI.modeSel.value; updateStartBtn(); });

    UI.storeSel.addEventListener('change', () => { fillProjects(); refreshSteps(); });
    UI.projSel.addEventListener('change', () => { fillChannels(); refreshSteps(); });
    UI.chanSel.addEventListener('change', refreshSteps);

    const body = h('div', { style: C.body }, [
      h('div', { text: '模式', style: { fontWeight: '700' } }), UI.modeSel,
      h('div', { text: '館別', style: { fontWeight: '700' } }), UI.storeSel,
      h('div', { text: '專案', style: { fontWeight: '700' } }), UI.projSel,
      h('div', { text: '頻道', style: { fontWeight: '700' } }), UI.chanSel,
      UI.detectBtn,
      h('hr', { style: { margin: '10px 0', border: '0', borderTop: '1px solid #eee' } }),
      h('div', { text: '要建立的時段（目前選定群組）', style: { fontWeight: '700' } }),
      UI.steps,
      h('div', { style: { marginTop: '6px' } }, [UI.startBtn]),
      UI.gate,
      h('div', { style: { marginTop: '6px' } }, [UI.reloadBtn, UI.diagBtn]),
      UI.log,
    ]);

    const closeBtn = h('span', { title: '關閉', style: { cursor: 'pointer', fontSize: '18px', lineHeight: '1' },
      onclick: () => window.__FUNNOW__.toggle() }, '✕');
    const head = h('div', { style: C.head }, [
      h('span', {}, 'FUNNOW 一鍵上架 ' + CONFIG.VERSION), closeBtn]);

    const wrap = h('div', { id: 'fn-panel', style: C.wrap }, [head, body]);
    makeDraggable(wrap, head);
    document.body.appendChild(wrap);
    UI.wrap = wrap;
    UI.body = body;
    updateStartBtn();
    return wrap;
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN' && e.target.textContent === '✕') return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = ox + e.clientX - sx + 'px';
      el.style.top = oy + e.clientY - sy + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  /* --- 下拉選單填充 --- */
  function fillSelect(sel, items, placeholder) {
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, placeholder));
    items.forEach((it) => sel.appendChild(h('option', { value: it }, it)));
  }
  function fillStores() { fillSelect(UI.storeSel, Object.keys(STATE.tree), '— 選館別 —'); fillProjects(); }
  function fillProjects() {
    const s = UI.storeSel.value;
    fillSelect(UI.projSel, s && STATE.tree[s] ? Object.keys(STATE.tree[s]) : [], '— 選專案 —');
    fillChannels();
  }
  function fillChannels() {
    const s = UI.storeSel.value, p = UI.projSel.value;
    fillSelect(UI.chanSel, s && p && STATE.tree[s] && STATE.tree[s][p] ? Object.keys(STATE.tree[s][p]) : [], '— 選頻道 —');
  }

  /* --- 顯示選定群組的時段清單 --- */
  function currentRows() {
    const s = UI.storeSel.value, p = UI.projSel.value, c = UI.chanSel.value;
    if (s && p && c && STATE.tree[s] && STATE.tree[s][p] && STATE.tree[s][p][c])
      return STATE.tree[s][p][c];
    return [];
  }
  function refreshSteps() {
    const rows = currentRows();
    STATE.steps = rows.map(toStepConfig);
    STATE.stepIndex = 0;
    STATE.running = false;
    UI.steps.innerHTML = '';
    if (!rows.length) {
      UI.steps.appendChild(h('div', { style: { color: '#c0392b' } }, '（尚未選定，或主檔沒有對應資料）'));
    } else {
      STATE.steps.forEach((st, i) => {
        const desc = st.type === 'cyclic'
          ? `循環・${st.name}｜$${st.price}｜${st.days.join('')}｜${st.hour}:${st.minute}`
          : `特殊・${st.name}｜$${st.price}｜${st.sessions.length} 場`;
        UI.steps.appendChild(h('div', { id: 'fn-step-' + i, style: { padding: '3px 0' } }, '☐ ' + desc));
      });
    }
    updateStartBtn();
  }

  function markStep(i, symbol) {
    const el = document.getElementById('fn-step-' + i);
    if (el) el.textContent = symbol + ' ' + el.textContent.replace(/^.\s/, '');
  }

  /* --- 啟用/停用「開始」 --- */
  function canStart() {
    if (!Object.keys(STATE.tree).length) return false;
    if (STATE.mode === 'step') return currentRows().length > 0;
    if (STATE.mode === 'project') return !!UI.storeSel.value && projectGroupsOf(UI.storeSel.value).length > 0;
    return true; // store / full：主檔非空即可
  }
  function setEngineButtons(running) {
    if (UI.startBtn) UI.startBtn.style.display = running ? 'none' : (canStart() ? 'inline-block' : 'none');
    if (!running && UI.gate) UI.gate.innerHTML = '';
  }
  function updateStartBtn() { if (!STATE.running) setEngineButtons(false); }

  /* --- 閘門：暫停並等使用者點按鈕，回傳動作 --- */
  let gateResolve = null;
  function gate(kind, msg) {
    let buttons;
    if (kind === 'slot') buttons = [['下一步 ▶', 'next'], ['略過此步', 'skip', 1], ['重填此步', 'retry', 1]];
    else if (kind === 'error') buttons = [['重填此步', 'retry'], ['略過此步', 'skip', 1], ['停止', 'stop', 1]];
    else buttons = [['繼續 ▶', 'next'], ['停止', 'stop', 1]];
    return new Promise((resolve) => {
      gateResolve = resolve;
      UI.gate.innerHTML = '';
      UI.gate.appendChild(h('div', { style: { margin: '4px 0', color: '#c53f37', fontWeight: '700' } }, msg));
      buttons.forEach(([label, val, gray]) =>
        UI.gate.appendChild(h('button', { style: Object.assign({}, C.btn, gray ? C.btnGray : {}), onclick: () => resolveGate(val) }, label)));
    });
  }
  function resolveGate(v) { if (gateResolve) { const r = gateResolve; gateResolve = null; UI.gate.innerHTML = ''; r(v); } }

  /* ================================================================== *
   *  批次執行引擎（依模式在不同層級暫停）
   * ================================================================== */
  async function runEngine() {
    if (STATE.running) return;
    const mode = STATE.mode;
    STATE.running = true;
    setEngineButtons(true);
    try {
      const stores = (mode === 'store' || mode === 'full') ? Object.keys(STATE.tree) : [UI.storeSel.value];
      for (let si = 0; si < stores.length; si++) {
        const store = stores[si];
        if (!store) continue;
        if (mode === 'store' || mode === 'full') {
          await closeAnyDialog();
          if (!storeMatches(store)) { log('🏨 切換館別 → ' + store); await switchStore(store); }
        }
        const groups = (mode === 'step')
          ? [{ project: UI.projSel.value, channel: UI.chanSel.value }]
          : projectGroupsOf(store);
        for (let pi = 0; pi < groups.length; pi++) {
          const { project, channel } = groups[pi];
          const slots = ((STATE.tree[store] && STATE.tree[store][project] && STATE.tree[store][project][channel]) || []).map(toStepConfig);
          if (!slots.length) continue;
          if (mode !== 'step') { await closeAnyDialog(); log(`📁 切換專案 → ${project}（${channel}）`); await switchProject(project, channel); }
          log(`▶ 專案「${project}／${channel}」：${slots.length} 個時段`);
          for (let ki = 0; ki < slots.length; ki++) {
            const slot = slots[ki];
            let redo = true;
            while (redo) {
              redo = false;
              try {
                if (mode === 'step') markStep(ki, '⏳');
                const root = slot.type === 'cyclic' ? await openCyclicDialog() : await openSpecialDialog();
                await (slot.type === 'cyclic' ? fillCyclic : fillSpecial)(root, slot);
                if (mode === 'step') {
                  markStep(ki, '✍');
                  const act = await gate('slot', `【${slot.name}】已填好：檢查 → 按頁面「儲存」→ 按〔下一步〕`);
                  if (act === 'retry') { await closeAnyDialog(); redo = true; continue; }
                  if (act === 'skip') { markStep(ki, '⏭'); break; }
                  if (act === 'stop') throw new Error('__STOP__');
                  markStep(ki, '✅');
                } else {
                  await autoSaveDialog(root);
                  log(`【${slot.name}】已自動儲存 ✓`, 'ok');
                }
              } catch (e) {
                if ((e && e.message) === '__STOP__') throw e;
                log('錯誤：' + (e && e.message || e), 'err');
                const act = await gate('error', `這一步（${slot.name}）出錯，要怎麼做？`);
                if (act === 'retry') { await closeAnyDialog(); redo = true; continue; }
                if (act === 'stop') throw new Error('__STOP__');
                if (mode === 'step') markStep(ki, '⚠'); // skip
              }
            }
          }
          if (mode === 'project') { const a = await gate('boundary', `✅ 已完成專案「${project}」，確認後按〔繼續〕做下一個`); if (a === 'stop') throw new Error('__STOP__'); }
        }
        if (mode === 'store') { const a = await gate('boundary', `✅ 已完成館別「${store}」，確認後按〔繼續〕切換下一館`); if (a === 'stop') throw new Error('__STOP__'); }
      }
      log('🎉 批次完成！', 'ok');
    } catch (e) {
      log((e && e.message) === '__STOP__' ? '⏹ 已停止。' : ('引擎中止：' + (e && e.message || e)), 'err');
    }
    STATE.running = false;
    setEngineButtons(false);
  }

  function onStart() { runEngine(); }

  /* --- 自動偵測 --- */
  function autoDetect() {
    const store = detectStore(), proj = detectProjectName(), chan = detectChannel();
    log(`偵測：館別「${store || '?'}」／專案「${proj || '?'}」／頻道「${chan || '?'}」`);
    // 嘗試在下拉中比對（用「包含」寬鬆比對）
    const pick = (sel, want) => {
      if (!want) return false;
      const w = keyNorm(want);
      if (!w) return false;
      const opt = [...sel.options].find((o) => {
        if (!o.value) return false;
        const v = keyNorm(o.value);
        return v === w || v.includes(w) || w.includes(v) || v.startsWith(w) || w.startsWith(v);
      });
      if (opt) { sel.value = opt.value; return true; }
      return false;
    };
    if (pick(UI.storeSel, store)) fillProjects();
    if (pick(UI.projSel, proj)) fillChannels();
    pick(UI.chanSel, chan);
    refreshSteps();
    if (!currentRows().length) log('自動比對未命中，請手動用上面三個下拉選單指定。', 'err');
    else log('已自動選定，請確認上方時段清單無誤後按〔開始〕。', 'ok');
  }

  /* --- 載入主檔 --- */
  async function loadData() {
    log('載入主檔中…');
    if (!CONFIG.CSV_URL || CONFIG.CSV_URL.includes('PASTE_YOUR')) {
      log('尚未設定 CSV_URL，請在 funnow.js 內填入 Google Sheet 的 CSV 網址。', 'err');
      return;
    }
    try {
      const url = CONFIG.CSV_URL + (CONFIG.CSV_URL.includes('?') ? '&' : '?') + 't=' + Date.now();
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      STATE.allRows = rowsToObjects(parseCSV(text)).filter((r) => r.store && r.project);
      STATE.tree = buildTree(STATE.allRows);
      log(`主檔載入成功：${STATE.allRows.length} 列、${Object.keys(STATE.tree).length} 個館別。`, 'ok');
      fillStores();
      refreshSteps();
      autoDetect();
    } catch (e) {
      log('載入主檔失敗：' + (e && e.message || e), 'err');
      log('若是跨網域(CORS)問題，改用 gviz 版 CSV 網址，或告訴我協助處理。', 'err');
    }
  }

  /* ================================================================== *
   *  啟動
   * ================================================================== */
  window.__FUNNOW__ = {
    toggle() {
      if (!UI.wrap) return;
      UI.wrap.style.display = UI.wrap.style.display === 'none' ? 'block' : 'none';
    },
    state: STATE,
    reload: loadData,
  };

  buildPanel();
  window.__FUNNOW__.panel = UI.wrap;
  loadData();
})();
