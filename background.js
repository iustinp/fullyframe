// The toolbar button opens popup.html; this shortcut (Alt+Space by default)
// flips between the initial page and the overlay, or toggles fullscreen when
// no overlay page is selected.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'switch-view' || tab?.id === undefined) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' }, { frameId: 0 });
    updateBadge(tab.id, response);
  } catch {
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#ef4444' });
  }
});

function sendToFrame(tabId, frameId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
}

// Before switching views: the page being left tells the one being shown what
// is on it and which spot to keep in place, and that one scrolls to match.
async function syncFrames(tabId, from, to, force) {
  const out = await chrome.tabs.sendMessage(tabId, { type: 'SYNC_OUT', force }, { frameId: from }).catch(() => null);
  const res = await chrome.tabs.sendMessage(tabId, { ...(out ?? { skip: true }), type: 'SYNC_IN' }, { frameId: to })
    .catch(() => null);
  return res ?? { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From the popup, when it opens.
  if (msg.type === 'CHECK_FOR_UPDATE') {
    checkForUpdate();
    return;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  switch (msg.type) {
    case 'STATE_CHANGED':
      updateBadge(tabId, msg);
      break;
    case 'ALLOW_OVERLAY_FRAMING':
      allowOverlayFraming(tabId, msg.url)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'REVOKE_OVERLAY_FRAMING':
      revokeOverlayFraming(tabId).finally(() => sendResponse({ ok: true }));
      return true;

    // Relay between the original iframe and the overlay (text anchor sync).
    case 'WHOAMI':
      sendResponse({ frameId: sender.frameId });
      break;
    case 'LINK_FRAMES': {
      const [a, b] = msg.frames;
      sendToFrame(tabId, a, { type: 'LINK', peer: b });
      sendToFrame(tabId, b, { type: 'LINK', peer: a });
      break;
    }
    case 'UNLINK_FRAMES':
      msg.frames.forEach((id) => sendToFrame(tabId, id, { type: 'UNLINK' }));
      break;
    case 'SYNC_FRAMES':
      syncFrames(tabId, msg.from, msg.to, msg.force).then(sendResponse);
      return true;
    case 'FRAME_ESCAPE':
      sendToFrame(tabId, 0, { type: 'DEACTIVATE' });
      break;
    case 'FRAME_SWITCH':
      sendToFrame(tabId, 0, { type: 'SWITCH_VIEW' });
      break;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  revokeOverlayFraming(tabId);
});

// Serialize rule updates so a revoke can never land after a later allow.
let ruleQueue = Promise.resolve();
function queueRuleUpdate(update) {
  const next = ruleQueue.then(() => chrome.declarativeNetRequest.updateSessionRules(update));
  ruleQueue = next.catch(() => {});
  return next;
}

// Many sites forbid being framed (X-Frame-Options / CSP frame-ancestors).
// While the overlay is active, strip those headers, but only for sub-frame
// requests to the overlay page's domain in that specific tab.
async function allowOverlayFraming(tabId, url) {
  const { hostname } = new URL(url);
  await queueRuleUpdate({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: {
        tabIds: [tabId],
        resourceTypes: ['sub_frame'],
        requestDomains: [hostname],
      },
    }],
  });
}

async function revokeOverlayFraming(tabId) {
  try {
    await queueRuleUpdate({ removeRuleIds: [tabId] });
  } catch {}
}

// On aemcoder the overlay is the source page laid over the EDS preview;
// elsewhere it is any page laid over the initially opened one.
const BADGES = {
  fullscreen: { text: 'ON', color: '#22c55e' },
  overlay: { text: 'Over', color: '#8b5cf6' },
  original: { text: 'Init', color: '#3b82f6' },
};
const IFRAME_BADGES = {
  ...BADGES,
  overlay: { ...BADGES.overlay, text: 'Src' },
  original: { ...BADGES.original, text: 'EDS' },
};

