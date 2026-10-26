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
let settings = { selected: [], urls: [] };

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

// --- Settings: list of overlay pages and the selected ones ---

// The list lives in an "Other bookmarks › FullyFrame" folder: Chrome deletes
// extension storage when the extension is removed, but bookmarks stay (and
// sync with the profile). Only the selection is kept in extension storage.

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
// The selected pages are kept in the list too.
function migrate(stored) {
  return serial(async () => {
    const old = Array.isArray(stored[LIST_KEY]) ? stored[LIST_KEY] : [];
    const saved = new Set((await savedBookmarks()).map(entryOf));
    const missing = [...new Set(old.map(normalize))].filter((u) => !saved.has(u));
    if (missing.length) {
      const parentId = await bookmarkFolder(true);
      for (const url of missing) await chrome.bookmarks.create({ parentId, title: url, url });
    }
    for (const entry of selectedEntries(stored[URL_KEY]).map(normalizeEntry)) {
      if (saved.has(entry) || missing.includes(entry)) continue;
      await createEntry(await bookmarkFolder(true), entry, 0);
      saved.add(entry);
    }
    if (LIST_KEY in stored) await chrome.storage.sync.remove(LIST_KEY);
  });
}

async function loadSettings({ migrate: migrating = false } = {}) {
  const stored = await chrome.storage.sync.get([URL_KEY, LIST_KEY]);
  if (migrating) await migrate(stored);
  const selected = selectedEntries(stored[URL_KEY]);
  const urls = [...new Set((await savedBookmarks()).map(entryOf))];
  settings = { selected, urls };
}

function setSelected(entries) {
  return entries.length
    ? chrome.storage.sync.set({ [URL_KEY]: entries })
    : chrome.storage.sync.remove(URL_KEY);
}

// Selects an entry, first in line. Only one entry per site is kept selected,
// so it replaces a selected entry pointing to the same site.
function withSelected(entry) {
  const site = entrySite(entry);
  return [entry, ...settings.selected.filter((e) => e !== entry && entrySite(e) !== site)];
}

function select(entry) {
  return setSelected(withSelected(entry));
}

function deselect(entry) {
  return setSelected(settings.selected.filter((e) => e !== entry));
}

function addUrl(entry) {
  return serial(async () => {
    const parentId = await bookmarkFolder(true);
    const existing = (await savedBookmarks()).find((b) => entryOf(b) === entry);
    if (existing) await chrome.bookmarks.move(existing.id, { parentId, index: 0 });
    else await createEntry(parentId, entry, 0);
    await select(entry);
  });
}

