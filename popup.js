const URL_KEY = 'overlayUrl';
const LIST_KEY = 'overlayUrls';
const BOOKMARK_FOLDER = 'FullyFrame';
const IS_MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const ALT = IS_MAC ? '⌥' : 'Alt+';

const $ = (id) => document.getElementById(id);
const compareRow = $('compareRow');
const compareSwitch = $('compareSwitch');
const fullscreenRow = $('fullscreenRow');
const fullscreenSwitch = $('fullscreenSwitch');
const actionHint = $('actionHint');
const actionError = $('actionError');
const addForm = $('addForm');
const urlInput = $('urlInput');
const addButton = $('addButton');
const searchHint = $('searchHint');
const list = $('list');
const listScroll = $('listScroll');

let tabId = null;
let tabState = null; // null when the page can't be reached
// A busy page can take seconds to answer, so the popup renders before it does.
let statusPending = true;
let tabHost = '';
let tabUrl = '';
const IFRAME_OVERLAY_HOSTS = ['aemcoder.adobe.io'];
let settings = { active: '', urls: [] };

// Returns the http(s) URL the text stands for, or null. "example.com/page"
// is read as https://example.com/page.
function toUrl(value) {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Without a scheme, require something that looks like a host name.
  if (!hasScheme && !url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  return url.href;
}

function showError(el, text) {
  el.textContent = text || '';
  el.hidden = !text;
}

// --- Settings: list of overlay pages and the active one ---

// The list lives in an "Other bookmarks › FullyFrame" folder: Chrome deletes
// extension storage when the extension is removed, but bookmarks stay (and
// sync with the profile). Only the active page is kept in extension storage.

const normalize = (url) => {
  try { return new URL(url).href; } catch { return url; }
};

// The list holds URLs and URL patterns (see patterns.js). A bookmark URL can't
// hold a pattern's {…}, so a pattern is kept as the bookmark's title, with the
// site it points to as its URL.
const normalizeEntry = (entry) => (isPattern(entry) ? entry.trim() : normalize(entry));

function entryOf(bookmark) {
  const title = bookmark.title?.trim();
  return isPattern(title) ? title : normalize(bookmark.url);
}

function createEntry(parentId, entry, index) {
  const url = isPattern(entry) ? patternHome(entry) : entry;
  if (!url) return Promise.resolve();
  return chrome.bookmarks.create({ parentId, index, title: entry, url });
}

let writes = Promise.resolve();
function serial(fn) {
  const run = writes.then(fn);
  writes = run.catch(() => {});
  return run;
}

async function bookmarkFolder(create) {
  const roots = await chrome.bookmarks.getChildren('0');
  const other = roots.find((n) => n.folderType === 'other') ?? roots[1] ?? roots[0];
  const folder = (await chrome.bookmarks.getChildren(other.id))
    .find((n) => !n.url && n.title === BOOKMARK_FOLDER);
  if (folder || !create) return folder?.id ?? null;
  return (await chrome.bookmarks.create({ parentId: other.id, title: BOOKMARK_FOLDER })).id;
}

async function savedBookmarks() {
  const id = await bookmarkFolder(false);
  return id ? (await chrome.bookmarks.getChildren(id)).filter((n) => n.url) : [];
}

// Older versions kept the list in extension storage; move it to bookmarks.
// The active page is kept in the list too.
function migrate(stored) {
  return serial(async () => {
    const old = Array.isArray(stored[LIST_KEY]) ? stored[LIST_KEY] : [];
    const active = typeof stored[URL_KEY] === 'string' ? stored[URL_KEY] : '';
    const saved = new Set((await savedBookmarks()).map(entryOf));
    const missing = [...new Set(old.map(normalize))].filter((u) => !saved.has(u));
    if (missing.length) {
      const parentId = await bookmarkFolder(true);
      for (const url of missing) await chrome.bookmarks.create({ parentId, title: url, url });
    }
    if (active && !saved.has(normalizeEntry(active)) && !missing.includes(normalizeEntry(active))) {
      const parentId = await bookmarkFolder(true);
      await createEntry(parentId, normalizeEntry(active), 0);
    }
    if (LIST_KEY in stored) await chrome.storage.sync.remove(LIST_KEY);
  });
}

async function loadSettings({ migrate: migrating = false } = {}) {
  const stored = await chrome.storage.sync.get([URL_KEY, LIST_KEY]);
  if (migrating) await migrate(stored);
  const active = typeof stored[URL_KEY] === 'string' ? stored[URL_KEY] : '';
  const urls = [...new Set((await savedBookmarks()).map(entryOf))];
  settings = { active, urls };
}

function setActive(url) {
  return url
    ? chrome.storage.sync.set({ [URL_KEY]: url })
    : chrome.storage.sync.remove(URL_KEY);
}

function addUrl(entry) {
  return serial(async () => {
    const parentId = await bookmarkFolder(true);
    const existing = (await savedBookmarks()).find((b) => entryOf(b) === entry);
    if (existing) await chrome.bookmarks.move(existing.id, { parentId, index: 0 });
    else await createEntry(parentId, entry, 0);
    await setActive(entry);
  });
}

function removeUrl(entry) {
  return serial(async () => {
    for (const b of await savedBookmarks()) {
      if (entryOf(b) === entry) await chrome.bookmarks.remove(b.id);
    }
    if (settings.active === entry) await setActive('');
  });
}

// The input both filters the list and, when it holds a URL or pattern that
// isn't saved yet, enables adding it.
function searchState() {
  const query = urlInput.value.trim().toLowerCase();
  const matches = query ? settings.urls.filter((u) => u.toLowerCase().includes(query)) : settings.urls;
  const pattern = toPattern(urlInput.value);
  const url = pattern ? pattern.pattern ?? null : toUrl(urlInput.value);
  const addable = !!url && !settings.urls.includes(url);
  return { query, matches, url, addable, isPattern: !!pattern, error: pattern?.error ?? '' };
}

function renderSearch() {
  const { query, matches, url, addable, isPattern: pattern, error } = searchState();
  const kind = pattern ? 'pattern' : 'URL';
  addButton.disabled = !addable;
  addButton.textContent = `Add ${kind}`;
  addButton.title = addable ? `Add ${url}` : url ? 'Already in the list' : error || 'Type a URL or pattern to add it';
  let hint = '';
  if (query && !matches.length) {
    hint = addable ? `Not in the list yet. Press Enter or Add ${kind} to add and select it.`
      : error || 'No saved pages match. Type a full URL or a pattern to add one.';
  }
  searchHint.textContent = hint;
  searchHint.hidden = !hint;
  renderList();
}

// The entry text, with every occurrence of the search query highlighted and,
// in patterns, the {…} parts marked.
function urlText(text, query) {
  const span = document.createElement('span');
  span.className = 'url';
  const lower = text.toLowerCase();
  const marks = [];
  for (let i = query ? lower.indexOf(query) : -1; i >= 0; i = lower.indexOf(query, i + query.length)) {
    marks.push([i, i + query.length]);
  }
  const tokens = isPattern(text) ? [...text.matchAll(/\{[^{}]*\}/g)].map((m) => [m.index, m.index + m[0].length]) : [];
  const cuts = [...new Set([0, text.length, ...marks.flat(), ...tokens.flat()])].sort((a, b) => a - b);
  const within = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);
  for (let k = 0; k < cuts.length - 1; k++) {
    let node = document.createTextNode(text.slice(cuts[k], cuts[k + 1]));
    if (within(tokens, cuts[k])) {
      const ph = document.createElement('span');
      ph.className = 'ph';
      ph.append(node);
      node = ph;
    }
    if (within(marks, cuts[k])) {
      const mark = document.createElement('mark');
      mark.append(node);
      node = mark;
    }
    span.append(node);
  }
  return span;
}

