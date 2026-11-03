// 背景页、内容脚本、弹窗、设置页共用的常量和存取函数

const IG_DEFAULTS = {
  enabled: true,
  level: 3, // 标注 level >= 这个值的词
  showRare: true, // 标注词典里的专业/罕见词 (level 6)
  firstOnly: true, // 同一段里只在第一次出现时显示释义
  color: '#0f7b6c',
  colorDark: '#5eead4',
  size: 72, // 释义字号，相对正文的百分比
  ai: false,
  aiBase: 'https://api.deepseek.com/v1',
  aiKey: '',
  aiModel: 'deepseek-chat',
  deeplxUrl: 'https://api.deeplx.org/translate',
  deeplxToken: '',
  disabledSites: [],
};

const IG_LEVELS = {
  1: '基础',
  2: '四级',
  3: '六级',
  4: '考研/雅思/托福',
  5: 'GRE/低频',
  6: '专业/罕见',
};

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

function igSiteDisabled(settings, hostname) {
  return settings.disabledSites.includes(hostname);
}
