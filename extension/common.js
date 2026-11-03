// 背景页、内容脚本、弹窗、设置页共用的常量和存取函数

const IG_DEFAULTS = {
  enabled: true,
  level: 3, // 标注 level >= 这个值的词
  showRare: true, // 标注词典里的专业/罕见词 (level 6)
  firstOnly: true, // 同一段里只在第一次出现时显示释义
  zh: true, // 中文网页：在中文词后面标注对应的英文单词
  zhLists: [2], // 复习哪些词表，见 IG_ZH_LISTS
  color: '#0f7b6c',
  colorDark: '#5eead4',
  size: 72, // 释义字号，相对正文的百分比
  ai: false,
  aiBase: 'https://api.deepseek.com/v1',
  aiKey: '',
  aiModel: 'deepseek-chat',
  deeplxUrl: 'https://api.deeplx.org/translate',
  deeplxToken: '',
  // enabled 是所有网站的默认状态；下面两个列表是例外，优先于默认
  disabledSites: [], // 默认启用时，单独关闭的网站
  enabledSites: [], // 默认关闭时，单独开启的网站
};

const IG_LEVELS = {
  1: '基础',
  2: '四级',
  3: '六级',
  4: '考研/雅思/托福',
  5: 'GRE/低频',
  6: '专业/罕见',
};

// 中文网页复习用的词表，互不重复：六级只含四级以外的词，雅思托福只含四六级以外的词
const IG_ZH_LISTS = {
  1: '四级',
  2: '六级',
  3: '雅思托福',
};

// 以中文为主的文本（划选翻译时译成英文）
function igMostlyChinese(text) {
  const han = (text.match(/[一-鿿]/g) || []).length;
  return han > 0 && han >= (text.match(/[A-Za-z]+/g) || []).length;
}

async function igGetSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...IG_DEFAULTS, ...settings };
}

async function igSetSettings(patch) {
  const settings = { ...(await igGetSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

async function igGetLists() {
  const { known = [], vocab = {} } = await chrome.storage.local.get(['known', 'vocab']);
  return { known, vocab };
}

async function igSetKnown(word, isKnown) {
  const { known, vocab } = await igGetLists();
  const set = new Set(known);
  if (isKnown) {
    set.add(word);
    delete vocab[word];
  } else {
    set.delete(word);
  }
  await chrome.storage.local.set({ known: [...set], vocab });
}

async function igSetVocab(word, entry) {
  const { known, vocab } = await igGetLists();
  if (entry) {
    vocab[word] = { ...vocab[word], ...entry, time: vocab[word]?.time || Date.now() };
    await chrome.storage.local.set({ vocab, known: known.filter((w) => w !== word) });
  } else {
    delete vocab[word];
    await chrome.storage.local.set({ vocab });
  }
}

// 某个网站是否启用：先看例外列表，再看默认
function igSiteActive(settings, hostname) {
  return settings.enabled ? !settings.disabledSites.includes(hostname) : settings.enabledSites.includes(hostname);
}

// 在 hostname 上打开/关闭，返回要保存的设置改动。以最近一次选择为准：
// 先从两个列表里都去掉，和默认不同时再记到对应的列表
function igSiteToggle(settings, hostname, on) {
  const disabled = new Set(settings.disabledSites);
  const enabled = new Set(settings.enabledSites);
  disabled.delete(hostname);
  enabled.delete(hostname);
  if (on !== settings.enabled) (on ? enabled : disabled).add(hostname);
  return { disabledSites: [...disabled], enabledSites: [...enabled] };
}
