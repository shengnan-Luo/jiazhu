// 后台：词典查询、DeepLX 翻译、AI 语境释义
importScripts('common.js');

// ---------- 词典 ----------

const dicts = {};
function loadDict(name) {
  dicts[name] ??= fetch(chrome.runtime.getURL(`dict/${name}.json`)).then((r) => r.json());
  return dicts[name];
}

// 词典的变形表没覆盖到时，按规则猜原形
function stems(w) {
  const out = [];
  const add = (x) => x.length >= 3 && out.push(x);
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) {
    add(w.slice(0, -2));
    add(w.slice(0, -1));
    if (/(.)\1ed$/.test(w)) add(w.slice(0, -3));
  }
  if (w.endsWith('ing')) {
    add(w.slice(0, -3));
    add(w.slice(0, -3) + 'e');
    if (/(.)\1ing$/.test(w)) add(w.slice(0, -4));
  }
  if (w.endsWith('ily')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ally')) add(w.slice(0, -4));
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return out;
}

function lookupOne(w, d) {
  const hit = (lemma) => {
    const c = d.core[lemma];
    if (c) return { lemma, level: c[0], gloss: c[1] };
    const r = d.rare?.[lemma];
    if (r) return { lemma, level: 6, gloss: r };
    return null;
  };
  if (d.core[w]) return hit(w);
  if (d.forms[w]) {
    const r = hit(d.forms[w]);
    if (r) return r;
  }
  for (const s of stems(w)) {
    if (d.core[s]) return hit(s);
    if (d.forms[s] && d.core[d.forms[s]]) return hit(d.forms[s]);
  }
  if (d.rare) {
    if (d.rare[w]) return hit(w);
    for (const s of stems(w)) if (d.rare[s]) return hit(s);
  }
  return null;
}

// ---------- 翻译与 AI ----------

async function deeplx(text, s) {
  const headers = { 'Content-Type': 'application/json' };
  if (s.deeplxToken) headers.Authorization = `Bearer ${s.deeplxToken}`;
  const res = await fetch(s.deeplxUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, source_lang: 'EN', target_lang: 'ZH' }),
  });
  if (!res.ok) throw new Error(`DeepLX 返回错误 ${res.status}`);
  const data = await res.json();
  const out = data?.data;
  if (typeof out !== 'string' || !out) throw new Error('DeepLX 返回为空');
  if (/^https?:\/\/linux\.do\//.test(out)) {
    throw new Error(`api.deeplx.org 需要在地址里带上你的个人 key，说明见 ${out}`);
  }
  return out;
}

