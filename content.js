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
let overlayEntries = []; // the selected URLs and patterns the overlay was opened with
let overlayEntry = null; // the one of them in use
let patternPageUrl = ''; // the page URL the pattern was last filled in from
let activationError = null; // 'no-iframe' | 'no-url' when activating last failed
let syncWhenLinked = false; // the overlay got a new page: line it up once linked
// Lets the overlay page's own scripts lay it out (EDS loads sections after load).
const OPEN_SYNC_DELAY_MS = 800;
const OPEN_SYNC_TRIES = 10;
const SYNC_TIMEOUT_MS = 600;

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

// The selected overlay pages: URLs and URL patterns (see patterns.js).
async function getOverlayEntries() {
  try {
    const { [OVERLAY_URL_KEY]: value } = await chrome.storage.sync.get(OVERLAY_URL_KEY);
    return selectedEntries(value);
  } catch {
    return [];
  }
}

// The page patterns are filled in from: the preview iframe's page on
// IFRAME_OVERLAY_HOSTS, else this page.
function comparedPageUrl() {
  if (OVERLAY_TARGET === 'page') return location.href;
  return (targetIframe?.isConnected ? targetIframe : findIframe())?.src || '';
}

function getState() {
  let view = null;
  if (isActive) view = mode === 'overlay' ? (overlayVisible ? 'overlay' : 'original') : mode;
  return {
    active: isActive,
    view,
    target: OVERLAY_TARGET,
    pageUrl: comparedPageUrl(),
    overlayUrl: overlayIframe ? overlayIframe.src : null,
    overlayEntry: isActive ? overlayEntry : null,
    error: activationError,
  };
}

function notifyState() {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', ...getState() }).catch(() => {});
}

// --- Fullscreen mode (original behaviour) ---

// Covers the visible area, but lays the framed page out at the page's own width.
// Normally 100vw/100vh is the visible area (scrollbars included). In DevTools'
// device mode, content wider than the device makes Chrome zoom out: the visible
// area (100% for fixed elements) grows beyond 100vw/100vh, which stay at the
// device size. The height then follows the visible area, while the width stays
// at the device width (same breakpoints and zoom as the page) with the rest
// padded in white.
const VIEWPORT_BOX_CSS =
  'position:fixed!important;top:0!important;left:0!important;' +
  'width:max(100%, 100vw)!important;height:max(100%, 100vh)!important;' +
  'padding:0 max(0px, calc(100% - 100vw)) 0 0!important;' +
  'box-sizing:border-box!important;max-width:none!important;max-height:none!important;' +
  'z-index:2147483647!important;border:none!important;margin:0!important;' +
  'background:#fff!important;';

const FULLSCREEN_CSS = VIEWPORT_BOX_CSS;

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
const PAGE_OVERLAY_CSS = VIEWPORT_BOX_CSS + 'display:block!important;transform:none!important;';

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
  syncWhenLinked = true;
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
  followComparedPage();
  trackingFrame = requestAnimationFrame(trackTarget);
}

// With a pattern (or several pages) selected, when the preview iframe moves
// to another page, load the matching page in the overlay.
function followComparedPage() {
  if (!overlayIframe || !targetIframe) return;
  if (overlayEntries.length < 2 && !overlayEntries.some(isPattern)) return;
  const pageUrl = targetIframe.src;
  if (!pageUrl || pageUrl === patternPageUrl) return;
  patternPageUrl = pageUrl;
  const pick = pickEntry(overlayEntries, pageUrl);
  if (pick && pick.url !== overlayIframe.src) {
    overlayEntry = pick.entry;
    overlayIframe.src = pick.url;
    if (overlayVisible) showUrlBadge(pick.url);
    syncWhenLinked = true;
    notifyState();
  }
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
  syncWhenLinked = false;
  lastOverlayCss = '';
  revokeOverlayFraming();
}

function revokeOverlayFraming() {
  chrome.runtime.sendMessage({ type: 'REVOKE_OVERLAY_FRAMING' }).catch(() => {});
}

