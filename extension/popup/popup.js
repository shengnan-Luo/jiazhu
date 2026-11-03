const $ = (id) => document.getElementById(id);

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = '';
  try {
    hostname = new URL(tab.url).hostname;
  } catch {}
  $('host').textContent = hostname;

  let s = await igGetSettings();
  const { known, vocab } = await igGetLists();
  $('stats').textContent = `生词本 ${Object.keys(vocab).length} · 已认识 ${known.length}`;

  function render() {
    const active = igSiteActive(s, hostname);
    $('site').checked = active;
    $('site').disabled = !hostname;
    $('siteHint').textContent = s.enabled && !active ? '（本站单独关闭）' : !s.enabled && active ? '（本站单独开启）' : '';
    $('enabled').checked = s.enabled;
    $('level').value = String(s.level);
    $('showRare').checked = s.showRare;
    $('firstOnly').checked = s.firstOnly;
    $('zh').checked = s.zh;
    $('zhRow').hidden = !s.zh;
    for (const box of $('zhLists').querySelectorAll('input')) box.checked = s.zhLists.includes(Number(box.value));
    $('ai').checked = s.ai && !!s.aiKey;
    $('ai').disabled = !s.aiKey;
    $('aiHint').textContent = s.aiKey ? '' : '（先在设置里填 API）';
  }
  render();

  const save = async (patch) => {
    s = await igSetSettings(patch);
    render();
  };

  $('site').onchange = (e) => save(igSiteToggle(s, hostname, e.target.checked));
  $('enabled').onchange = (e) => save({ enabled: e.target.checked });
  $('level').onchange = (e) => save({ level: Number(e.target.value) });
  $('showRare').onchange = (e) => save({ showRare: e.target.checked });
  $('firstOnly').onchange = (e) => save({ firstOnly: e.target.checked });
  $('zh').onchange = (e) => save({ zh: e.target.checked });
  $('zhLists').onchange = () => {
    const boxes = [...$('zhLists').querySelectorAll('input:checked')];
    save({ zhLists: boxes.map((b) => Number(b.value)) });
  };
  $('ai').onchange = (e) => save({ ai: e.target.checked });

  $('toggle').onclick = () => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
    window.close();
  };
  $('options').onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };

  // 本页 AI 处理情况
  if (s.ai && s.aiKey && tab?.id) {
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'state' }).catch(() => null);
    const st = state?.aiStats;
    if (st) {
      const el = $('aiStatus');
      el.hidden = false;
      if (st.failed && !st.done) {
        el.classList.add('err');
        el.textContent = `AI 调用失败：${st.error}`;
      } else {
        el.textContent = `本页 AI 已处理 ${st.done} 段${st.failed ? `，失败 ${st.failed} 段` : ''}（只处理滚动到的段落）`;
      }
    }
  }

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === 'toggle-gloss')?.shortcut;
  $('shortcut').textContent = shortcut || '未设置';
}

main();
