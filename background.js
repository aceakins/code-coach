/* Code Coach background service worker
 * - Opens the side panel when the toolbar icon is clicked
 * - Polls watched GitHub repos for new commits (every 5 minutes)
 */

const ALARM = 'cc-watch';

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  syncAlarm();
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function getWatch() {
  const { cc_watch } = await chrome.storage.local.get('cc_watch');
  return Array.isArray(cc_watch) ? cc_watch : [];
}

async function syncAlarm() {
  const list = await getWatch();
  if (list.length) {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
  } else {
    chrome.alarms.clear(ALARM);
  }
}

async function ghHeaders() {
  const { cc_settings } = await chrome.storage.local.get('cc_settings');
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (cc_settings && cc_settings.token) h.Authorization = 'Bearer ' + cc_settings.token;
  return h;
}

async function checkRepos() {
  const list = await getWatch();
  if (!list.length) return;
  const headers = await ghHeaders();
  let changed = false;
  for (const w of list) {
    try {
      const url =
        `https://api.github.com/repos/${w.owner}/${w.repo}/commits?per_page=1` +
        (w.branch ? `&sha=${encodeURIComponent(w.branch)}` : '');
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const [latest] = await res.json();
      if (!latest) continue;
      if (w.lastSha && latest.sha !== w.lastSha) {
        const msg = (latest.commit.message || '').split('\n')[0];
        await chrome.storage.local.set({
          cc_pending: { owner: w.owner, repo: w.repo, branch: w.branch || '', sha: latest.sha, message: msg },
        });
        chrome.action.setBadgeText({ text: 'NEW' });
        chrome.action.setBadgeBackgroundColor({ color: '#2547F5' });
        chrome.notifications.create(`cc-${w.owner}-${w.repo}-${latest.sha.slice(0, 7)}`, {
          type: 'basic',
          iconUrl: 'icon128.png',
          title: `New commit in ${w.owner}/${w.repo}`,
          message: `${msg}\nOpen Code Coach to audit it.`,
        });
      }
      if (w.lastSha !== latest.sha) {
        w.lastSha = latest.sha;
        changed = true;
      }
    } catch (e) {
      /* offline or rate-limited: try again next time */
    }
  }
  if (changed) await chrome.storage.local.set({ cc_watch: list });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) checkRepos();
});

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (e) {
    /* Chrome may require a direct click; the NEW badge stays as a cue */
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'CC_SYNC_WATCH') {
    syncAlarm().then(() => {
      checkRepos();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
