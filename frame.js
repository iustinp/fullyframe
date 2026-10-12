// Runs in every frame. Stays idle unless content.js links this frame with its
// counterpart (original iframe or page <-> overlay). When linked, Alt+click on
// text scrolls the same text in the other frame to the same height.
(() => {
  const isTop = window.top === window;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
  const MAX_TEXT = 200;
  const ACCENT = '#8b5cf6';

  let peer = null;

  const normalize = (s) => s.replace(/\s+/g, ' ').trim();

  function nodeRect(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  }

  function isCandidate(node) {
    const parent = node.parentElement;
    return !!parent && !SKIP_TAGS.has(parent.tagName) && normalize(node.nodeValue).length >= 2;
  }

  function isVisible(node) {
    const r = nodeRect(node);
    return r.width > 0 || r.height > 0;
  }

  function* textNodes(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (isCandidate(n)) yield n;
    }
  }

  const CONTEXT_WORDS = 30;
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const words = (s) => s.toLowerCase().split(' ').filter(Boolean);

  // Visible text in document order, with the nearest heading and character offset
  // of each node, so matches can be compared by their surroundings.
  function pageText() {
    const items = [];
    let offset = 0;
    let heading = '';
    for (const node of textNodes(document.body)) {
      if (!isVisible(node)) continue;
      const text = normalize(node.nodeValue);
      const h = node.parentElement.closest(HEADING_SELECTOR);
      if (h) heading = normalize(h.textContent).toLowerCase().slice(0, MAX_TEXT);
      items.push({ node, text, heading, offset });
      offset += text.length + 1;
    }
    return { items, length: Math.max(offset, 1) };
  }

  function contextAt(page, i) {
    let before = [];
    for (let j = i - 1; j >= 0 && before.length < CONTEXT_WORDS; j--) {
      before = words(page.items[j].text).concat(before);
    }
    let after = [];
    for (let j = i + 1; j < page.items.length && after.length < CONTEXT_WORDS; j++) {
      after = after.concat(words(page.items[j].text));
    }
    return {
      before: before.slice(-CONTEXT_WORDS),
      after: after.slice(0, CONTEXT_WORDS),
      heading: page.items[i].heading,
      pos: page.items[i].offset / page.length,
    };
  }

  // Indexes of text nodes matching the anchor, from strictest to loosest match.
  function findCandidates(page, text, truncated) {
    const exact = [];
    const partial = [];
    const loose = [];
    const lower = text.toLowerCase();
    page.items.forEach(({ text: t }, i) => {
      if (!truncated && t === text) exact.push(i);
      else if (t.includes(text)) partial.push(i);
      else if (t.toLowerCase().includes(lower)) loose.push(i);
    });
    return exact.length ? exact : partial.length ? partial : loose;
  }

  const commonRun = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };

  function sharedWords(a, b) {
    const counts = new Map();
    for (const w of a) counts.set(w, (counts.get(w) || 0) + 1);
    let n = 0;
    for (const w of b) {
      const c = counts.get(w);
      if (c) { n++; counts.set(w, c - 1); }
    }
    return n;
  }

  // Higher is better: identical neighbouring words weigh most, then shared words
  // nearby, then the same section heading; page position and occurrence order
  // only break ties when the surroundings say little.
  function similarity(anchor, ctx, occurrence) {
    return 2 * commonRun([...anchor.before].reverse(), [...ctx.before].reverse()) +
      2 * commonRun(anchor.after, ctx.after) +
      sharedWords(anchor.before, ctx.before) +
      sharedWords(anchor.after, ctx.after) +
      (anchor.heading && anchor.heading === ctx.heading ? 10 : 0) -
      20 * Math.abs(anchor.pos - ctx.pos) +
      (occurrence === anchor.index ? 0.5 : 0);
  }

  function bestMatch(anchor) {
    const page = pageText();
    let best = null;
    let bestScore = -Infinity;
    findCandidates(page, anchor.text, anchor.truncated).forEach((i, occurrence) => {
      const score = similarity(anchor, contextAt(page, i), occurrence);
      if (score > bestScore) { bestScore = score; best = page.items[i].node; }
    });
    return best;
  }

  function textNodeAt(e) {
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = caret?.startContainer;
    if (node?.nodeType === Node.TEXT_NODE && isCandidate(node) && e.target.contains(node)) {
      return node;
    }
    // Clicked on padding, an image, etc.: use the nearest text inside or around it.
    for (let el = e.target; el && el !== document.body; el = el.parentElement) {
      for (const n of textNodes(el)) {
        if (isVisible(n)) return n;
      }
    }
    return null;
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight) {
        return p;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  // Scroll every relevant container (inner panels first, then the page) until
  // the node sits at the requested viewport offset.
  function scrollNodeTo(node, top) {
    const el = node.parentElement;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const root = document.scrollingElement || document.documentElement;
    let container = el;
    while (container !== root) {
      const delta = nodeRect(node).top - top;
      if (Math.abs(delta) < 1) break;
      container = scrollParent(container);
      container.scrollBy({ top: delta, behavior: 'instant' });
    }
  }

  function flash(node) {
    const r = nodeRect(node);
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border-radius:3px;' +
      `outline:2px solid ${ACCENT};background:rgba(139,92,246,.15);transition:opacity .6s;` +
      `top:${r.top - 3}px;left:${r.left - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;`;
    document.documentElement.appendChild(box);
    setTimeout(() => { box.style.opacity = '0'; }, 900);
    setTimeout(() => box.remove(), 1600);
  }

  function toast(message) {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);' +
      'padding:8px 14px;border-radius:6px;background:#111;color:#fff;pointer-events:none;' +
      'font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  window.addEventListener('click', (e) => {
    if (peer === null || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    // Alt+click would otherwise download links / trigger page handlers.
    e.preventDefault();
    e.stopImmediatePropagation();

    const node = textNodeAt(e);
    if (!node) {
      toast('FullyFrame: no text here to sync on');
      return;
    }
    const full = normalize(node.nodeValue);
    const text = full.slice(0, MAX_TEXT);
    const truncated = full.length > MAX_TEXT;
    const page = pageText();
    const i = page.items.findIndex((item) => item.node === node);
    const context = i >= 0
      ? contextAt(page, i)
      : { before: [], after: [], heading: '', pos: 0.5 };
    const index = Math.max(0, findCandidates(page, text, truncated).indexOf(i));
    flash(node);
    chrome.runtime.sendMessage({
      type: 'FRAME_ANCHOR', peer, text, truncated, index, ...context, top: nodeRect(node).top,
    })
      .then((res) => {
        if (!res?.found) toast('FullyFrame: text not found on the other page');
      })
      .catch(() => toast('FullyFrame: other page is not reachable'));
  }, true);

  // Handshake with the top-frame script so it can learn our frameId.
  window.addEventListener('message', (e) => {
    if (isTop || e.source !== window.parent || e.data?.fullyframe !== 'identify') return;
    e.stopImmediatePropagation();
    const { token } = e.data;
    chrome.runtime.sendMessage({ type: 'WHOAMI' })
      .then((res) => {
        e.source.postMessage({ fullyframe: 'identity', token, frameId: res?.frameId }, '*');
      })
      .catch(() => {});
  });

  // In the top frame content.js handles these keys itself.
  window.addEventListener('keydown', (e) => {
    if (isTop || peer === null) return;
    if (e.key === 'Escape') {
      chrome.runtime.sendMessage({ type: 'FRAME_ESCAPE' }).catch(() => {});
    } else if (e.code === 'Space' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Alt+Space (Option+Space on Mac) flips between the two pages.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) chrome.runtime.sendMessage({ type: 'FRAME_SWITCH' }).catch(() => {});
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'LINK':
        peer = msg.peer;
        break;
      case 'UNLINK':
        peer = null;
        break;
      case 'SCROLL_TO_ANCHOR': {
        const node = bestMatch(msg);
        if (node) {
          scrollNodeTo(node, msg.top);
          flash(node);
        }
        sendResponse({ found: !!node });
        break;
      }
    }
  });
})();