// When the search changes, scroll the list sideways so the match in the first
// result is visible (centred between the pinned checkbox and remove button).
let revealedQuery = '';
function revealMatch(query) {
  if (query === revealedQuery) return;
  revealedQuery = query;
  listScroll.scrollLeft = 0;
  const first = list.firstElementChild;
  const mark = first?.querySelector('mark');
  if (!mark) return;
  const left = first.querySelector('.lead').getBoundingClientRect().right;
  const right = first.querySelector('.remove').getBoundingClientRect().left;
  const m = mark.getBoundingClientRect();
  if (m.right <= right) return;
  listScroll.scrollLeft = (m.left + m.right) / 2 - (left + right) / 2;
}

function renderList() {
  const { query, matches } = searchState();
  const scrollLeft = listScroll.scrollLeft;
  list.replaceChildren(...matches.map((url) => {
    const li = document.createElement('li');
    li.classList.toggle('active', url === settings.active);

    const pick = document.createElement('button');
    pick.className = 'pick';
    const kind = isPattern(url) ? 'pattern' : 'page';
    pick.title = url === settings.active ? `Click to stop using this ${kind}` : `Use this ${kind}`;
    pick.setAttribute('aria-pressed', String(url === settings.active));
    const lead = document.createElement('span');
    lead.className = 'lead';
    const check = document.createElement('span');
    check.className = 'check';
    lead.append(check);
    pick.append(lead, urlText(url, query));
    pick.addEventListener('click', () => setActive(url === settings.active ? '' : url));

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remove from list';
    remove.setAttribute('aria-label', `Remove ${url}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeUrl(url));

    li.append(pick, remove);
    return li;
  }));
  listScroll.scrollLeft = scrollLeft;
  revealMatch(query);
  $('listHint').textContent = settings.urls.length
    ? 'Click a page or pattern to use it, click it again to stop. With none selected, FullyFrame makes the preview iframe fullscreen.'
    : 'Add a page or pattern to compare against. With none selected, FullyFrame makes the preview iframe fullscreen.';
}

// --- Actions on the current tab ---

function renderActions() {
  const reachable = tabState !== null;
  const pending = statusPending && !reachable;
  const comparing = !!settings.active;
  compareRow.hidden = !comparing;
  fullscreenRow.hidden = comparing;
  compareSwitch.disabled = fullscreenSwitch.disabled = !reachable;

  const view = tabState?.active ? tabState.view : null;
  compareSwitch.checked = view === 'overlay';
  // On aemcoder the overlay is the source page and the preview is EDS.
  const aem = tabState ? tabState.target === 'iframe' : IFRAME_OVERLAY_HOSTS.includes(tabHost);
  $('initLabel').textContent = aem ? 'EDS' : 'Initial';
  $('overLabel').textContent = aem ? 'Source' : 'Overlay';
  $('overLabel').classList.toggle('on', view === 'overlay');
  $('initLabel').classList.toggle('on', view !== 'overlay');
  fullscreenSwitch.checked = view === 'fullscreen';

  if (pending) {
    actionHint.textContent = 'Waiting for the page…';
  } else if (!reachable) {
    actionHint.textContent = 'FullyFrame can\'t run on this page. If it was just installed or updated, reload the page.';
  } else if (comparing) {
    actionHint.textContent = tabState.target === 'iframe'
      ? 'The selected source page is laid over the EDS preview iframe.'
      : 'The selected page is laid over this whole page.';
  } else {
    actionHint.textContent = 'No overlay page selected.';
  }
  renderResolved();
}

// For a selected pattern, the page it gives for this one.
function renderResolved() {
  const el = $('resolvedHint');
  const pattern = isPattern(settings.active) ? settings.active : null;
  // On aemcoder the pattern is filled in from the preview iframe's page,
  // which only the page can tell.
  const pageUrl = tabState?.pageUrl ?? tabUrl;
  el.hidden = !pattern || (statusPending && !tabState);
  if (el.hidden) return;
  const url = (tabState?.active && tabState.overlayUrl) || resolvePattern(pattern, pageUrl);
  if (!url) {
    el.textContent = pageUrl ? 'The selected pattern gives no page for this one.' : 'No preview iframe found to fill the pattern in from.';
  } else if (url === normalize(pageUrl)) {
    el.textContent = 'The selected pattern gives this same page. Select the pattern for the other site.';
  } else {
    const link = document.createElement('span');
    link.className = 'resolved-url';
    link.textContent = url;
    el.replaceChildren('Overlay page: ', link);
  }
}

async function sendView(view) {
  showError(actionError, '');
  try {
    tabState = await chrome.tabs.sendMessage(tabId, { type: 'SET_VIEW', view }, { frameId: 0 });
  } catch {
    tabState = null;
  }
  if (tabState && view && !tabState.active) {
    showError(actionError, tabState.error === 'no-url' ? 'The selected pattern gives no page for this one.'
      : settings.active ? 'No preview iframe found on this page.' : 'No iframe found on this page.');
  }
  renderActions();
}

compareSwitch.addEventListener('change', () => sendView(compareSwitch.checked ? 'overlay' : 'original'));
fullscreenSwitch.addEventListener('change', () => sendView(fullscreenSwitch.checked ? 'fullscreen' : null));

// Enter adds a new URL, or selects the page when exactly one saved page matches.
async function submitSearch() {
  const { matches, url, addable } = searchState();
  if (addable) {
    await addUrl(url);
  } else if (matches.length === 1) {
    await setActive(matches[0]);
  } else {
    return;
  }
  urlInput.value = '';
  renderSearch();
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitSearch();
});
// Handled here because a form won't submit on Enter while its button is disabled.
urlInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  submitSearch();
});
urlInput.addEventListener('input', renderSearch);

let refreshing = null;
function refresh() {
  refreshing ??= Promise.resolve().then(async () => {
    refreshing = null;
    await loadSettings();
    showError(actionError, '');
    renderSearch();
    renderActions();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && URL_KEY in changes) refresh();
});
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
  chrome.bookmarks[event].addListener(refresh);
}

// The page reports state changes (Alt+Space, Esc, overlay reloaded with a new page).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'STATE_CHANGED' || sender.tab?.id !== tabId || sender.frameId !== 0) return;
  tabState = msg;
  statusPending = false;
  renderActions();
});

$('keysHint').innerHTML =
  `<kbd>${ALT}Space</kbd> switch views &nbsp;·&nbsp; <kbd>click</kbd> set sync point &nbsp;·&nbsp; <kbd>Esc</kbd> close`;

// --- Update notices ---

const VERSION = chrome.runtime.getManifest().version;

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Changes in versions after `from`, up to and including `to`, newest first.
function changesBetween(log, from, to) {
  if (!Array.isArray(log)) return [];
  return log
    .filter((e) => e && typeof e.version === 'string' && Array.isArray(e.changes)
      && compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .flatMap((e) => e.changes.map(String));
}

function fillList(el, items) {
  el.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

let localChangelog = null;

async function renderNotices() {
  const { latestVersion, latestChangelog, whatsNewSince } =
    await chrome.storage.local.get(['latestVersion', 'latestChangelog', 'whatsNewSince']);

  const available = typeof latestVersion === 'string' && compareVersions(latestVersion, VERSION) > 0;
  $('updateBanner').hidden = !available;
  if (available) {
    $('updateTitle').textContent = `Update available: v${latestVersion} (you have v${VERSION})`;
    fillList($('updateChanges'), changesBetween(latestChangelog, VERSION, latestVersion));
  }

  let news = [];
  if (whatsNewSince) {
    localChangelog ??= await fetch(chrome.runtime.getURL('changelog.json')).then((r) => r.json()).catch(() => []);
    news = changesBetween(localChangelog, whatsNewSince, VERSION);
  }
  $('whatsNewBanner').hidden = !news.length;
  $('whatsNewTitle').textContent = `Updated to v${VERSION} – what's new`;
  fillList($('whatsNewChanges'), news);

  $('notices').hidden = !available && !news.length;
}

$('whatsNewDismiss').addEventListener('click', () => chrome.storage.local.remove('whatsNewSince'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') renderNotices();
});
renderNotices();
chrome.runtime.sendMessage({ type: 'CHECK_FOR_UPDATE' }).catch(() => {});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  tabUrl = tab?.url || '';
  try { tabHost = new URL(tabUrl).hostname; } catch {}
  await loadSettings({ migrate: true });
  renderSearch();
  renderActions();
  if (tabId !== null) {
    const status = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }, { frameId: 0 }).catch(() => null);
    // A STATE_CHANGED that arrived meanwhile is at least as fresh.
    if (statusPending) tabState = status ?? null;
  }
  statusPending = false;
  renderActions();
})();