// --- Linking the original iframe (or page) and the overlay ---
// frame.js runs inside both frames; once linked, switching views keeps the
// same content in place (see frame.js). The background relays the messages.
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
  // A newly opened overlay page starts at the content shown on the initial
  // page. Its own scripts may still be adding content, so try again until
  // something pairs up.
  if (syncWhenLinked) {
    syncWhenLinked = false;
    const frame = overlayIframe;
    let tries = 0;
    const attempt = () => queueFlip(async () => {
      if (overlayIframe !== frame || !overlayVisible || !linkedFrames) return;
      const res = await syncFrames(linkedFrames[0], linkedFrames[1]);
      if (!res?.paired && ++tries < OPEN_SYNC_TRIES) setTimeout(attempt, OPEN_SYNC_DELAY_MS);
    });
    setTimeout(attempt, OPEN_SYNC_DELAY_MS);
  }
}

// Asks the page being left to put the same content in place on the page about
// to be shown. Gives up after a while, so a busy page can't block switching.
// A frame whose last sync paired nothing (e.g. still loading). Normally a
// page left unscrolled since it was synced isn't synced again, so flipping
// back returns to the same spot; this frame needs syncing regardless.
const unsyncedFrames = new Set();

async function syncFrames(from, to) {
  const res = await Promise.race([
    chrome.runtime.sendMessage({ type: 'SYNC_FRAMES', from, to, force: unsyncedFrames.has(to) }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, SYNC_TIMEOUT_MS)),
  ]);
  if (res?.paired) unsyncedFrames.delete(to);
  else if (!res?.skipped) unsyncedFrames.add(to);
  return res;
}

function unlinkFrames() {
  frameIds.original = -1;
  frameIds.overlay = -1;
  unsyncedFrames.clear();
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
  activationError = null;
  const entries = await getOverlayEntries();

  if (!entries.length) {
    if (!activateFullscreen()) {
      activationError = 'no-iframe';
      return false;
    }
    mode = 'fullscreen';
  } else {
    if (OVERLAY_TARGET === 'iframe' && !findIframe()) {
      activationError = 'no-iframe';
      return false;
    }
    const pick = pickEntry(entries, comparedPageUrl());
    if (!pick) {
      activationError = 'no-url';
      return false;
    }
    if (!await activateOverlay(pick.url)) {
      activationError = 'no-iframe';
      return false;
    }
    overlayEntries = entries;
    overlayEntry = pick.entry;
    patternPageUrl = comparedPageUrl();
    mode = 'overlay';
  }

  isActive = true;
  sessionStorage.setItem(SESSION_KEY, '1');
  if (mode === 'overlay') showUrlBadge(overlayIframe.src);
  return true;
}

function deactivate() {
  hideUrlBadge();
  if (mode === 'overlay') deactivateOverlay();
  else if (mode === 'fullscreen') deactivateFullscreen();

  targetIframe = null;
  originalStyle = '';
  mode = null;
  overlayEntries = [];
  overlayEntry = null;
  patternPageUrl = '';
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
  if (now - lastSwitchAt < 150) return Promise.resolve();
  lastSwitchAt = now;
  return showOverlay(null);
}

// Switches run one after another, each after the previous one's sync.
let flips = Promise.resolve();
function queueFlip(fn) {
  const run = flips.then(fn);
  flips = run.catch(() => {});
  return run;
}

// Shows the overlay (true), the initial page (false) or the other one (null),
// with the content that was in view kept in place.
function showOverlay(visible) {
  return queueFlip(async () => {
    if (!isActive || mode !== 'overlay') return;
    const next = visible ?? !overlayVisible;
    if (next === overlayVisible) return;
    let res = null;
    if (linkedFrames) {
      const [original, overlay] = linkedFrames;
      res = await (next ? syncFrames(original, overlay) : syncFrames(overlay, original));
    }
    if (!isActive || mode !== 'overlay') return;
    setOverlayVisible(next);
    showUrlBadge(res?.url || (next ? overlayIframe?.src : comparedPageUrl()));
  });
}