async function chat(messages, { json = false, maxTokens = 800 } = {}) {
  const s = await igGetSettings();
  if (!s.aiKey) throw new Error('请先在设置页填写 AI 的 API Key');
  const url = `${s.aiBase.replace(/\/+$/, '')}/chat/completions`;
  const body = { model: s.aiModel, messages, temperature: 0.2, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.aiKey}` },
      body: JSON.stringify(body),
    });
  let res = await post();
  // 有些服务不支持 response_format，去掉再试一次
  if (!res.ok && json && res.status === 400) {
    delete body.response_format;
    res = await post();
  }
  if (!res.ok) {
    const hint = { 401: 'API Key 无效', 402: '账户余额不足', 403: '没有权限', 404: '接口地址或模型名不对', 429: '请求太频繁或额度用完' }[
      res.status
    ];
    throw new Error(`AI 接口错误 ${res.status}${hint ? `（${hint}）` : ''}: ${(await res.text()).slice(0, 150)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function parseJSON(s) {
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + str.length.toString(36);
}

// AI 结果缓存在 storage.session（浏览器关闭前一直有效）
async function cached(key, fn) {
  const hit = (await chrome.storage.session.get(key))[key];
  if (hit) return hit;
  const value = await fn();
  chrome.storage.session.set({ [key]: value }).catch(() => {});
  return value;
}

const GLOSS_PROMPT = `你是英语学习助手。读者是中国科研人员，英语约大学六级水平，正在读英文网页，希望在生词后面看到简短的中文释义，从而直接读懂英文原文。
给你一段英文和一组目标词，请完成：
1. words：给每个目标词在这段话语境中的中文意思，2~6 个汉字，越短越好；专业术语用该领域的规范译名；如果目标词是人名、地名、机构名、缩写或不是英语单词，值为 null。键必须与给出的目标词原样一致。
2. phrases：找出段落中六级读者可能看不懂的短语、固定搭配或习语（如 give rise to、in terms of、account for），给出语境中的中文意思，最多 5 个；text 必须与原文写法完全一致；没有就给空数组。
3. senses：找出不在目标词里、但在本段用了不常见含义的常见词（如 novel 表示“新颖的”、yield 表示“产率”），最多 3 个；没有就给空数组。
只输出 JSON，格式：{"words":{"目标词":"释义"},"phrases":[{"text":"原文短语","zh":"释义"}],"senses":[{"word":"原文单词","zh":"释义"}]}`;

// ---------- 消息处理 ----------

const handlers = {
  async lookup({ words }) {
    const d = { core: await loadDict('core'), forms: await loadDict('forms') };
    const out = {};
    const miss = [];
    for (const w of words) {
      const r = lookupOne(w, d);
      if (r) out[w] = r;
      else miss.push(w);
    }
    if (miss.length) {
      d.rare = await loadDict('rare');
      for (const w of miss) {
        const r = lookupOne(w, d);
        if (r) out[w] = r;
      }
    }
    return out;
  },

  async detail({ word }) {
    const [detail, core] = await Promise.all([loadDict('detail'), loadDict('core')]);
    const [phonetic = '', translation = ''] = detail[word] || [];
    if (translation) return { phonetic, translation, level: core[word]?.[0] };
    const rare = await loadDict('rare');
    return { phonetic: '', translation: rare[word] || '', level: rare[word] ? 6 : undefined };
  },

  async translate({ text }) {
    const s = await igGetSettings();
    let err;
    if (s.deeplxUrl) {
      try {
        return { text: await deeplx(text, s), engine: 'DeepLX' };
      } catch (e) {
        err = e;
      }
    }
    if (s.aiKey) {
      const out = await chat(
        [
          {
            role: 'system',
            content: '你是专业的学术翻译。把用户给出的英文翻译成准确、通顺的简体中文，专业术语用规范译名，只输出译文。',
          },
          { role: 'user', content: text },
        ],
        { maxTokens: 2000 },
      );
      return { text: out.trim(), engine: 'AI', note: err?.message };
    }
    throw err || new Error('请先在设置页填写 DeepLX 地址或 AI 的 API Key');
  },

  async aiGloss({ text, words }) {
    const s = await igGetSettings();
    const key = `g${hash(`${s.aiModel}\n${text}\n${words.join(',')}`)}`;
    return cached(key, async () => {
      const out = await chat(
        [
          { role: 'system', content: GLOSS_PROMPT },
          { role: 'user', content: `段落：\n${text}\n\n目标词：${JSON.stringify(words)}` },
        ],
        { json: true, maxTokens: 1000 },
      );
      return parseJSON(out);
    });
  },

  async aiExplain({ word, sentence }) {
    const s = await igGetSettings();
    const key = `e${hash(`${s.aiModel}\n${word}\n${sentence}`)}`;
    return cached(key, async () => {
      const out = await chat(
        [
          {
            role: 'user',
            content: `用中文简要讲解英文“${word}”在下面句子里的意思和用法：单词说明词性，短语说明是哪种固定搭配；再说在这句话中的含义、常见搭配，最后给一个简单例句（附中文）。150 字以内，不要用 Markdown 标题和加粗。\n\n句子：${sentence}`,
          },
        ],
        { maxTokens: 500 },
      );
      return out.replace(/\*\*/g, '').trim();
    });
  },

  async testAI() {
    const out = await chat([{ role: 'user', content: '只回复两个字：成功' }], { maxTokens: 20 });
    return out.trim();
  },

  async testDeepLX() {
    return deeplx('Hello, world.', await igGetSettings());
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-gloss') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
