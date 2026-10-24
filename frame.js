// Runs in every frame. Stays idle unless content.js links this frame with its
// counterpart (original iframe or page <-> overlay). When linked, switching
// views keeps the same content in place: the page being left sends what's on
// it (anchors) and the spot to keep (the sync point) to the page being shown,
// which pairs the anchors up with its own and scrolls to match before it's shown.
(() => {
  const isTop = window.top === window;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD']);
  const MEDIA_TAGS = new Set(['img', 'svg', 'video', 'iframe']);
  const MAX_ANCHORS = 6000;
  const MAX_KEY = 80;
  // A point this close to some text or image moves with it.
  const NEAR = 150;
  const ACCENT = '#8b5cf6';

  let linked = false;
  let pin = null; // the sync point, in page coordinates
  let pinEl = null;
  // Where the page was when it was last shown by a switch: if it's still
  // there, switching back returns the other page exactly where it was.
  let arrived = null;

  // --- Anchors: text runs and images, in document order ---

  // Text compared across the two pages: case, accents, punctuation and
  // spacing often differ between the two versions of a page, so ignore them.
  const keyOf = (text) => text.toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, MAX_KEY);

  function fileStem(url) {
    try {
      const name = new URL(url, location.href).pathname.split('/').filter(Boolean).pop() || '';
      return name.replace(/\.[a-z\d]+$/i, '');
    } catch {
      return '';
    }
  }

  function mediaKey(el) {
    const tag = el.localName;
    let text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (tag === 'img') text = el.getAttribute('alt') || text || fileStem(el.currentSrc || el.src);
    else if (tag === 'svg') {
      text ||= el.querySelector('title')?.textContent
        || (el.querySelector('use')?.getAttribute('href') || el.querySelector('use')?.getAttribute('xlink:href') || '').split('#').pop();
    } else if (tag === 'video') text ||= fileStem(el.currentSrc || el.poster || '');
    const key = keyOf(text || '');
    return key ? `${tag === 'svg' ? 'img' : tag}: ${key}` : '';
  }

  function rectOf(node) {
    if (node.nodeType === Node.ELEMENT_NODE) return node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  }

  // Keys, nodes and boxes (x, y, width, height in viewport px) of what is
  // shown on the page. Content that stays put while scrolling (fixed or
  // sticky headers) says nothing about where the page is scrolled to.
  function collectAnchors() {
    const keys = [];
    const nodes = [];
    const rects = [];
    const add = (node, key) => {
      const r = rectOf(node);
      if (r.width <= 0 || r.height <= 0) return;
      keys.push(key);
      nodes.push(node);
      rects.push(r.left, r.top, r.width, r.height);
    };
    const visit = (el, visible) => {
      for (let n = el.firstChild; n && keys.length < MAX_ANCHORS; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (!visible) continue;
          const key = keyOf(n.nodeValue);
          if (key.length >= 2) add(n, key);
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(n.tagName) || n === pinEl) continue;
          const style = getComputedStyle(n);
          if (style.display === 'none' || style.position === 'fixed' || style.position === 'sticky') continue;
          const shown = style.visibility === 'visible';
          if (MEDIA_TAGS.has(n.localName)) {
            const key = shown && mediaKey(n);
            if (key) add(n, key);
          } else {
            visit(n, shown);
          }
        }
      }
    };
    if (document.body) visit(document.body, true);
    return { keys, nodes, rects };
  }

  // --- Pairing the anchors of the two pages ---

  // Longest run of pairs [i, j] (sorted by i) whose j also increase.
  function increasingRun(pairs) {
    const tails = [];
    const prev = new Int32Array(pairs.length);
    for (let k = 0; k < pairs.length; k++) {
      const j = pairs[k][1];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tails[mid]][1] < j) lo = mid + 1;
        else hi = mid;
      }
      prev[k] = lo ? tails[lo - 1] : -1;
      tails[lo] = k;
    }
    const run = [];
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) run.push(pairs[k]);
    return run.reverse();
  }

  // Longest common subsequence of two short ranges.
  function commonSubsequence(a, b, a0, a1, b0, b1, match) {
    const n = a1 - a0;
    const m = b1 - b0;
    const t = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * (m + 1) + j] = a[a0 + i] === b[b0 + j]
          ? t[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[a0 + i] === b[b0 + j]) { match[a0 + i] = b0 + j; i++; j++; }
      else if (t[(i + 1) * (m + 1) + j] >= t[i * (m + 1) + j + 1]) i++;
      else j++;
    }
  }

  // For each key in a, the index of the same content in b (or -1), keeping
  // the order of both pages. Like a patience diff: content found exactly once
  // on both sides pairs up first, then the stretches between are aligned the
  // same way, so repeated texts ("Learn more") pair up within their section.
  function align(a, b) {
    const match = new Int32Array(a.length).fill(-1);
    const todo = [[0, a.length, 0, b.length]];
    while (todo.length) {
      let [a0, a1, b0, b1] = todo.pop();
      while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) match[a0++] = b0++;
      while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) match[--a1] = --b1;
      if (a0 >= a1 || b0 >= b1) continue;

      const seen = new Map(); // key -> [count in a, index in a, count in b, index in b]
      for (let i = a0; i < a1; i++) {
        const s = seen.get(a[i]);
        if (s) s[0]++;
        else seen.set(a[i], [1, i, 0, -1]);
      }
      for (let j = b0; j < b1; j++) {
        const s = seen.get(b[j]);
        if (s) { s[2]++; s[3] = j; }
      }
      const pairs = [];
      for (const s of seen.values()) if (s[0] === 1 && s[2] === 1) pairs.push([s[1], s[3]]);
      if (!pairs.length) {
        if ((a1 - a0) * (b1 - b0) <= 40000) commonSubsequence(a, b, a0, a1, b0, b1, match);
        continue;
      }
      pairs.sort((p, q) => p[0] - q[0]);
      let pa = a0;
      let pb = b0;
      for (const [i, j] of increasingRun(pairs)) {
        match[i] = j;
        todo.push([pa, i, pb, j]);
        pa = i + 1;
        pb = j + 1;
      }
      todo.push([pa, a1, pb, b1]);
    }
    return match;
  }

  // Where a point of the other page (viewport px) is on this one: at the same
  // place within the text or image under it; else moved as the nearest text
  // or image moved. Returns { x, y, node } or null when nothing pairs up.
  function mapPoint(x, y, other, match, here) {
    const R = other.rects;
    const nearest = (max) => {
      let best = -1;
      let bestD = Infinity;
      let bestArea = Infinity;
      for (let i = 0; i < match.length; i++) {
        if (match[i] < 0) continue;
        const bx = R[i * 4]; const by = R[i * 4 + 1]; const bw = R[i * 4 + 2]; const bh = R[i * 4 + 3];
        const d = Math.hypot(Math.max(bx - x, 0, x - bx - bw), Math.max(by - y, 0, y - by - bh));
        if (d > max) continue;
        const area = bw * bh;
        if (d < bestD || (d === bestD && area < bestArea)) { best = i; bestD = d; bestArea = area; }
      }
      return best < 0 ? null : { i: best, inside: bestD === 0 };
    };
    const hit = nearest(NEAR) || nearest(Infinity);
    if (!hit) return null;
    const { i, inside } = hit;
    const j = match[i];
    const fx = R[i * 4]; const fy = R[i * 4 + 1]; const fw = R[i * 4 + 2]; const fh = R[i * 4 + 3];
    const tx = here.rects[j * 4]; const ty = here.rects[j * 4 + 1]; const tw = here.rects[j * 4 + 2]; const th = here.rects[j * 4 + 3];
    const node = here.nodes[j];
    if (inside) return { x: tx + (x - fx) * (tw / fw), y: ty + (y - fy) * (th / fh), node };
    return { x: x + tx - fx, y: y + ty - fy, node };
  }

  // --- Scrolling ---

  function scrollParent(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) {
        return p;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  // Scroll every container the node is in (inner panels first, then the
  // page) until its top is at the given viewport offset.
  function moveNodeTo(node, top) {
    const root = document.scrollingElement || document.documentElement;
    let container = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (container && container !== root) {
      const delta = rectOf(node).top - top;
      if (Math.abs(delta) < 1) break;
      container = scrollParent(container);
      container.scrollBy({ top: delta, behavior: 'instant' });
    }
  }

  const viewport = () => ({
    width: document.documentElement.clientWidth || innerWidth,
    height: document.documentElement.clientHeight || innerHeight,
  });

  // --- The sync point ---

  function drawPin() {
    if (!pin || !linked) {
      pinEl?.remove();
      return;
    }
    if (!pinEl) {
      pinEl = document.createElement('div');
      pinEl.setAttribute('aria-hidden', 'true');
    }
    pinEl.style.cssText =
      'position:absolute!important;z-index:2147483646!important;pointer-events:none!important;' +
      'width:12px!important;height:12px!important;margin:-6px 0 0 -6px!important;padding:0!important;' +
      `border-radius:50%!important;background:${ACCENT}!important;border:2px solid #fff!important;` +
      'box-shadow:0 0 0 1px rgba(0,0,0,.35),0 1px 4px rgba(0,0,0,.3)!important;box-sizing:border-box!important;' +
      `left:${pin.x}px!important;top:${pin.y}px!important;`;
    if (pinEl.parentNode !== document.documentElement) document.documentElement.appendChild(pinEl);
  }

  function setPin(value) {
    pin = value;
    drawPin();
  }

  const samePin = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y);

  function remember() {
    arrived = { x: scrollX, y: scrollY, pin: pin && { ...pin } };
  }

  // The page being left: what's on it, and the spot to keep in place (the
  // sync point if it's in view, else the middle of the view).
  function syncOut(force) {
    if (!force && arrived && arrived.x === scrollX && arrived.y === scrollY && samePin(arrived.pin, pin)) {
      return { skip: true };
    }
    const { width, height } = viewport();
    const pinView = pin && { x: pin.x - scrollX, y: pin.y - scrollY };
    const pinInView = !!pinView && pinView.x >= 0 && pinView.x <= width && pinView.y >= 0 && pinView.y <= height;
    const { keys, rects } = collectAnchors();
    return {
      keys,
      rects,
      point: pinInView ? pinView : { x: width / 2, y: height / 2 },
      pin: pinView,
      pinInView,
    };
  }

  // The page being shown: put the same content under the same spot.
  function syncIn(msg) {
    if (msg.skip || !Array.isArray(msg.keys)) {
      remember();
      return { ok: true, skipped: true };
    }
    const here = collectAnchors();
    const match = align(msg.keys, here.keys);
    const q = mapPoint(msg.point.x, msg.point.y, msg, match, here);
    let newPin = null;
    if (msg.pin && q) {
      const p = msg.pinInView ? q : mapPoint(msg.pin.x, msg.pin.y, msg, match, here);
      if (p) newPin = { x: p.x + scrollX, y: p.y + scrollY };
    }
    if (q) moveNodeTo(q.node, rectOf(q.node).top + msg.point.y - q.y);
    setPin(newPin);
    remember();
    let paired = 0;
    for (const j of match) if (j >= 0) paired++;
    return { ok: true, paired };
  }

  // Click a spot to keep it in place when switching; click it again to remove it.
  window.addEventListener('click', (e) => {
    if (!linked || !e.isTrusted || e.button !== 0 || getSelection()?.toString()) return;
    const x = e.clientX + scrollX;
    const y = e.clientY + scrollY;
    setPin(pin && Math.hypot(pin.x - x, pin.y - y) < 12 ? null : { x, y });
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
    if (isTop || !linked) return;
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
        linked = true;
        drawPin();
        break;
      case 'UNLINK':
        linked = false;
        arrived = null;
        setPin(null);
        break;
      case 'SYNC_OUT':
        sendResponse(linked ? syncOut(msg.force) : { skip: true });
        break;
      case 'SYNC_IN':
        sendResponse(linked ? syncIn(msg) : { ok: false });
        break;
    }
  });
})();
