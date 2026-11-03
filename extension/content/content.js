// 夹注：在英文网页的生词后面显示中文释义
(() => {
  if (window.__igLoaded) return;
  window.__igLoaded = true;

  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'code', 'pre', 'kbd', 'samp', 'var', 'math', 'svg', 'canvas', 'iframe', 'object', 'nav',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    'footer', 'label', 'menu', '[aria-hidden="true"]',
    '[role="navigation"]', '[role="button"]', '[role="menu"]', '[role="menubar"]', '[role="menuitem"]',
    '[role="tab"]', '[role="tablist"]', '[role="toolbar"]', '[role="search"]', '[role="banner"]', '[role="contentinfo"]',
    '.MathJax', '.MathJax_Display', 'mjx-container', '.katex', '.mw-editsection',
    '.ig-w', '.ig-p', 'ig-host',
  ].join(',');
  // 页面声明不翻译的区域；挂在 html/body 上的不算，否则整页都不处理
  const SOFT_SKIP = '[translate="no"],.notranslate';
  const BLOCK_SELECTOR =
    'p,li,dd,dt,td,th,blockquote,figcaption,caption,h1,h2,h3,h4,h5,h6,summary,div,section,article,aside,main,body';
  const TOKEN_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  // 参考文献列表不发给 AI，省钱
  const REF_SELECTOR =
    '#references,.references,.ref-list,.reference-list,.bibliography,[id^="bib"],[class*="bibliograph"],[id*="reference"],[class*="references"]';

  let settings = { ...IG_DEFAULTS };
  let known = new Set();
  let vocab = {};
  let started = false;
  let observer = null;
  const cache = new Map(); // 小写单词 -> 词典结果 | null
  let blockSeen = new WeakMap(); // 段落 -> 已显示过释义的原形
  let blockUnknown = new WeakMap(); // 段落 -> 词典里没有的词（交给 AI）
  let aiDone = new WeakSet();
  const blocks = new Set();

  // ---------- 工具 ----------

  async function send(type, payload = {}) {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res) throw new Error('扩展没有响应，请刷新页面');
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  const idle = () =>
    new Promise((resolve) =>
      window.requestIdleCallback ? requestIdleCallback(resolve, { timeout: 200 }) : setTimeout(resolve, 0),
    );

  const escapeHTML = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function normalize(token) {
    const w = token.replace(/['’]s$/i, '');
    if (/['’]/.test(w) || w.length < 3) return null;
    return w.toLowerCase();
  }

  function skipElement(el) {
    if (el.matches(SKIP_SELECTOR)) return true;
    return el !== document.body && el !== document.documentElement && el.matches(SOFT_SKIP);
  }

  function isSkipped(el) {
    for (let e = el; e; e = e.parentElement) if (skipElement(e)) return true;
    return false;
  }

  const blockOf = (el) => el.closest(BLOCK_SELECTOR) || document.body;

  // 段落自己的文字（不含嵌套段落），附带每个文本节点的起始位置
  function ownText(block) {
    const parts = [];
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (node.matches('.ig-w')) return NodeFilter.FILTER_SKIP;
        if (node.matches(BLOCK_SELECTOR) || skipElement(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      parts.push({ node, start: text.length });
      text += node.data;
    }
    return { text, parts };
  }

  const ownSpans = (block) => [...block.querySelectorAll('.ig-w')].filter((s) => blockOf(s) === block);

  // 取 node 中 offset 位置所在的句子
  function sentenceAt(node, offset = 0) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    const textNode = node.nodeType === 3 ? node : node.firstChild;
    const { text, parts } = ownText(blockOf(el));
    const part = parts.find((p) => p.node === textNode);
    const pos = part ? part.start + offset : 0;
    const re = /[.!?]["'”’)\]]*\s+(?=[A-Z"“(\[])/g;
    let start = 0;
    let end = text.length;
    let m;
    while ((m = re.exec(text))) {
      if (m.index + m[0].length <= pos) start = m.index + m[0].length;
      else {
        end = m.index + 1;
        break;
      }
    }
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 600);
  }

  // ---------- 标注 ----------

  function shouldAnnotate(info, word) {
    if (known.has(info.lemma)) return false;
    if (vocab[info.lemma]) return true;
    if (info.level === 6) return settings.showRare && word.length >= 5;
    return info.level >= settings.level;
  }

  // 是否在句首；在文本节点开头、无法判断时返回 null
  function sentenceStart(text, i) {
    for (let j = i - 1; j >= 0; j--) {
      const c = text[j];
      if (/[\s"'“‘(\[]/.test(c)) continue;
      return /[.!?:;•·—–-]/.test(c);
    }
    return null;
  }

  function plausible(raw, text, start, end, heading, prose) {
    const prev = text[start - 1] || '';
    const next = text[end] || '';
    if (/[0-9_@#/\\]/.test(prev) || /[0-9_@/\\]/.test(next)) return false;
    // 网址、文件名
    if (prev === '.' && /[A-Za-z]/.test(text[start - 2] || '')) return false;
    if (next === '.' && /[A-Za-z]/.test(text[end + 1] || '')) return false;
    // 缩写、驼峰、化学式
    if (/[A-Z]/.test(raw.slice(1))) return false;
    // 句中大写的词多半是专有名词；短文本开头的大写词多半是按钮、菜单、日期之类的界面文字
    if (/^[A-Z]/.test(raw) && !heading) {
      const s = sentenceStart(text, start);
      if (s === false || (s === null && !prose)) return false;
    }
    return true;
  }

  function makeSpan(text, info, block) {
    const span = document.createElement('span');
    span.className = 'ig-w';
    span.textContent = text;
    span.dataset.l = info.lemma;
    span.dataset.g = info.gloss;
    span.dataset.lv = info.level ?? '';
    if (vocab[info.lemma]) span.classList.add('ig-vocab');
    if (settings.firstOnly) {
      let seen = blockSeen.get(block);
      if (!seen) blockSeen.set(block, (seen = new Set()));
      if (seen.has(info.lemma)) span.classList.add('ig-rep');
      else seen.add(info.lemma);
    }
    return span;
  }

  function registerBlock(block) {
    if (blocks.has(block)) return;
    blocks.add(block);
    if (io && !aiDone.has(block)) io.observe(block);
  }

  function annotateNode(node) {
    const parent = node.parentElement;
    if (!parent) return;
    const text = node.data;
    const heading = !!parent.closest('h1,h2,h3,h4,h5,h6');
    const prose = (text.match(/[A-Za-z]+/g) || []).length >= 5;
    const block = blockOf(parent);
    registerBlock(block);
    let frag = null;
    let last = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
      const raw = m[0];
      const start = m.index;
      const w = normalize(raw);
      if (!w || !plausible(raw, text, start, start + raw.length, heading, prose)) continue;
      const info = cache.get(w);
      if (!info) {
        if (settings.ai && /^[a-z]{5,}$/.test(raw)) {
          let set = blockUnknown.get(block);
          if (!set) blockUnknown.set(block, (set = new Set()));
          set.add(raw);
        }
        continue;
      }
      if (!shouldAnnotate(info, w)) continue;
      const wordText = raw.replace(/['’]s$/i, '');
      frag ??= document.createDocumentFragment();
      if (start > last) frag.append(text.slice(last, start));
      frag.append(makeSpan(wordText, info, block));
      last = start + wordText.length;
    }
    if (!frag) return;
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }

  function collectTextNodes(root) {
    if (root.nodeType === 3) return /[A-Za-z]{3}/.test(root.data) ? [root] : [];
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) return skipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return /[A-Za-z]{3}/.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  async function doProcess(root) {
    if (!root?.isConnected) return;
    const el = root.nodeType === 1 ? root : root.parentElement;
    if (!el || isSkipped(el)) return;
    const t0 = performance.now();
    const nodes = collectTextNodes(root);
    if (!nodes.length) return;

    const need = new Set();
    for (const n of nodes) {
      for (const m of n.data.matchAll(TOKEN_RE)) {
        const w = normalize(m[0]);
        if (w && !cache.has(w)) need.add(w);
      }
    }
    const words = [...need];
    for (let i = 0; i < words.length; i += 2000) {
      const batch = words.slice(i, i + 2000);
      const res = await send('lookup', { words: batch });
      for (const w of batch) cache.set(w, res[w] || null);
    }
    const t1 = performance.now();

    for (let i = 0; i < nodes.length; i += 200) {
      for (const n of nodes.slice(i, i + 200)) if (n.isConnected) annotateNode(n);
      observer?.takeRecords();
      await idle();
    }
    console.debug(
      `[夹注] ${nodes.length} 个文本节点，查词 ${words.length} 个 ${Math.round(t1 - t0)}ms，标注 ${Math.round(performance.now() - t1)}ms`,
    );
  }

  let queue = Promise.resolve();
  function processRoot(root) {
    queue = queue.then(() => doProcess(root)).catch((e) => console.debug('[夹注]', e));
    return queue;
  }

  let pending = new Set();
  let timer = 0;
  function onMutations(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 3 || (n.nodeType === 1 && !n.matches('.ig-w,.ig-p,ig-host'))) pending.add(n);
      }
    }
    if (pending.size && !timer) timer = setTimeout(flushMutations, 400);
  }

  function flushMutations() {
    timer = 0;
    const roots = [...pending].filter((n) => n.isConnected);
    pending = new Set();
    if (roots.length > 200) {
      processRoot(document.body);
      return;
    }
    for (const r of roots) if (!roots.some((o) => o !== r && o.contains(r))) processRoot(r);
  }

  function unwrap(spans) {
    const parents = new Set();
    for (const s of spans) {
      parents.add(s.parentNode);
      s.replaceWith(s.textContent);
    }
    for (const p of parents) p?.normalize();
    observer?.takeRecords();
  }

  function reset() {
    document.querySelectorAll('.ig-p').forEach((p) => p.remove());
    unwrap(document.querySelectorAll('.ig-w'));
    blockSeen = new WeakMap();
    blockUnknown = new WeakMap();
    aiDone = new WeakSet();
    blocks.clear();
    io?.disconnect();
    processRoot(document.body).then(setupAI);
  }

  // ---------- 开关与设置 ----------

  const isActive = () => settings.enabled && !igSiteDisabled(settings, location.hostname);

  function detectDark() {
    const bg = [document.body, document.documentElement]
      .map((el) => el && getComputedStyle(el).backgroundColor)
      .find((c) => c && !/rgba\(.*,\s*0\)|transparent/.test(c));
    const rgb = bg?.match(/\d+(\.\d+)?/g)?.map(Number);
    const dark = !!rgb && 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 110;
    document.documentElement.toggleAttribute('data-ig-dark', dark);
  }

  function applyStyleVars() {
    const s = document.documentElement.style;
    s.setProperty('--ig-color', settings.color);
    s.setProperty('--ig-color-dark', settings.colorDark);
    s.setProperty('--ig-size', `${settings.size}%`);
  }

  async function start() {
    document.documentElement.classList.remove('ig-off');
    if (started) return;
    started = true;
    detectDark();
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    await processRoot(document.body);
    setupAI();
  }

  function toggle() {
    if (!started) start();
    else document.documentElement.classList.toggle('ig-off');
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.known || changes.vocab) {
      const oldKnown = known;
      const oldVocab = vocab;
      if (changes.known) known = new Set(changes.known.newValue || []);
      if (changes.vocab) vocab = changes.vocab.newValue || {};
      const newlyKnown = [...known].filter((w) => !oldKnown.has(w));
      if (newlyKnown.length) {
        const set = new Set(newlyKnown);
        const spans = [...document.querySelectorAll('.ig-w')].filter((s) => set.has(s.dataset.l));
        for (const s of spans) blockSeen.get(blockOf(s))?.delete(s.dataset.l);
        unwrap(spans);
      }
      document.querySelectorAll('.ig-w').forEach((s) => s.classList.toggle('ig-vocab', !!vocab[s.dataset.l]));
      const unknownAgain = [...oldKnown].some((w) => !known.has(w));
      const newVocab = Object.keys(vocab).some((w) => !oldVocab[w]);
      if (started && (unknownAgain || newVocab)) processRoot(document.body);
    }
    if (changes.settings) {
      const old = settings;
      settings = { ...IG_DEFAULTS, ...changes.settings.newValue };
      applyStyleVars();
      if (!isActive()) {
        document.documentElement.classList.add('ig-off');
        return;
      }
      if (!started) {
        start();
        return;
      }
      document.documentElement.classList.remove('ig-off');
      if (old.level !== settings.level || old.showRare !== settings.showRare || old.firstOnly !== settings.firstOnly) {
        reset();
      } else if (settings.ai && settings.aiKey && (!old.ai || !old.aiKey)) {
        // 打开 AI 后重新扫描一遍，收集词典里没有的词
        processRoot(document.body).then(setupAI);
      }
    }
  }

  // ---------- AI 语境释义 ----------

  let io = null;
  const aiQueue = [];
  let aiRunning = 0;
  const aiStats = { done: 0, failed: 0, error: '' };

  function setupAI() {
    if (!settings.ai || !settings.aiKey) return;
    io ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          if (aiDone.has(e.target)) continue;
          aiDone.add(e.target);
          aiQueue.push(e.target);
        }
        pumpAI();
      },
      { rootMargin: '300px 0px' },
    );
    for (const b of blocks) if (b.isConnected && !aiDone.has(b)) io.observe(b);
  }

  function pumpAI() {
    while (aiRunning < 2 && aiQueue.length) {
      const block = aiQueue.shift();
      aiRunning++;
      runAI(block)
        .then((done) => done && aiStats.done++)
        .catch((e) => {
          aiStats.failed++;
          aiStats.error = e.message;
          // 每个页面只提示一次，免得刷屏
          if (aiStats.failed === 1) showToast(`夹注：AI 释义失败（${e.message.slice(0, 120)}）。请到插件设置页检查 AI 配置。`);
        })
        .finally(() => {
          aiRunning--;
          pumpAI();
        });
    }
  }

  async function runAI(block) {
    if (!block.isConnected || !settings.ai || !isActive() || block.closest(REF_SELECTOR)) return false;
    const { text } = ownText(block);
    if (text.replace(/\s+/g, ' ').trim().length < 60) return false;
    const words = [
      ...new Set([...ownSpans(block).map((s) => s.textContent), ...(blockUnknown.get(block) || [])]),
    ];
    const res = await send('aiGloss', { text: text.slice(0, 3000), words });
    if (!res || !block.isConnected) return false;
    applyAI(block, res);
    return true;
  }

  function applyAI(block, res) {
    const glosses = {};
    for (const [k, v] of Object.entries(res.words || {})) if (typeof v === 'string' && v) glosses[k.toLowerCase()] = v;
    for (const s of ownSpans(block)) {
      const zh = glosses[s.textContent.toLowerCase()];
      if (zh) setAIGloss(s, zh);
    }
    for (const w of blockUnknown.get(block) || []) {
      const zh = glosses[w.toLowerCase()];
      if (zh && !known.has(w.toLowerCase())) wrapFirst(block, w, zh);
    }
    for (const s of Array.isArray(res.senses) ? res.senses : []) {
      if (s?.word && s?.zh) wrapFirst(block, s.word, s.zh);
    }
    for (const p of Array.isArray(res.phrases) ? res.phrases : []) {
      if (p?.text && p?.zh && /\s/.test(p.text.trim())) insertPhrase(block, p.text, p.zh);
    }
    observer?.takeRecords();
  }

  function setAIGloss(span, zh) {
    span.dataset.d ??= span.dataset.g;
    span.dataset.g = zh;
    span.dataset.ai = zh;
    span.classList.add('ig-ai');
  }

  // 把段落里第一次出现的 word 包起来（AI 补充的词）
  function wrapFirst(block, word, zh) {
    const lower = word.toLowerCase();
    const existing = ownSpans(block).filter((s) => s.textContent.toLowerCase() === lower);
    if (existing.length) {
      existing.forEach((s) => setAIGloss(s, zh));
      return;
    }
    const re = new RegExp(`(?<![A-Za-z])${escapeRe(word)}(?![A-Za-z])`, 'i');
    for (const { node } of ownText(block).parts) {
      if (node.parentElement.closest('.ig-w')) continue;
      const m = re.exec(node.data);
      if (!m) continue;
      const span = makeSpan(m[0], { lemma: lower, gloss: zh, level: '' }, block);
      setAIGloss(span, zh);
      span.dataset.d = '';
      const rest = node.splitText(m.index);
      rest.data = rest.data.slice(m[0].length);
      rest.before(span);
      return;
    }
  }

  // 在短语末尾插入短语释义
  function insertPhrase(block, phrase, zh) {
    const { text, parts } = ownText(block);
    const re = new RegExp(`(?<![A-Za-z])${phrase.trim().split(/\s+/).map(escapeRe).join('\\s+')}(?![A-Za-z])`, 'i');
    const m = re.exec(text);
    if (!m) return;
    const end = m.index + m[0].length;
    const part = parts.find((p) => p.start < end && end <= p.start + p.node.data.length);
    if (!part) return;
    const marker = document.createElement('span');
    marker.className = 'ig-p';
    marker.dataset.g = zh;
    marker.dataset.phrase = m[0].replace(/\s+/g, ' ');
    const wordSpan = part.node.parentElement.closest('.ig-w');
    if (wordSpan) {
      // 短语最后一个词本身有释义时，改成悬停显示，避免两个释义挤在一起
      wordSpan.classList.add('ig-rep');
      wordSpan.after(marker);
    } else {
      const local = end - part.start;
      if (local < part.node.data.length) part.node.splitText(local);
      part.node.after(marker);
    }
  }

  // ---------- 卡片 ----------

  const LEVEL_TEXT = { ...IG_LEVELS, '': 'AI' };
  let host;
  let card;
  let dot;
  let toast;
  let anchorRect = null;
  let placement = 'below';
  let current = null;

  const CARD_CSS = `
    :host { all: initial; }
    .card, .toast { font: 14px/1.6 system-ui, -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; }
    .card {
      position: absolute; width: 320px; max-width: calc(100vw - 16px); max-height: 60vh; overflow: auto;
      box-sizing: border-box; padding: 12px 14px; border-radius: 10px;
      background: #fff; color: #1f2328; border: 1px solid #d0d7de;
      box-shadow: 0 8px 24px rgba(0,0,0,.18);
    }
    [hidden] { display: none !important; }
    .head { display: flex; align-items: baseline; gap: 8px; }
    .word { font-size: 18px; font-weight: 600; word-break: break-word; }
    .lv { font-size: 12px; padding: 0 6px; border-radius: 4px; background: #e6f4f1; color: #0f7b6c; white-space: nowrap; }
    .x { margin-left: auto; border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #8c959f; padding: 0 2px; }
    .ph { color: #656d76; font-size: 13px; }
    .ai { margin-top: 6px; padding: 4px 8px; border-radius: 6px; background: #f3f0ff; color: #5f3dc4; }
    .tr { margin-top: 6px; white-space: pre-line; font-size: 13px; color: #31363b; }
    .src { color: #656d76; font-size: 13px; white-space: pre-line; }
    .out { margin-top: 8px; white-space: pre-line; font-size: 13px; }
    .out:empty { display: none; }
    .muted { color: #8c959f; }
    .note { margin-top: 6px; font-size: 12px; color: #8c959f; }
    .err { color: #cf222e; }
    .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .acts button {
      border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; border-radius: 6px;
      padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .acts button:hover { background: #eaeef2; }
    .acts .on { background: #fff4e6; border-color: #ffc078; color: #c2410c; }
    .dot {
      position: absolute; width: 14px; height: 14px; padding: 0; margin: 0;
      border: 2px solid #fff; border-radius: 50%; background: #0f7b6c; cursor: pointer;
      box-shadow: 0 1px 4px rgba(0,0,0,.35); transition: transform .1s;
    }
    .dot:hover { transform: scale(1.35); }
    .toast {
      position: fixed; right: 16px; bottom: 16px; max-width: 360px; padding: 10px 14px; border-radius: 8px;
      background: #3d1d1d; color: #fff; font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.25); cursor: pointer;
    }
    @media (prefers-color-scheme: dark) {
      .card { background: #22272e; color: #e6edf3; border-color: #444c56; }
      .lv { background: #12403a; color: #5eead4; }
      .ph, .src, .muted, .note { color: #9198a1; }
      .tr { color: #d1d7e0; }
      .ai { background: #2e2650; color: #c4b5fd; }
      .acts button { background: #2d333b; color: #e6edf3; border-color: #444c56; }
      .acts button:hover { background: #373e47; }
      .acts .on { background: #3d2a14; border-color: #9a5b13; color: #fdba74; }
      .dot { border-color: #22272e; background: #2bb39f; }
    }
  `;

  function setupUI() {
    host = document.createElement('ig-host');
    host.setAttribute('style', 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;');
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CARD_CSS);
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML =
      '<div class="card" hidden></div><button class="dot" hidden title="查词 / 翻译"></button><div class="toast" hidden></div>';
    card = shadow.querySelector('.card');
    dot = shadow.querySelector('.dot');
    toast = shadow.querySelector('.toast');
    document.documentElement.appendChild(host);

    card.addEventListener('click', onCardClick);
    dot.addEventListener('mousedown', (e) => e.preventDefault()); // 保持选区
    dot.addEventListener('click', onDotClick);
    toast.addEventListener('click', () => (toast.hidden = true));

    document.addEventListener('click', onDocClick, true);
    document.addEventListener('mousedown', (e) => !e.composedPath().includes(host) && (dot.hidden = true), true);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && hideCard());
    addEventListener(
      'scroll',
      () => {
        dot.hidden = true;
        requestAnimationFrame(positionCard);
      },
      { capture: true, passive: true },
    );
    addEventListener('resize', () => requestAnimationFrame(positionCard));
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => (toast.hidden = true), 10000);
  }

  // where: 'below' 在锚点下方；'right' 在锚点右侧，右边放不下时改到下方
  function showCard(html, rectFn, where = placement) {
    card.innerHTML = html;
    card.hidden = false;
    anchorRect = rectFn;
    placement = where;
    positionCard();
  }

  function hideCard() {
    if (card) card.hidden = true;
    current = null;
  }

  function positionCard() {
    if (!card || card.hidden || !anchorRect) return;
    const r = anchorRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left;
    let top;
    if (placement === 'right' && r.right + 12 + w <= innerWidth - 8) {
      left = r.right + 12;
      top = Math.max(8, Math.min(r.top - 8, innerHeight - h - 8));
    } else {
      left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      top = r.bottom + 6;
      if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // 锚点被移除（比如标记为认识后）时，卡片停在原位置
  function stableRect(getRect) {
    let last = getRect();
    return () => {
      const r = getRect();
      if (r.width || r.height) last = r;
      return last;
    };
  }

  function vocabButton(c) {
    const inVocab = !!vocab[c.lemma];
    return `<button data-act="vocab" class="${inVocab ? 'on' : ''}">${inVocab ? '已在生词本（点击移出）' : '加入生词本'}</button>`;
  }

  function wordCardHTML(c) {
    const lv = c.missing ? '' : LEVEL_TEXT[c.level ?? ''] ?? '';
    const surface = c.surface && c.surface.toLowerCase() !== c.lemma ? ` <span class="muted">(${escapeHTML(c.surface)})</span>` : '';
    return `
      <div class="head">
        <span class="word">${escapeHTML(c.lemma)}</span>${surface}
        ${lv ? `<span class="lv">${escapeHTML(lv)}</span>` : ''}
        <button class="x" data-act="close" title="关闭">×</button>
      </div>
      ${c.phonetic ? `<div class="ph">/${escapeHTML(c.phonetic)}/</div>` : ''}
      ${c.ai ? `<div class="ai">语境：${escapeHTML(c.ai)}</div>` : ''}
      <div class="tr">${c.translation ? escapeHTML(c.translation) : c.gloss ? escapeHTML(c.gloss) : '<span class="muted">词典里没有这个词</span>'}</div>
      <div class="acts">
        ${c.missing ? '' : `<button data-act="known">认识了，不再标注</button>`}
        ${vocabButton(c)}
        <button data-act="explain">AI 讲解</button>
        <button data-act="sentence">翻译整句</button>
      </div>
      <div class="out">${c.out || ''}</div>`;
  }

  // 划选的短语或段落
  function textCardHTML(c) {
    const src = c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text;
    const result = c.translation
      ? `${escapeHTML(c.translation)}\n<span class="muted">— ${escapeHTML(c.engine)}</span>`
      : c.error
        ? `<span class="err">${escapeHTML(c.error)}</span>`
        : '<span class="muted">翻译中…</span>';
    return `
      <div class="head">
        ${c.short ? `<span class="word">${escapeHTML(c.text)}</span>` : '<span class="muted">翻译</span>'}
        <button class="x" data-act="close" title="关闭">×</button>
      </div>
      ${c.short ? '' : `<div class="src">${escapeHTML(src)}</div>`}
      <div class="tr">${result}</div>
      ${c.short ? `<div class="acts"><button data-act="explain">AI 讲解</button>${vocabButton(c)}</div>` : ''}
      <div class="out">${c.out || ''}</div>`;
  }

  function renderCurrent() {
    if (!current || current.type === 'phrase') return;
    const keepScroll = card.scrollTop;
    showCard(current.type === 'text' ? textCardHTML(current) : wordCardHTML(current), anchorRect);
    card.scrollTop = keepScroll;
  }

  async function openWordCard(c, rectFn, where = 'below') {
    current = { type: 'word', ...c };
    showCard(wordCardHTML(current), stableRect(rectFn), where);
    try {
      const d = await send('detail', { word: c.lemma });
      if (current?.lemma !== c.lemma) return;
      Object.assign(current, {
        phonetic: d.phonetic,
        translation: d.translation || current.translation,
        level: current.level === '' ? '' : d.level ?? current.level,
      });
      renderCurrent();
    } catch (e) {
      console.debug('[夹注]', e);
    }
  }

  function openSpanCard(span) {
    openWordCard(
      {
        lemma: span.dataset.l,
        surface: span.textContent,
        level: span.dataset.lv === '' ? '' : Number(span.dataset.lv),
        gloss: span.dataset.d || span.dataset.g,
        ai: span.dataset.ai,
        sentence: sentenceAt(span.firstChild || span),
      },
      () => span.getBoundingClientRect(),
    );
  }

  async function openLookupCard(word, range, where) {
    const sentence = sentenceAt(range.startContainer, range.startOffset);
    const rectFn = () => range.getBoundingClientRect();
    const res = await send('lookup', { words: [word.toLowerCase()] }).catch(() => ({}));
    const info = res[word.toLowerCase()];
    if (info) {
      openWordCard({ lemma: info.lemma, surface: word, level: info.level, gloss: info.gloss, sentence }, rectFn, where);
      return;
    }
    openWordCard({ lemma: word.toLowerCase(), surface: word, level: '', missing: true, sentence }, rectFn, where);
    runAction('translateWord');
  }

  async function openTextCard(text, range, where) {
    const flat = text.replace(/\s+/g, ' ');
    const c = {
      type: 'text',
      text: flat,
      short: flat.split(' ').length <= 8 && flat.length <= 80,
      sentence: sentenceAt(range.startContainer, range.startOffset),
    };
    if (c.short) {
      c.lemma = flat.toLowerCase();
      c.surface = flat;
    }
    current = c;
    showCard(textCardHTML(c), stableRect(() => range.getBoundingClientRect()), where);
    try {
      const r = await send('translate', { text: flat });
      Object.assign(c, { translation: r.text, engine: r.engine });
    } catch (e) {
      c.error = e.message;
    }
    if (current === c) renderCurrent();
  }

  function onCardClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) runAction(act);
  }

  async function runAction(act) {
    const c = current;
    if (!c) return;
    const setOut = (html) => {
      if (current !== c) return;
      c.out = html;
      renderCurrent();
    };
    try {
      if (act === 'close') hideCard();
      else if (act === 'known') {
        await igSetKnown(c.lemma, true);
        setOut('<span class="muted">已标记为认识，以后不再标注。可在设置页撤销。</span>');
      } else if (act === 'vocab') {
        if (vocab[c.lemma]) await igSetVocab(c.lemma, null);
        else {
          await igSetVocab(c.lemma, {
            form: c.surface,
            gloss: c.ai || c.gloss || c.translation || '',
            sentence: c.sentence,
            url: location.href,
            title: document.title,
          });
        }
        vocab = (await igGetLists()).vocab;
        renderCurrent();
      } else if (act === 'explain') {
        setOut('<span class="muted">AI 讲解中…</span>');
        const text = await send('aiExplain', { word: c.surface || c.lemma, sentence: c.sentence });
        setOut(escapeHTML(text));
      } else if (act === 'sentence') {
        if (!c.sentence) return setOut('<span class="muted">没有找到所在句子</span>');
        setOut(`<span class="muted">${escapeHTML(c.sentence)}\n翻译中…</span>`);
        const r = await send('translate', { text: c.sentence });
        setOut(`<span class="muted">${escapeHTML(c.sentence)}</span>\n${escapeHTML(r.text)}`);
      } else if (act === 'translateWord') {
        setOut('<span class="muted">查询中…</span>');
        const r = await send('translate', { text: c.surface });
        c.gloss = r.text;
        setOut(`${escapeHTML(r.text)} <span class="muted">— ${r.engine}</span>`);
      }
    } catch (e) {
      setOut(`<span class="err">${escapeHTML(e.message)}</span>`);
    }
  }

  function onDocClick(e) {
    if (e.composedPath().includes(host)) return;
    const span = e.target.closest?.('.ig-w, .ig-p');
    if (span && !document.documentElement.classList.contains('ig-off')) {
      // 链接里的词：Alt+点击才查词，普通点击照常跳转
      if (span.closest('a[href]') && !e.altKey) return hideCard();
      e.preventDefault();
      e.stopPropagation();
      if (span.classList.contains('ig-p')) {
        current = { type: 'phrase' };
        showCard(
          `<div class="head"><span class="word">${escapeHTML(span.dataset.phrase)}</span><span class="lv">短语</span><button class="x" data-act="close">×</button></div>
           <div class="ai">语境：${escapeHTML(span.dataset.g)}</div>
           <div class="note">AI 根据上下文识别的短语</div>`,
          stableRect(() => span.getBoundingClientRect()),
          'below',
        );
      } else if (current?.lemma !== span.dataset.l || card.hidden) {
        openSpanCard(span);
      }
      return;
    }
    hideCard();
  }

  // 选中文字后，在选区右上角显示一个小圆点
  function onMouseUp(e) {
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel.toString().trim();
      const editable = e.target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]');
      if (!sel.rangeCount || sel.isCollapsed || !/[A-Za-z]/.test(text) || text.length > 4000 || editable) {
        dot.hidden = true;
        return;
      }
      const range = sel.getRangeAt(0).cloneRange();
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const r = rects[rects.length - 1] || range.getBoundingClientRect();
      dot._sel = { text, range };
      dot.style.left = `${Math.min(r.right + 1, innerWidth - 18)}px`;
      dot.style.top = `${Math.max(r.top - 10, 2)}px`;
      dot.hidden = false;
    }, 0);
  }

  function onDotClick() {
    const { text, range } = dot._sel;
    dot.hidden = true;
    const word = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (/^[A-Za-z]+(?:['’][A-Za-z]+)?$/.test(word)) openLookupCard(word.replace(/['’]s$/i, ''), range, 'right');
    else openTextCard(text, range, 'right');
  }

  function onMessage(msg, sender, sendResponse) {
    if (msg?.type === 'toggle') toggle();
    if (msg?.type === 'state') {
      sendResponse({ started, off: document.documentElement.classList.contains('ig-off'), aiStats });
    }
  }

  // ---------- 启动 ----------

  async function init() {
    settings = await igGetSettings();
    const lists = await igGetLists();
    known = new Set(lists.known);
    vocab = lists.vocab;
    applyStyleVars();
    setupUI();
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onMessage);
    if (isActive()) start();
  }

  if (document.body) init();
  else addEventListener('DOMContentLoaded', init, { once: true });
})();
