const KEY = 'overlayUrl';
const form = document.getElementById('form');
const input = document.getElementById('overlayUrl');
const status = document.getElementById('status');
const clearButton = document.getElementById('clear');

function showStatus(text, isError = false) {
  status.textContent = text;
  status.className = isError ? 'error' : '';
  if (!isError) setTimeout(() => { status.textContent = ''; }, 1500);
}

function normalize(value) {
  if (!value) return { url: '' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Invalid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http(s) URLs are supported.' };
  }
  return { url: url.href };
}

async function save(value) {
  const { url, error } = normalize(value.trim());
  if (error) {
    showStatus(error, true);
    return;
  }
  if (url) await chrome.storage.sync.set({ [KEY]: url });
  else await chrome.storage.sync.remove(KEY);
  input.value = url;
  showStatus(url ? 'Saved. Overlay mode enabled.' : 'Cleared. Fullscreen mode enabled.');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  save(input.value);
});

clearButton.addEventListener('click', () => save(''));

chrome.storage.sync.get(KEY).then(({ [KEY]: url }) => {
  input.value = url || '';
});
