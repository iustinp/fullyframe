const URL_KEY = 'overlayUrl';
const LIST_KEY = 'overlayUrls';
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

let tabId = null;
let tabState = null; // null when the page can't be reached
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

async function loadSettings({ migrate = false } = {}) {
  const stored = await chrome.storage.sync.get([URL_KEY, LIST_KEY]);
  const active = typeof stored[URL_KEY] === 'string' ? stored[URL_KEY] : '';
  const urls = Array.isArray(stored[LIST_KEY]) ? stored[LIST_KEY] : [];
  // Keep a page set before the list existed (older versions) in the list.
  if (migrate && active && !urls.includes(active)) {
    urls.unshift(active);
    await chrome.storage.sync.set({ [LIST_KEY]: urls });
  }
  settings = { active, urls };
}

function setActive(url) {
  return url
    ? chrome.storage.sync.set({ [URL_KEY]: url })
    : chrome.storage.sync.remove(URL_KEY);
}

async function addUrl(url) {
  const urls = [url, ...settings.urls.filter((u) => u !== url)];
  await chrome.storage.sync.set({ [LIST_KEY]: urls, [URL_KEY]: url });
}

async function removeUrl(url) {
  const urls = settings.urls.filter((u) => u !== url);
  if (settings.active === url) await setActive('');
  await chrome.storage.sync.set({ [LIST_KEY]: urls });
}

// The input both filters the list and, when it holds a URL that isn't saved
// yet, enables adding it.
function searchState() {
  const query = urlInput.value.trim().toLowerCase();
  const matches = query ? settings.urls.filter((u) => u.toLowerCase().includes(query)) : settings.urls;
  const url = toUrl(urlInput.value);
  const addable = !!url && !settings.urls.includes(url);
  return { query, matches, url, addable };
}

function renderSearch() {
  const { query, matches, url, addable } = searchState();
  addButton.disabled = !addable;
  addButton.title = addable ? `Add ${url}` : url ? 'Already in the list' : 'Type a URL to add it';
  let hint = '';
  if (query && !matches.length) {
    hint = addable ? 'Not in the list yet. Press Enter or Add URL to add and select it.'
      : 'No saved pages match. Type a full URL to add one.';
  }
  searchHint.textContent = hint;
  searchHint.hidden = !hint;
  renderList(matches);
}

function renderList(urls = searchState().matches) {
  list.replaceChildren(...urls.map((url) => {
    const li = document.createElement('li');
    li.classList.toggle('active', url === settings.active);

    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.title = url === settings.active ? 'Click to stop using this page' : 'Use this page';
    pick.setAttribute('aria-pressed', String(url === settings.active));
    const check = document.createElement('span');
    check.className = 'check';
    const text = document.createElement('span');
    text.className = 'url';
    text.textContent = url;
    pick.append(check, text);
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
  $('listHint').textContent = settings.urls.length
    ? 'Click a page to use it, click it again to stop. With none selected, FullyFrame makes the preview iframe fullscreen.'
    : 'Add a page to compare against. With none selected, FullyFrame makes the preview iframe fullscreen.';
}

// --- Actions on the current tab ---

function renderActions() {
  const reachable = tabState !== null;
  const comparing = !!settings.active;
  compareRow.hidden = !comparing;
  fullscreenRow.hidden = comparing;
  compareSwitch.disabled = fullscreenSwitch.disabled = !reachable;

  const view = tabState?.active ? tabState.view : null;
  compareSwitch.checked = view === 'overlay';
  // On aemcoder the overlay is the source page and the preview is EDS.
  const aem = tabState?.target === 'iframe';
  $('initLabel').textContent = aem ? 'EDS' : 'Initial';
  $('overLabel').textContent = aem ? 'Source' : 'Overlay';
  $('overLabel').classList.toggle('on', view === 'overlay');
  $('initLabel').classList.toggle('on', view !== 'overlay');
  fullscreenSwitch.checked = view === 'fullscreen';

  if (!reachable) {
    actionHint.textContent = 'FullyFrame can\'t run on this page. If it was just installed or updated, reload the page.';
  } else if (comparing) {
    actionHint.textContent = tabState.target === 'iframe'
      ? 'The selected source page is laid over the EDS preview iframe.'
      : 'The selected page is laid over this whole page.';
  } else {
    actionHint.textContent = 'No overlay page selected.';
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
    showError(actionError, settings.active ? 'No preview iframe found on this page.' : 'No iframe found on this page.');
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

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !(URL_KEY in changes || LIST_KEY in changes)) return;
  await loadSettings();
  showError(actionError, '');
  renderSearch();
  renderActions();
});

// The page reports state changes (Alt+Space, Esc, overlay reloaded with a new page).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'STATE_CHANGED' || sender.tab?.id !== tabId || sender.frameId !== 0) return;
  tabState = msg;
  renderActions();
});

$('keysHint').innerHTML =
  `<kbd>${ALT}Space</kbd> switch views &nbsp;·&nbsp; <kbd>${ALT}click</kbd> align text &nbsp;·&nbsp; <kbd>Esc</kbd> close`;

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  await loadSettings({ migrate: true });
  if (tabId !== null) {
    tabState = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }, { frameId: 0 }).catch(() => null) ?? null;
  }
  renderSearch();
  renderActions();
})();
