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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    case 'FRAME_ANCHOR':
      chrome.tabs.sendMessage(tabId, { ...msg, type: 'SCROLL_TO_ANCHOR' }, { frameId: msg.peer })
        .then((res) => sendResponse(res ?? { found: false }))
        .catch(() => sendResponse({ found: false }));
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
  chrome.action.setBadgeText({ tabId, text: badge ? badge.text : '' });
  if (badge) chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
}