// --- URL badge: briefly shows which page is in view after a flip ---
// Shown for 1s at the bottom right of the compared area, then fades out over
// 1s and is removed from the page. It never takes clicks, and its styles live
// in a closed shadow root so the page's CSS can't reach in (or out).

const BADGE_SHOW_MS = 1000;
const BADGE_FADE_MS = 1000;
let urlBadge = null;
let urlBadgeTimer = null;

function hideUrlBadge() {
  clearTimeout(urlBadgeTimer);
  urlBadge?.remove();
  urlBadge = null;
}

function showUrlBadge(url) {
  hideUrlBadge();
  if (!url) return;
  // Bottom right of the preview iframe on aemcoder, else of the window.
  let right = 0;
  let bottom = 0;
  let width = document.documentElement.clientWidth;
  if (OVERLAY_TARGET === 'iframe' && targetIframe?.isConnected) {
    const r = targetIframe.getBoundingClientRect();
    right = Math.max(0, innerWidth - Math.min(r.right, innerWidth));
    bottom = Math.max(0, innerHeight - Math.min(r.bottom, innerHeight));
    width = r.width;
  }
  const aem = OVERLAY_TARGET === 'iframe';
  const label = overlayVisible ? (aem ? 'Source' : 'Overlay') : (aem ? 'EDS' : 'Initial');

  const host = document.createElement('fullyframe-badge');
  host.style.cssText =
    'all:initial!important;position:fixed!important;z-index:2147483647!important;' +
    'pointer-events:none!important;display:block!important;' +
    `right:${right + 12}px!important;bottom:${bottom + 12}px!important;` +
    `max-width:${Math.max(160, Math.min(560, width - 24))}px!important;`;
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .badge { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-radius: 6px;
      background: rgba(17, 24, 39, .88); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
      font: 12px/1.4 system-ui, -apple-system, sans-serif; overflow-wrap: anywhere;
      animation: fade ${BADGE_FADE_MS}ms ease-in ${BADGE_SHOW_MS}ms forwards; }
    .label { flex: none; font-weight: 600; color: ${overlayVisible ? '#c4b5fd' : '#d1d5db'}; }
    @keyframes fade { to { opacity: 0; } }
  </style><div class="badge"><span class="label"></span><span class="url"></span></div>`;
  shadow.querySelector('.label').textContent = label;
  shadow.querySelector('.url').textContent = url;
  document.documentElement.appendChild(host);
  urlBadge = host;
  urlBadgeTimer = setTimeout(hideUrlBadge, BADGE_SHOW_MS + BADGE_FADE_MS);
}

document.addEventListener('keydown', (e) => {
  if (!isActive) return;
  if (e.key === 'Escape') {
    deactivate();
    notifyState();
  } else if (mode === 'overlay' && isSwitchKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) switchView().then(notifyState);
  }
}, true);

// Used by the popup: 'overlay', 'original' (initial page), 'fullscreen' or null (off).
async function setView(view) {
  if (view === 'overlay' || view === 'original') {
    if (!isActive) {
      if (view === 'original') return;
      await activate();
    }
    await showOverlay(view === 'overlay');
  } else if (view === 'fullscreen') {
    if (!isActive) await activate();
  } else if (isActive) {
    deactivate();
  }
}

// --- React to settings changes while active ---
// Picking another page reloads the overlay with it; deselecting all pages
// closes it. A change that leaves the overlay on the same page (e.g. also
// selecting the pattern for this site) keeps it as it is.

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !isActive || !(OVERLAY_URL_KEY in changes)) return;
  const entries = selectedEntries(changes[OVERLAY_URL_KEY].newValue);
  if (mode === 'overlay' && entries.length) {
    const pick = pickEntry(entries, comparedPageUrl());
    if (pick && pick.url === overlayIframe?.src) {
      overlayEntries = entries;
      overlayEntry = pick.entry;
      notifyState();
      return;
    }
  }
  deactivate();
  if (entries.length) await activate();
  notifyState();
});

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE') {
    if (isActive && mode === 'overlay') {
      switchView().then(() => sendResponse(getState()));
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
    if (isActive && mode === 'overlay') switchView().then(notifyState);
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
