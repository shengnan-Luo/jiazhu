const $ = (id) => document.getElementById(id);
const escapeHTML = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || '没有响应');
  return res.data;
}

let s;
let savedTimer = 0;

async function save(patch) {
  s = await igSetSettings(patch);
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1500);
  renderPreview();
}

function renderPreview() {
  document.documentElement.style.setProperty('--ig-color', s.color);
  document.documentElement.style.setProperty('--ig-size', `${s.size}%`);
  $('sizeVal').textContent = `${s.size}%`;
}

function bindSettings() {
  $('level').value = String(s.level);
  $('showRare').checked = s.showRare;
  $('firstOnly').checked = s.firstOnly;
  $('zh').checked = s.zh;
  for (const box of $('zhLists').querySelectorAll('input')) box.checked = s.zhLists.includes(Number(box.value));
  $('color').value = s.color;
  $('colorDark').value = s.colorDark;
  $('size').value = s.size;
  $('ai').checked = s.ai;
  $('aiBase').value = s.aiBase;
  $('aiKey').value = s.aiKey;
  $('aiModel').value = s.aiModel;
  $('deeplxUrl').value = s.deeplxUrl;
  $('deeplxToken').value = s.deeplxToken;
  renderPreview();

  $('level').onchange = (e) => save({ level: Number(e.target.value) });
  for (const id of ['showRare', 'firstOnly', 'zh', 'ai']) $(id).onchange = (e) => save({ [id]: e.target.checked });
  $('zhLists').onchange = () => {
    const boxes = [...$('zhLists').querySelectorAll('input:checked')];
    save({ zhLists: boxes.map((b) => Number(b.value)) });
  };
  for (const id of ['color', 'colorDark']) $(id).onchange = (e) => save({ [id]: e.target.value });
  $('size').oninput = (e) => save({ size: Number(e.target.value) });
  for (const id of ['aiBase', 'aiKey', 'aiModel', 'deeplxUrl', 'deeplxToken']) {
    $(id).onchange = (e) => save({ [id]: e.target.value.trim() });
  }

  const test = (btn, out, type, ok) => {
    $(btn).onclick = async () => {
      $(out).className = 'result';
      $(out).textContent = '测试中…';
      try {
        const r = await send(type);
        $(out).className = 'result ok';
        $(out).textContent = ok(r);
      } catch (e) {
        $(out).className = 'result err';
        $(out).textContent = e.message;
      }
    };
  };
  test('testAI', 'testAIResult', 'testAI', (r) => `连接成功：${r}`);
  test('testDeepLX', 'testDeepLXResult', 'testDeepLX', (r) => `Hello, world. → ${r}`);
}

// ---------- 生词本 ----------

async function renderVocab() {
  const { vocab } = await igGetLists();
  const q = $('vocabSearch').value.trim().toLowerCase();
  const rows = Object.entries(vocab)
    .filter(([w, v]) => !q || w.includes(q) || (v.gloss || '').includes(q) || (v.sentence || '').toLowerCase().includes(q))
    .sort((a, b) => (b[1].time || 0) - (a[1].time || 0));
  $('vocabCount').textContent = Object.keys(vocab).length;
  $('vocabEmpty').hidden = rows.length > 0;
  $('vocabBody').innerHTML = rows
    .map(
      ([w, v]) => `<tr>
        <td class="word">${escapeHTML(w)}</td>
        <td>${escapeHTML(v.gloss)}</td>
        <td class="sentence">${escapeHTML(v.sentence)}${v.url ? ` <a href="${escapeHTML(v.url)}" target="_blank" rel="noreferrer" title="${escapeHTML(v.title)}">来源</a>` : ''}</td>
        <td class="date">${v.time ? new Date(v.time).toLocaleDateString() : ''}</td>
        <td><button data-del="${escapeHTML(w)}">移出</button></td>
      </tr>`,
    )
    .join('');
}