function updateBadge(tabId, state) {
  const badges = state?.target === 'iframe' ? IFRAME_BADGES : BADGES;
  const badge = state?.active && badges[state.view];
  // When idle, fall back to the global badge (the update marker, if any).
  chrome.action.setBadgeText({ tabId, text: badge ? badge.text : null });
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge ? badge.color : UPDATE_COLOR });
}

// --- Update notifications ---
// The extension is loaded unpacked, so Chrome never updates it. Compare the
// version on GitHub with ours and mark the icon when a newer one exists; after
// an update, remember the previous version so the popup can show what's new.

const REMOTE_BASE = 'https://raw.githubusercontent.com/iustinp/fullyframe/main/';
const UPDATE_COLOR = '#16a34a';
const UPDATE_ALARM = 'check-for-update';
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const CURRENT_VERSION = chrome.runtime.getManifest().version;
const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function checkForUpdate({ force = false } = {}) {
  const { updateCheckedAt = 0 } = await chrome.storage.local.get('updateCheckedAt');
  if (!force && Date.now() - updateCheckedAt < UPDATE_CHECK_MS) return;
  try {
    const res = await fetch(REMOTE_BASE + 'manifest.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (typeof version !== 'string') return;
    let changes = [];
    if (compareVersions(version, CURRENT_VERSION) > 0) {
      const log = await fetch(REMOTE_BASE + 'changelog.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : [])).catch(() => []);
      changes = Array.isArray(log) ? log : [];
    }
    await chrome.storage.local.set({ latestVersion: version, latestChangelog: changes, updateCheckedAt: Date.now() });
  } catch {
    // Offline or GitHub unreachable: try again later.
  }
}

async function showUpdateMarker() {
  const { latestVersion } = await chrome.storage.local.get('latestVersion');
  const available = !!latestVersion && compareVersions(latestVersion, CURRENT_VERSION) > 0;
  chrome.action.setBadgeText({ text: available ? '↓' : '' });
  chrome.action.setBadgeBackgroundColor({ color: UPDATE_COLOR });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setTitle({ title: available ? `${DEFAULT_TITLE} – update available (${latestVersion})` : DEFAULT_TITLE });
}

// Removing the extension wipes its storage, but the overlay pages' bookmarks
// folder stays: finding it on a fresh install means an earlier version was
// installed before, so show at least the current version's changes.
async function hasBookmarkFolder() {
  const roots = await chrome.bookmarks.getChildren('0');
  const other = roots.find((n) => n.folderType === 'other') ?? roots[1] ?? roots[0];
  return (await chrome.bookmarks.getChildren(other.id)).some((n) => !n.url && n.title === 'FullyFrame');
}

async function versionBefore(version) {
  const log = await fetch(chrome.runtime.getURL('changelog.json')).then((r) => r.json()).catch(() => []);
  return (Array.isArray(log) ? log : [])
    .map((e) => e?.version)
    .filter((v) => typeof v === 'string' && compareVersions(v, version) < 0)
    .sort(compareVersions)
    .pop() ?? '0';
}

async function noteVersionChange(previousVersion) {
  const { lastVersion, whatsNewSince } = await chrome.storage.local.get(['lastVersion', 'whatsNewSince']);
  let since = previousVersion || lastVersion;
  if (!since && await hasBookmarkFolder().catch(() => false)) since = await versionBefore(CURRENT_VERSION);
  // Not dismissed yet: keep listing everything since the older version.
  if (whatsNewSince && (!since || compareVersions(whatsNewSince, since) < 0)) since = whatsNewSince;
  const update = { lastVersion: CURRENT_VERSION };
  if (since && compareVersions(CURRENT_VERSION, since) > 0) update.whatsNewSince = since;
  await chrome.storage.local.set(update);
}

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await noteVersionChange(reason === 'update' ? previousVersion : undefined);
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  checkForUpdate({ force: true });
});
chrome.runtime.onStartup.addListener(() => checkForUpdate());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate({ force: true });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'latestVersion' in changes) showUpdateMarker();
});
showUpdateMarker();