function removeUrl(entry) {
  return serial(async () => {
    for (const b of await savedBookmarks()) {
      if (entryOf(b) === entry) await chrome.bookmarks.remove(b.id);
    }
    if (settings.selected.includes(entry)) await deselect(entry);
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

function toggleEntry(entry) {
  return settings.selected.includes(entry) ? deselect(entry) : select(entry);
}

// A click selects or deselects the entry, but selecting its text (drag,
// double- or triple-click) to copy it doesn't. The checkmark changes at once
// and the change is saved a moment later, so the second click of a
// double-click can undo it before the overlay reloads. The rest of the popup
// updates once it's saved: changing its layout earlier would move the row
// from under the second click.
const CLICK_SETTLE_MS = 300;
let pendingToggle = null;

function clickEntry(e, entry) {
  if (e.detail > 1) {
    if (pendingToggle) {
      clearTimeout(pendingToggle.timer);
      settings.selected = pendingToggle.before;
      pendingToggle = null;
      markSelected();
    }
    return;
  }
  const sel = getSelection();
  if (!sel.isCollapsed && sel.containsNode(e.currentTarget, true)) return;
  flushToggle();
  const before = settings.selected;
  settings.selected = before.includes(entry) ? before.filter((x) => x !== entry) : withSelected(entry);
  const after = settings.selected;
  pendingToggle = { before, after, timer: setTimeout(flushToggle, CLICK_SETTLE_MS) };
  markSelected();
}

function markSelected() {
  for (const li of list.children) {
    const selected = settings.selected.includes(li.dataset.entry);
    li.classList.toggle('active', selected);
    li.querySelector('.pick').setAttribute('aria-pressed', String(selected));
  }
}

function flushToggle() {
  if (!pendingToggle) return;
  clearTimeout(pendingToggle.timer);
  setSelected(pendingToggle.after);
  pendingToggle = null;
}
// A triple-click selects the whole entry plus a line break; copy just the entry.
list.addEventListener('copy', (e) => {
  const text = getSelection().toString();
  if (text.trim() === text) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', text.trim());
});

// Closing the popup right after a click still saves it.
addEventListener('pagehide', flushToggle);
document.addEventListener('visibilitychange', flushToggle);

// The selected entry the overlay uses (or would use) on this tab.
function entryInUse() {
  if (tabState?.active && tabState.overlayEntry) return tabState.overlayEntry;
  return pickEntry(settings.selected, tabState?.pageUrl ?? tabUrl)?.entry ?? null;
}

function renderList() {
  const { query, matches } = searchState();
  const scrollLeft = listScroll.scrollLeft;
  const inUse = settings.selected.length > 1 ? entryInUse() : null;
  list.replaceChildren(...matches.map((url) => {
    const selected = settings.selected.includes(url);
    const li = document.createElement('li');
    li.dataset.entry = url;
    li.classList.toggle('active', selected);

    // Not a <button>, so its text can be selected and copied.
    const pick = document.createElement('div');
    pick.className = 'pick';
    pick.tabIndex = 0;
    pick.setAttribute('role', 'button');
    const kind = isPattern(url) ? 'pattern' : 'page';
    pick.title = selected ? `Click to stop using this ${kind}` : `Use this ${kind}`;
    pick.setAttribute('aria-pressed', String(selected));
    const lead = document.createElement('span');
    lead.className = 'lead';
    const check = document.createElement('span');
    check.className = 'check';
    lead.append(check);
    if (url === inUse) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'in use';
      tag.title = 'The overlay opens this one on the current page';
      lead.append(tag);
    }
    pick.append(lead, urlText(url, query));
    pick.addEventListener('click', (e) => clickEntry(e, url));
    pick.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        toggleEntry(url);
      }
    });

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
    ? 'Click a page or pattern to use it, click it again to stop. Select one for each of two sites (e.g. two patterns) and the overlay opens the one for the other site. With none selected, FullyFrame makes the preview iframe fullscreen.'
    : 'Add a page or pattern to compare against. With none selected, FullyFrame makes the preview iframe fullscreen.';
}

// --- Actions on the current tab ---

function renderActions() {
  const reachable = tabState !== null;
  const pending = statusPending && !reachable;
  const comparing = settings.selected.length > 0;
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
  if (settings.selected.length > 1) renderList(); // the entry in use may have changed
}

// With a pattern or several pages selected, the page the overlay opens for this one.
function renderResolved() {
  const el = $('resolvedHint');
  const { selected } = settings;
  // On aemcoder patterns are filled in from the preview iframe's page,
  // which only the page can tell.
  const pageUrl = tabState?.pageUrl ?? tabUrl;
  el.hidden = !(selected.length > 1 || selected.some(isPattern)) || (statusPending && !tabState);
  if (el.hidden) return;
  const url = (tabState?.active && tabState.overlayUrl) || pickEntry(selected, pageUrl)?.url;
  if (!url) {
    el.textContent = pageUrl ? noUrlMessage() : 'No preview iframe found to fill the pattern in from.';
  } else if (url === normalize(pageUrl)) {
    el.textContent = 'The overlay would show this same page. Also select a pattern for the other site.';
  } else {
    const link = document.createElement('span');
    link.className = 'resolved-url';
    link.textContent = url;
    el.replaceChildren('Overlay page: ', link);
  }
}

function noUrlMessage() {
  return settings.selected.length > 1 ? 'None of the selected patterns gives a page for this one.'
    : 'The selected pattern gives no page for this one.';
}

async function sendView(view) {
  showError(actionError, '');
  try {
    tabState = await chrome.tabs.sendMessage(tabId, { type: 'SET_VIEW', view }, { frameId: 0 });
  } catch {
    tabState = null;
  }
  if (tabState && view && !tabState.active) {
    showError(actionError, tabState.error === 'no-url' ? noUrlMessage()
      : settings.selected.length ? 'No preview iframe found on this page.' : 'No iframe found on this page.');
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
    await select(matches[0]);
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