function csvCell(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

async function exportAnki() {
  const { vocab } = await igGetLists();
  const lines = [['单词', '释义', '原句', '来源', '日期'].join(',')];
  for (const [w, v] of Object.entries(vocab)) {
    lines.push(
      [w, v.gloss, v.sentence, v.url, v.time ? new Date(v.time).toLocaleDateString() : ''].map(csvCell).join(','),
    );
  }
  download(`夹注生词本-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${lines.join('\n')}`, 'text/csv');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 已认识的词 ----------

async function renderKnown() {
  const { known } = await igGetLists();
  const q = $('knownSearch').value.trim().toLowerCase();
  const list = known.filter((w) => !q || w.includes(q)).sort();
  $('knownCount').textContent = known.length;
  const shown = list.slice(0, 800);
  $('knownList').innerHTML =
    shown.map((w) => `<span class="chip" data-w="${escapeHTML(w)}" title="点击撤销">${escapeHTML(w)}</span>`).join('') +
    (list.length > shown.length ? `<span class="muted">…还有 ${list.length - shown.length} 个，用搜索查找</span>` : '');
}

async function importKnown() {
  const words = [...new Set($('knownImport').value.toLowerCase().match(/[a-z]{2,}/g) || [])];
  if (!words.length) return;
  const info = await send('lookup', { words }).catch(() => ({}));
  const { known } = await igGetLists();
  const set = new Set(known);
  for (const w of words) set.add(info[w]?.lemma || w);
  await chrome.storage.local.set({ known: [...set] });
  $('knownImport').value = '';
}

// ---------- 网站 ----------

// 只显示和当前默认状态相关的例外列表
const sitesKey = () => (s.enabled ? 'disabledSites' : 'enabledSites');

function renderSites() {
  const list = s[sitesKey()];
  $('enabled').checked = s.enabled;
  $('sitesTitle').textContent = s.enabled ? '单独关闭的网站' : '单独开启的网站';
  $('sitesEmpty').hidden = list.length > 0;
  $('sites').innerHTML = list
    .map((h) => `<span class="chip" data-site="${escapeHTML(h)}" title="点击移除，恢复默认">${escapeHTML(h)}</span>`)
    .join('');
}

// ---------- 备份 ----------

async function backup() {
  const { known, vocab } = await igGetLists();
  const { aiKey, deeplxToken, ...settings } = s;
  const data = { app: 'inline-gloss', version: 1, settings, known, vocab };
  download(`夹注备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'inline-gloss') throw new Error('不是夹注的备份文件');
    const lists = await igGetLists();
    const known = [...new Set([...lists.known, ...(data.known || [])])];
    const vocab = { ...lists.vocab, ...(data.vocab || {}) };
    const { aiKey, deeplxToken, ...settings } = data.settings || {};
    await chrome.storage.local.set({ known, vocab, settings: { ...s, ...settings } });
    $('backupResult').className = 'result ok';
    $('backupResult').textContent = `已导入：生词 ${Object.keys(data.vocab || {}).length} 个，已认识 ${(data.known || []).length} 个`;
  } catch (e) {
    $('backupResult').className = 'result err';
    $('backupResult').textContent = `导入失败：${e.message}`;
  }
}

// ---------- 启动 ----------

async function main() {
  s = await igGetSettings();
  bindSettings();
  renderVocab();
  renderKnown();
  renderSites();

  $('vocabSearch').oninput = renderVocab;
  $('knownSearch').oninput = renderKnown;
  $('exportAnki').onclick = exportAnki;
  $('vocabBody').onclick = (e) => {
    const w = e.target.dataset.del;
    if (w) igSetVocab(w, null);
  };
  $('knownList').onclick = (e) => {
    const w = e.target.dataset.w;
    if (w) igSetKnown(w, false);
  };
  $('knownImportBtn').onclick = importKnown;
  $('enabled').onchange = (e) => save({ enabled: e.target.checked }).then(renderSites);
  $('sites').onclick = (e) => {
    const h = e.target.dataset.site;
    if (h) save({ [sitesKey()]: s[sitesKey()].filter((x) => x !== h) });
  };
  $('backup').onclick = backup;
  $('restore').onchange = (e) => e.target.files[0] && restore(e.target.files[0]);
  $('shortcuts').onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };

  const commands = await chrome.commands.getAll();
  $('shortcut').textContent = commands.find((c) => c.name === 'toggle-gloss')?.shortcut || '未设置';

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.vocab) renderVocab();
    if (changes.known) renderKnown();
    if (changes.settings) {
      s = { ...IG_DEFAULTS, ...changes.settings.newValue };
      renderSites();
      if (changes.settings.oldValue?.ai !== s.ai) $('ai').checked = s.ai;
    }
  });
}

main();
