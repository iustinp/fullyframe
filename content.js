const SESSION_KEY = 'fullyframe_active';
const OVERLAY_URL_KEY = 'overlayUrl';
const OVERLAY_ATTR = 'data-fullyframe-overlay';
// Sites where the custom page covers the preview iframe; elsewhere it covers the whole page.
const IFRAME_OVERLAY_HOSTS = ['aemcoder.adobe.io'];
const OVERLAY_TARGET = IFRAME_OVERLAY_HOSTS.includes(location.hostname) ? 'iframe' : 'page';

let isActive = false;
let mode = null; // 'fullscreen' | 'overlay'
let targetIframe = null;
let originalStyle = '';
let originalBodyOverflow = '';
let overlayIframe = null;
let overlayVisible = false;
let linkedFrames = null; // [originalFrameId, overlayFrameId]
let trackingFrame = null;
let pendingActivation = null;

function findIframe() {
  return document.querySelector(`iframe[title="Page Preview"]:not([${OVERLAY_ATTR}])`)
    || document.querySelector(`iframe[src*="previewToken"]:not([${OVERLAY_ATTR}])`)
    || document.querySelector(`iframe[src*="preview-aemcoder"]:not([${OVERLAY_ATTR}])`)
    || findLargestIframe();
}

function findLargestIframe() {
  const iframes = Array.from(document.querySelectorAll(`iframe[src]:not([${OVERLAY_ATTR}])`));
  if (!iframes.length) return null;
  return iframes.reduce((best, el) => {
    const area = el.offsetWidth * el.offsetHeight;
    const bestArea = best.offsetWidth * best.offsetHeight;
    return area > bestArea ? el : best;
  });
}

