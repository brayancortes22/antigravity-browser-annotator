/**
 * Live Inspector Script for Antigravity Browser & QA Annotator
 * Runs inside the webview/iframe to provide OpenCode-like hover inspect & click annotations.
 */
(() => {
  if (window.__antigravityInspectorInitialized) return;
  window.__antigravityInspectorInitialized = true;

  let active = false;
  let hoveredEl = null;
  let selectedEl = null;

  // Shadow DOM host for isolation from host styles
  const host = document.createElement('div');
  host.id = 'antigravity-inspector-host';
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '100vw';
  host.style.height = '100vh';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .highlight-box {
        position: absolute;
        pointer-events: none;
        border: 2px solid #3b82f6;
        background: rgba(59, 130, 246, 0.15);
        border-radius: 4px;
        transition: all 0.05s ease-out;
        display: none;
        box-shadow: 0 0 12px rgba(59, 130, 246, 0.35);
      }
      .highlight-box.selected {
        border-color: #10b981;
        background: rgba(16, 185, 129, 0.2);
        box-shadow: 0 0 16px rgba(16, 185, 129, 0.45);
      }
      .inspect-tooltip {
        position: absolute;
        pointer-events: none;
        background: #18181b;
        color: #f4f4f5;
        border: 1px solid #3f3f46;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 11px;
        line-height: 1.4;
        display: none;
        max-width: 380px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
      }
      .tag-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
      }
      .tag-classes {
        font-weight: 700;
        color: #60a5fa;
        word-break: break-all;
      }
      .tag-dims {
        color: #a1a1aa;
        font-family: monospace;
        font-size: 10px;
        white-space: nowrap;
      }
      .prop-row {
        display: flex;
        justify-content: space-between;
        color: #71717a;
        font-size: 10px;
        margin-top: 2px;
      }
      .prop-val {
        color: #e4e4e7;
        font-family: monospace;
      }
      .a11y-section {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid #27272a;
      }
      .a11y-title {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.05em;
        color: #71717a;
        text-transform: uppercase;
      }

      /* Floating Comment Card (OpenCode style) */
      .comment-card {
        position: absolute;
        pointer-events: auto;
        background: #18181b;
        color: #f4f4f5;
        border: 1px solid #27272a;
        border-radius: 10px;
        padding: 10px 12px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.6);
        width: 320px;
        display: none;
      }
      .comment-selector {
        font-family: monospace;
        font-size: 10.5px;
        color: #a1a1aa;
        background: #09090b;
        padding: 4px 8px;
        border-radius: 6px;
        margin-bottom: 8px;
        word-break: break-all;
        border: 1px solid #27272a;
      }
      .comment-input-wrap {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .comment-input {
        flex: 1;
        background: transparent;
        border: none;
        color: #f4f4f5;
        font-size: 12px;
        outline: none;
        padding: 4px 0;
      }
      .comment-input::placeholder {
        color: #52525b;
      }
      .comment-btn-submit {
        background: #22c55e;
        border: none;
        color: #052e16;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 800;
        transition: transform 0.1s ease;
      }
      .comment-btn-submit:hover {
        background: #16a34a;
        transform: scale(1.05);
      }
      .comment-btn-close {
        background: transparent;
        border: none;
        color: #71717a;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .comment-btn-close:hover {
        color: #e4e4e7;
        background: #27272a;
      }
    </style>

    <div id="highlight" class="highlight-box"></div>
    <div id="tooltip" class="inspect-tooltip"></div>

    <div id="comment-box" class="comment-card">
      <div id="comment-sel" class="comment-selector">#root > ...</div>
      <div class="comment-input-wrap">
        <input id="comment-text" class="comment-input" type="text" placeholder="Add an optional comment..." />
        <button id="comment-submit" class="comment-btn-submit" title="Enviar al agente">✓</button>
        <button id="comment-cancel" class="comment-btn-close" title="Cancelar">✕</button>
      </div>
    </div>
  `;

  const highlight = shadow.getElementById('highlight');
  const tooltip = shadow.getElementById('tooltip');
  const commentBox = shadow.getElementById('comment-box');
  const commentSel = shadow.getElementById('comment-sel');
  const commentText = shadow.getElementById('comment-text');
  const commentSubmit = shadow.getElementById('comment-submit');
  const commentCancel = shadow.getElementById('comment-cancel');

  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return el?.tagName?.toLowerCase() || 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;

    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let tag = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const classes = Array.from(cur.classList).filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (classes.length) {
        tag += '.' + classes.map(c => CSS.escape(c)).join('.');
      } else if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter(s => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          tag += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(tag);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function getTagAndClasses(el) {
    let s = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).slice(0, 4).join('.');
    if (cls) s += '.' + cls;
    return s;
  }

  function updateTooltip(el, rect) {
    const cs = window.getComputedStyle(el);
    const tagClasses = getTagAndClasses(el);
    const w = Math.round(rect.width * 10) / 10;
    const h = Math.round(rect.height * 10) / 10;
    const padding = `${cs.paddingTop} ${cs.paddingRight}`;
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const name = el.getAttribute('aria-label') || el.title || el.alt || (el.innerText || '').trim().slice(0, 30);
    const focusable = el.tabIndex >= 0 || ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);

    tooltip.innerHTML = `
      <div class="tag-row">
        <span class="tag-classes">${tagClasses}</span>
        <span class="tag-dims">${w} × ${h}</span>
      </div>
      <div class="prop-row">
        <span>Padding</span>
        <span class="prop-val">${padding}</span>
      </div>
      <div class="a11y-section">
        <div class="a11y-title">ACCESSIBILITY</div>
        ${name ? `<div class="prop-row"><span>Name</span><span class="prop-val">"${name}"</span></div>` : ''}
        <div class="prop-row"><span>Role</span><span class="prop-val">${role}</span></div>
        <div class="prop-row"><span>Keyboard-focusable</span><span class="prop-val">${focusable ? '✓' : '🚫'}</span></div>
      </div>
    `;

    // Tooltip position
    let top = rect.top - tooltip.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    let left = rect.left;
    if (left + 380 > window.innerWidth) left = Math.max(8, window.innerWidth - 390);

    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.display = 'block';
  }

  function onMouseMove(e) {
    if (!active || selectedEl) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === host || target === document.body || target === document.documentElement) {
      highlight.style.display = 'none';
      tooltip.style.display = 'none';
      hoveredEl = null;
      return;
    }

    hoveredEl = target;
    const r = target.getBoundingClientRect();
    highlight.className = 'highlight-box';
    highlight.style.top = `${r.top}px`;
    highlight.style.left = `${r.left}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
    highlight.style.display = 'block';

    updateTooltip(target, r);
  }

  function onClick(e) {
    if (!active) return;
    
    // Check if click target is part of shadow root (e.g. comment card inputs/buttons)
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(commentBox) || path.includes(commentText) || path.includes(commentSubmit) || path.includes(commentCancel)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // If an element was already selected, clicking another element switches selection
    if (selectedEl) {
      closeComment();
    }

    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === host || target === document.body || target === document.documentElement) return;

    selectedEl = target;
    hoveredEl = target;
    tooltip.style.display = 'none';

    const r = target.getBoundingClientRect();
    highlight.className = 'highlight-box selected';
    highlight.style.top = `${r.top}px`;
    highlight.style.left = `${r.left}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
    highlight.style.display = 'block';

    const sel = getSelector(target);
    commentSel.textContent = sel;
    commentSel.title = sel;
    commentText.value = '';

    // Position comment card
    let cardTop = r.bottom + 8;
    if (cardTop + 100 > window.innerHeight) cardTop = Math.max(8, r.top - 90);
    let cardLeft = Math.max(8, Math.min(r.left, window.innerWidth - 340));

    commentBox.style.top = `${Math.round(cardTop)}px`;
    commentBox.style.left = `${Math.round(cardLeft)}px`;
    commentBox.style.display = 'block';

    setTimeout(() => commentText.focus(), 50);
  }

  function closeComment() {
    selectedEl = null;
    commentBox.style.display = 'none';
    highlight.className = 'highlight-box';
    highlight.style.display = 'none';
  }

  function submitComment() {
    if (!selectedEl) return;
    const comment = (commentText.value || '').trim();
    const sel = getSelector(selectedEl);
    const r = selectedEl.getBoundingClientRect();
    const tagClasses = getTagAndClasses(selectedEl);

    const payload = {
      type: 'antigravity-annotation',
      selector: sel,
      tagClasses,
      tag: selectedEl.tagName.toLowerCase(),
      comment: comment || '(Sin descripción específica, revisar elemento marcado)',
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      url: location.href,
      title: document.title,
    };

    // Send to parent window
    try {
      window.parent.postMessage(payload, '*');
    } catch {}

    closeComment();
  }

  commentSubmit.addEventListener('click', (e) => {
    e.stopPropagation();
    submitComment();
  });

  commentCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    closeComment();
  });

  commentText.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      submitComment();
    } else if (e.key === 'Escape') {
      closeComment();
    }
  });

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('click', onClick, true);

  // Override window.open to keep all popups/links inside the sidecar
  window.open = function(url) {
    if (url) {
      try {
        window.parent.postMessage({ type: 'browser-navigate', url: String(url) }, '*');
      } catch {
        window.location.href = url;
      }
    }
    return null;
  };

  // Link navigation interceptor (keeps navigation inside sidecar proxy)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) {
      a.removeAttribute('target');
    }
    if (active) return; // In inspector mode, click selects element instead of navigating
    if (a && a.href && !a.href.startsWith('javascript:') && !a.href.startsWith('#')) {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.parent.postMessage({ type: 'browser-navigate', url: a.href }, '*');
      } catch {}
    }
  }, true);

  // Form submission interceptor (e.g. search bars inside pages)
  document.addEventListener('submit', (e) => {
    if (active) return;
    const form = e.target;
    if (form && form.action) {
      try {
        const baseHref = document.querySelector('base')?.href;
        const u = new URL(form.action, baseHref || location.href);
        const method = (form.method || 'GET').toUpperCase();
        if (method === 'GET') {
          e.preventDefault();
          const fd = new FormData(form);
          const params = new URLSearchParams(fd);
          const finalUrl = `${u.origin}${u.pathname}?${params.toString()}`;
          window.parent.postMessage({ type: 'browser-navigate', url: finalUrl }, '*');
        }
      } catch {}
    }
  }, true);

  // Listen for messages from parent sidecar container (inspector mode & agent remote actions)
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'set-inspect-mode') {
      active = Boolean(e.data.enabled);
      try {
        document.documentElement.style.cursor = active ? 'crosshair' : '';
      } catch {}
      if (!active) {
        closeComment();
        highlight.style.display = 'none';
        tooltip.style.display = 'none';
      }
      return;
    }

    // Agent Hands: Remote control from Antigravity Agent
    if (e.data.type === 'agent-action') {
      const { action, selector, value } = e.data;

      if (action === 'click') {
        const el = selector ? document.querySelector(selector) : null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const prevOutline = el.style.outline;
          el.style.outline = '3px solid #f43f5e';
          setTimeout(() => { el.style.outline = prevOutline; }, 900);
          el.click();
          window.parent.postMessage({ type: 'agent-result', ok: true, action: 'click', selector }, '*');
        } else {
          window.parent.postMessage({ type: 'agent-result', ok: false, error: `Elemento ${selector} no encontrado para click` }, '*');
        }
      } else if (action === 'fill') {
        const el = selector ? document.querySelector(selector) : null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const prevOutline = el.style.outline;
          el.style.outline = '3px solid #3b82f6';
          el.value = value || '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(() => { el.style.outline = prevOutline; }, 900);
          window.parent.postMessage({ type: 'agent-result', ok: true, action: 'fill', selector, value }, '*');
        } else {
          window.parent.postMessage({ type: 'agent-result', ok: false, error: `Campo ${selector} no encontrado para escribir` }, '*');
        }
      } else if (action === 'snapshot') {
        const nodes = Array.from(document.querySelectorAll('button, input, select, textarea, a[href], h1, h2, h3, [role="button"]')).slice(0, 100);
        const elements = nodes.map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || undefined,
          id: el.id || undefined,
          name: el.name || undefined,
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 70),
          selector: getSelector(el)
        })).filter(item => item.text || ['input', 'select', 'textarea'].includes(item.tag));

        window.parent.postMessage({
          type: 'agent-result',
          ok: true,
          action: 'snapshot',
          title: document.title,
          url: location.href,
          elements
        }, '*');
      }
    }
  });

  // Notify parent that inspector is ready
  try {
    window.parent.postMessage({ type: 'inspector-ready', url: location.href }, '*');
  } catch {}
})();
