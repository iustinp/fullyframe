// URL patterns: an overlay page written as a template that is filled in from
// the page you're on, e.g. "https://main--site--org.aem.page{path}{-'.html'}".
//
//   {path}   the current page's path, e.g. /us/en/page.html
//   {query}  its query string, with the "?" (empty if none)
//   {hash}   its "#fragment" (empty if none)
//   {-'x'}   removes x from the end of what comes before it, if it's there
//   {+'x'}   adds x to the end of what comes before it, unless it's already
//            there or that ends with "/"
//
// Quotes around x are optional. Loaded by both the popup and content.js.

const PATTERN_PLACEHOLDERS = ['path', 'query', 'hash'];
const PATTERN_SAMPLE_PAGE = 'https://example.com/a/b.html?q=1#h';

function isPattern(text) {
  return typeof text === 'string' && /\{\s*(path|query|hash)\s*\}/i.test(text);
}

// Splits a pattern into literal text, placeholders and edits. Throws with a
// readable message when a {…} isn't understood.
function parsePattern(pattern) {
  const parts = [];
  let at = 0;
  for (const m of pattern.matchAll(/\{([^{}]*)\}/g)) {
    if (m.index > at) parts.push({ text: pattern.slice(at, m.index) });
    at = m.index + m[0].length;
    const inner = m[1].trim();
    const name = inner.toLowerCase();
    if (PATTERN_PLACEHOLDERS.includes(name)) {
      parts.push({ placeholder: name });
      continue;
    }
    const edit = inner.match(/^([+-])\s*(?:'([^']*)'|"([^"]*)"|([^'"]*))$/);
    if (!edit) throw new Error(`Unknown ${m[0]}. Use {path}, {query}, {hash}, {-'text'} or {+'text'}.`);
    const value = edit[2] ?? edit[3] ?? edit[4].trim();
    if (!value) throw new Error(`${m[0]} has no text to ${edit[1] === '-' ? 'remove' : 'add'}.`);
    parts.push({ edit: edit[1], value });
  }
  if (at < pattern.length) parts.push({ text: pattern.slice(at) });
  if (parts.some((p) => p.text && /[{}]/.test(p.text))) throw new Error('Unmatched { or } in the pattern.');
  return parts;
}

// The overlay URL a pattern gives for the page at pageUrl, or null.
function resolvePattern(pattern, pageUrl) {
  let page;
  let parts;
  try {
    page = new URL(pageUrl);
    parts = parsePattern(pattern);
  } catch {
    return null;
  }
  const values = { path: page.pathname, query: page.search, hash: page.hash };
  let out = '';
  for (const part of parts) {
    if (part.text !== undefined) {
      out += part.text;
    } else if (part.placeholder) {
      let value = values[part.placeholder];
      // "https://host/{path}" shouldn't give a double slash.
      if (part.placeholder === 'path' && out.endsWith('/')) value = value.replace(/^\/+/, '');
      out += value;
    } else if (part.edit === '-') {
      if (out.endsWith(part.value)) out = out.slice(0, -part.value.length);
    } else if (!out.endsWith(part.value) && !out.endsWith('/')) {
      out += part.value;
    }
  }
  try {
    const url = new URL(out);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// Checks text typed as a pattern. Returns { pattern } (with https:// added
// when the scheme is left out) or { error }, or null when it has no { or }.
function toPattern(value) {
  const text = value.trim();
  if (!/[{}]/.test(text)) return null;
  if (/\s/.test(text.replace(/\{[^{}]*\}/g, ''))) return { error: 'A pattern can\'t contain spaces.' };
  const pattern = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    parsePattern(pattern);
  } catch (e) {
    return { error: e.message };
  }
  if (!isPattern(pattern)) return { error: 'A pattern needs {path}, {query} or {hash}.' };
  const home = patternHome(pattern);
  if (!home || !resolvePattern(pattern, PATTERN_SAMPLE_PAGE)) {
    return { error: 'The pattern needs to start with a site, e.g. example.com{path}.' };
  }
  return { pattern };
}

// The site a pattern points to ("https://host/"), or null.
function patternHome(pattern) {
  const start = pattern.split('{')[0];
  try {
    const url = new URL(start);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}