async function getOverlayUrl() {
  try {
    const { [OVERLAY_URL_KEY]: url } = await chrome.storage.sync.get(OVERLAY_URL_KEY);
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function getState() {
  let view = null;
  if (isActive) view = mode === 'overlay' ? (overlayVisible ? 'overlay' : 'original') : mode;
  return { active: isActive, view, target: OVERLAY_TARGET };
}

function notifyState() {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', ...getState() }).catch(() => {});
}

// --- Fullscreen mode (original behaviour) ---

const FULLSCREEN_CSS =
  'position:fixed!important;top:0!important;left:0!important;' +
  'width:100vw!important;height:100vh!important;' +
  'z-index:2147483647!important;border:none!important;' +
  'margin:0!important;padding:0!important;background:#fff!important;';

function activateFullscreen() {
  const iframe = findIframe();
  if (!iframe) return false;

  targetIframe = iframe;
  originalStyle = iframe.getAttribute('style') || '';
  originalBodyOverflow = document.body.style.overflow;

  iframe.style.cssText = FULLSCREEN_CSS;
  document.body.style.overflow = 'hidden';
  return true;
}

function deactivateFullscreen() {
  if (targetIframe) {
    targetIframe.style.cssText = originalStyle;
  }
  document.body.style.overflow = originalBodyOverflow;
}

// --- Overlay mode: custom page placed exactly over the detected iframe ---
// (on IFRAME_OVERLAY_HOSTS) or over the whole viewport (everywhere else).
// The overlay is loaded once and then only shown/hidden, so the user can flip
// between the original iframe and the custom page to compare them.
// It is inserted right next to the original iframe so it shares its stacking
// context: whatever the page draws above the original iframe (dropdowns,
// menus, sticky headers) is drawn above the overlay too.

const OVERLAY_BASE_CSS =
  'position:absolute!important;border:none!important;margin:0!important;' +
  'padding:0!important;min-width:0!important;min-height:0!important;' +
  'max-width:none!important;max-height:none!important;transform:none!important;' +
  'background:#fff!important;box-sizing:border-box!important;';
const OVERLAY_HIDDEN_CSS = 'visibility:hidden!important;pointer-events:none!important;';
const OVERLAY_NO_BOX_CSS = OVERLAY_BASE_CSS + 'display:none!important;';
const PAGE_OVERLAY_CSS =
  'position:fixed!important;top:0!important;left:0!important;display:block!important;' +
  'width:100vw!important;height:100vh!important;z-index:2147483647!important;' +
  'border:none!important;margin:0!important;padding:0!important;' +
  'max-width:none!important;max-height:none!important;transform:none!important;' +
  'background:#fff!important;box-sizing:border-box!important;';

let overlayOffset = { left: 0, top: 0 };
let lastOverlayCss = '';

async function activateOverlay(url) {
  if (OVERLAY_TARGET === 'iframe' && !findIframe()) return false;

  try {
    await chrome.runtime.sendMessage({ type: 'ALLOW_OVERLAY_FRAMING', url });
  } catch {}

  if (OVERLAY_TARGET === 'iframe') {
    const iframe = findIframe();
    if (!iframe) {
      revokeOverlayFraming();
      return false;
    }
    setTarget(iframe);
  }
  overlayIframe = document.createElement('iframe');
  overlayIframe.setAttribute(OVERLAY_ATTR, '');
  overlayIframe.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
  overlayIframe.addEventListener('load', identifyFrames);
  overlayIframe.src = url;
  overlayVisible = true;
  overlayOffset = { left: 0, top: 0 };
  if (OVERLAY_TARGET === 'page') {
    // The page itself is the original: its frame.js runs in the top frame (id 0).
    frameIds.original = 0;
    positionOverlay();
    document.documentElement.appendChild(overlayIframe);
  } else {
    applyOverlayCss(OVERLAY_NO_BOX_CSS);
    positionOverlay();
    trackTarget();
  }
  identifyFrames();
  return true;
}

// Re-identify whenever either frame (re)loads, since its frame.js starts unlinked.
function setTarget(iframe) {
  if (targetIframe === iframe) return;
  targetIframe?.removeEventListener('load', identifyFrames);
  targetIframe = iframe;
  frameIds.original = -1;
  targetIframe?.addEventListener('load', identifyFrames);
}

function setOverlayVisible(visible) {
  overlayVisible = visible;
  positionOverlay();
}

function applyOverlayCss(css) {
  if (css === lastOverlayCss) return;
  lastOverlayCss = css;
  overlayIframe.style.cssText = css;
}

function positionOverlay() {
  if (!overlayIframe) return;

  if (OVERLAY_TARGET === 'page') {
    applyOverlayCss(PAGE_OVERLAY_CSS + (overlayVisible ? '' : OVERLAY_HIDDEN_CSS));
    return;
  }

  if (!targetIframe || !targetIframe.isConnected) {
    // The page may have re-rendered the iframe; pick up its replacement.
    // Its load event will re-identify and re-link the frames.
    setTarget(findIframe());
  }
  if (!targetIframe) {
    applyOverlayCss(OVERLAY_NO_BOX_CSS);
    return;
  }
  if (overlayIframe.parentNode !== targetIframe.parentNode) {
    // Moving an iframe reloads it, so only do this when first inserting it or
    // after the page re-rendered the original iframe somewhere else.
    targetIframe.after(overlayIframe);
  }

  const t = targetIframe.getBoundingClientRect();
  if (t.width <= 0 || t.height <= 0) {
    applyOverlayCss(OVERLAY_NO_BOX_CSS);
    return;
  }

  // The overlay's containing block depends on the page (positioned ancestors,
  // transforms, scroll containers), so measure where it actually landed and
  // correct by the difference.
  const zIndex = getComputedStyle(targetIframe).zIndex;
  for (let i = 0; i < 3; i++) {
    applyOverlayCss(
      OVERLAY_BASE_CSS +
      `z-index:${zIndex}!important;` +
      `left:${overlayOffset.left}px!important;top:${overlayOffset.top}px!important;` +
      `width:${t.width}px!important;height:${t.height}px!important;` +
      (overlayVisible ? '' : OVERLAY_HIDDEN_CSS)
    );
    const o = overlayIframe.getBoundingClientRect();
    const dx = t.left - o.left;
    const dy = t.top - o.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
    overlayOffset.left += dx;
    overlayOffset.top += dy;
  }
}

function trackTarget() {
  positionOverlay();
  trackingFrame = requestAnimationFrame(trackTarget);
}

function deactivateOverlay() {
  if (trackingFrame !== null) {
    cancelAnimationFrame(trackingFrame);
    trackingFrame = null;
  }
  unlinkFrames();
  setTarget(null);
  overlayIframe?.removeEventListener('load', identifyFrames);
  overlayIframe?.remove();
  overlayIframe = null;
  overlayVisible = false;
  lastOverlayCss = '';
  revokeOverlayFraming();
}

function revokeOverlayFraming() {
  chrome.runtime.sendMessage({ type: 'REVOKE_OVERLAY_FRAMING' }).catch(() => {});
}

// --- Linking the original iframe (or page) and the overlay ---
// frame.js runs inside both frames; once linked, Alt+click on text in one
// scrolls the same text in the other. The background relays the messages.
// To learn each frame's extension frameId we post it an "identify" message;
// its frame.js asks the background for its frameId and posts it back, and we
// tell the frames apart by the message source window.

const LINK_TOKEN = crypto.randomUUID();
const frameIds = { original: -1, overlay: -1 };

function identifyFrames() {
  for (const el of [targetIframe, overlayIframe]) {
    el?.contentWindow?.postMessage({ fullyframe: 'identify', token: LINK_TOKEN }, '*');
  }
}

window.addEventListener('message', (e) => {
  const data = e.data;
  if (!overlayIframe || data?.fullyframe !== 'identity' || data.token !== LINK_TOKEN) return;
  if (!Number.isInteger(data.frameId)) return;
  if (e.source === targetIframe?.contentWindow) frameIds.original = data.frameId;
  else if (e.source === overlayIframe.contentWindow) frameIds.overlay = data.frameId;
  else return;
  linkFrames();
});

function linkFrames() {
  const frames = [frameIds.original, frameIds.overlay];
  if (!overlayIframe || frames.some((id) => id < 0)) return;
  linkedFrames = frames;
  chrome.runtime.sendMessage({ type: 'LINK_FRAMES', frames }).catch(() => {});
}

function unlinkFrames() {
  frameIds.original = -1;
  frameIds.overlay = -1;
  if (!linkedFrames) return;
  chrome.runtime.sendMessage({ type: 'UNLINK_FRAMES', frames: linkedFrames }).catch(() => {});
  linkedFrames = null;
}

// --- Activation ---

function activate() {
  if (isActive) return Promise.resolve(true);
  pendingActivation ??= doActivate().finally(() => { pendingActivation = null; });
  return pendingActivation;
}

async function doActivate() {
  const url = await getOverlayUrl();

  const ok = url ? await activateOverlay(url) : activateFullscreen();
  if (!ok) return false;

  mode = url ? 'overlay' : 'fullscreen';
  isActive = true;
  sessionStorage.setItem(SESSION_KEY, '1');
  return true;
}

function deactivate() {
  if (mode === 'overlay') deactivateOverlay();
  else if (mode === 'fullscreen') deactivateFullscreen();

  targetIframe = null;
  originalStyle = '';
  mode = null;
  isActive = false;
  sessionStorage.removeItem(SESSION_KEY);
}

// --- Keyboard: ESC closes, Alt+Space (Option+Space on Mac) switches views ---

function isSwitchKey(e) {
  return e.code === 'Space' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

// The Chrome shortcut and the in-page key handlers can both see the same
// keypress, so ignore a second switch that arrives right after the first.
let lastSwitchAt = 0;
function switchView() {
  const now = Date.now();
  if (now - lastSwitchAt < 150) return;
  lastSwitchAt = now;
  setOverlayVisible(!overlayVisible);
}

document.addEventListener('keydown', (e) => {
  if (!isActive) return;
  if (e.key === 'Escape') {
    deactivate();
    notifyState();
  } else if (mode === 'overlay' && isSwitchKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) {
      switchView();
      notifyState();
    }
  }
}, true);

// Used by the popup: 'overlay', 'original' (initial page), 'fullscreen' or null (off).
async function setView(view) {
  if (view === 'overlay' || view === 'original') {
    if (!isActive) {
      if (view === 'original') return;
      await activate();
    }
    if (isActive && mode === 'overlay') setOverlayVisible(view === 'overlay');
  } else if (view === 'fullscreen') {
    if (!isActive) await activate();
  } else if (isActive) {
    deactivate();
  }
}

// --- React to settings changes while active ---
// Picking another page reloads the overlay with it; deselecting all pages closes it.

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !isActive || !(OVERLAY_URL_KEY in changes)) return;
  deactivate();
  if (normalizeUrl(changes[OVERLAY_URL_KEY].newValue)) await activate();
  notifyState();
});

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE') {
    if (isActive && mode === 'overlay') {
      switchView();
      sendResponse(getState());
    } else if (isActive) {
      deactivate();
      sendResponse(getState());
    } else {
      activate().then(() => sendResponse(getState()));
    }
    return true;
  }
  if (msg.type === 'SET_VIEW') {
    setView(msg.view).then(() => {
      sendResponse(getState());
      notifyState();
    });
    return true;
  }
  if (msg.type === 'SWITCH_VIEW') {
    if (isActive && mode === 'overlay') {
      switchView();
      notifyState();
    }
  } else if (msg.type === 'DEACTIVATE') {
    if (isActive) {
      deactivate();
      notifyState();
    }
  } else if (msg.type === 'GET_STATUS') {
    sendResponse(getState());
  }
});

// --- Auto-activate on page load if this tab had it on ---

if (sessionStorage.getItem(SESSION_KEY)) {
  let attempts = 0;
  const tryActivate = async () => {
    if (await activate()) {
      console.log(`[FullyFrame] Auto-activated (${mode}) on page load.`);
      notifyState();
      return;
    }
    if (++attempts < 30) {
      setTimeout(tryActivate, 500);
    }
  };
  tryActivate();
}
