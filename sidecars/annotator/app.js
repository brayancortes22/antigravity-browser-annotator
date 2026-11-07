const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const bridge = window.sidecar || {
  conversationId: '',
  fetch: (url, options) => fetch(url, options),
  agent: {
    sendMessage: async () => { console.warn('Sidecar agent bridge no disponible'); },
  },
};

const state = {
  currentUrl: '',
  history: [],
  historyIndex: -1,
  inspectMode: false,
  zoom: '0.8',
};

// UI Elements
const omnibox = $('#omnibox-input');
const btnGo = $('#btn-go');
const btnBack = $('#btn-back');
const btnForward = $('#btn-forward');
const btnReload = $('#btn-reload');
const btnHome = $('#btn-home');
const btnInspect = $('#btn-inspect');
const inspectIndicator = $('#inspect-status-indicator');
const selectZoom = $('#select-zoom');
const frameContainer = $('#frame-container');
const webFrame = $('#web-frame');
const startPage = $('#start-page');
const btnOpenExternal = $('#btn-open-external');
const toast = $('#annotation-toast');
const toastTitle = $('#toast-title');
const toastDesc = $('#toast-desc');

async function api(path, body) {
  const options = body
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
    : { method: 'GET' };
  const res = await bridge.fetch(path, options);
  return res.json();
}

function showToast(title, desc) {
  toastTitle.textContent = title;
  toastDesc.textContent = desc;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

function normalizeTargetUrl(input) {
  let val = (input || '').trim();
  if (!val) return 'about:blank';

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(val) ||
                  /^localhost(:\d+)?/i.test(val) ||
                  /^127\.0\.0\.1(:\d+)?/i.test(val);

  if (!isLocal && !/^https?:\/\//i.test(val)) {
    if (!val.includes('.') || val.includes(' ')) {
      // Search query in web
      return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(val)}`;
    }
    return `https://${val}`;
  } else if (isLocal && !/^https?:\/\//i.test(val)) {
    return `http://${val}`;
  }
  return val;
}

function navigateTo(target, pushHistory = true) {
  const finalUrl = normalizeTargetUrl(target);
  state.currentUrl = finalUrl;
  omnibox.value = finalUrl;

  if (finalUrl === 'about:blank') {
    startPage.classList.remove('hidden');
    webFrame.src = 'about:blank';
    return;
  }

  startPage.classList.add('hidden');

  // Load through sidecar proxy to bypass X-Frame-Options and inject live inspector
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(finalUrl)}`;
  webFrame.src = proxyUrl;

  if (pushHistory) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(finalUrl);
    state.historyIndex = state.history.length - 1;
  }

  updateNavControls();
}

function updateNavControls() {
  btnBack.disabled = state.historyIndex <= 0;
  btnForward.disabled = state.historyIndex >= state.history.length - 1;
  btnBack.style.opacity = btnBack.disabled ? '0.35' : '1';
  btnForward.style.opacity = btnForward.disabled ? '0.35' : '1';
}

function toggleInspectMode(forceState) {
  state.inspectMode = typeof forceState === 'boolean' ? forceState : !state.inspectMode;

  if (state.inspectMode) {
    btnInspect.classList.add('active');
    inspectIndicator.textContent = 'Inspector: ACTIVO';
    inspectIndicator.classList.add('active');
  } else {
    btnInspect.classList.remove('active');
    inspectIndicator.textContent = 'Inspector: OFF';
    inspectIndicator.classList.remove('active');
  }

  // Notify frame
  sendInspectStateToFrame();
}

function sendInspectStateToFrame() {
  try {
    if (webFrame.contentWindow) {
      webFrame.contentWindow.postMessage(
        { type: 'set-inspect-mode', enabled: state.inspectMode },
        '*'
      );
    }
  } catch {}
}

function setZoom(zoomVal) {
  state.zoom = zoomVal;
  frameContainer.className = 'frame-container';
  if (zoomVal === '0.75') frameContainer.classList.add('zoom-75');
  else if (zoomVal === '0.8') frameContainer.classList.add('zoom-80');
  else if (zoomVal === '0.9') frameContainer.classList.add('zoom-90');
  else if (zoomVal === '1') frameContainer.classList.add('zoom-100');
  else if (zoomVal === '1.1') frameContainer.classList.add('zoom-110');
}

// ---------------- Event Listeners ---------------- //

omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    navigateTo(omnibox.value);
  }
});

btnGo.addEventListener('click', () => {
  navigateTo(omnibox.value);
});

btnReload.addEventListener('click', () => {
  if (state.currentUrl) {
    webFrame.src = `/api/proxy?url=${encodeURIComponent(state.currentUrl)}&_t=${Date.now()}`;
  }
});

btnHome.addEventListener('click', () => {
  navigateTo('about:blank');
});

btnBack.addEventListener('click', () => {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    navigateTo(state.history[state.historyIndex], false);
  }
});

btnForward.addEventListener('click', () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    navigateTo(state.history[state.historyIndex], false);
  }
});

btnInspect.addEventListener('click', () => {
  toggleInspectMode();
});

selectZoom.addEventListener('change', (e) => {
  setZoom(e.target.value);
});

btnOpenExternal.addEventListener('click', () => {
  if (state.currentUrl && state.currentUrl !== 'about:blank') {
    window.open(state.currentUrl, '_blank');
  }
});

// Quick shortcut pills and cards
$$('.pill-btn, .q-card').forEach((el) => {
  el.addEventListener('click', () => {
    const url = el.getAttribute('data-url');
    if (url) navigateTo(url);
  });
});

// When frame finishes loading, sync inspect mode state
webFrame.addEventListener('load', () => {
  setTimeout(() => {
    sendInspectStateToFrame();
  }, 250);
});

// Listen for messages from live-inspector.js inside the iframe
window.addEventListener('message', async (e) => {
  if (!e.data || typeof e.data !== 'object') return;

  if (e.data.type === 'inspector-ready') {
    sendInspectStateToFrame();
    return;
  }

  if (e.data.type === 'agent-result') {
    try {
      await api('/api/agent/report', e.data);
    } catch {}
    if (e.data.action === 'click') {
      showToast('🤖 Agente: Click ejecutado', e.data.selector || '');
    } else if (e.data.action === 'fill') {
      showToast('🤖 Agente: Campo completado', `${e.data.selector} = "${e.data.value}"`);
    }
    return;
  }

  if (e.data.type === 'antigravity-annotation') {
    const data = e.data;
    console.log('[Antigravity Browser] Nueva anotación recibida:', data);

    showToast('✓ Comentario enviado al agente', `${data.tagClasses || data.selector}`);

    // Copy to clipboard for easy manual reference if wanted
    try {
      const clipText = `[Elemento: ${data.selector}] ${data.comment}`;
      navigator.clipboard.writeText(clipText);
    } catch {}

    // Send to agent through sidecar endpoint
    try {
      await api('/api/send-live-annotation', {
        selector: data.selector,
        tagClasses: data.tagClasses,
        comment: data.comment,
        url: state.currentUrl || data.url,
        rect: data.rect,
      });
    } catch (err) {
      console.error('Error enviando anotación al agente:', err);
    }
  }
});

// Initialize zoom default (80%)
setZoom('0.8');
updateNavControls();

let lastActionId = null;

async function checkAgentFileCommands() {
  try {
    const ws = state.ws || '';
    const res = await bridge.fetch(`/api/shot?workspace=${encodeURIComponent(ws)}&path=.qa/agent_action.json&_t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.id && data.id !== lastActionId) {
        lastActionId = data.id;
        console.log('[Antigravity Browser] Nuevo comando del agente recibido:', data);
        if (data.action === 'navigate' && data.url) {
          showToast('🤖 Agente', `Navegando a: ${data.url}`);
          navigateTo(data.url);
        } else if (['click', 'fill', 'snapshot'].includes(data.action)) {
          webFrame.contentWindow?.postMessage({ type: 'agent-action', ...data }, '*');
        }
      }
    }
  } catch {}
}

// Agent Poller: Allows the Antigravity Agent to drive this browser in real-time
setInterval(async () => {
  await checkAgentFileCommands();
  try {
    const res = await api('/api/agent/poll');
    if (res && res.ok && res.command) {
      const cmd = res.command;
      console.log('[Antigravity Browser] Comando del agente recibido:', cmd);
      if (cmd.action === 'navigate' && cmd.url) {
        showToast('🤖 Agente', `Navegando a: ${cmd.url}`);
        navigateTo(cmd.url);
        await api('/api/agent/report', { ok: true, action: 'navigate', url: cmd.url, id: cmd.id });
      } else if (['click', 'fill', 'snapshot'].includes(cmd.action)) {
        webFrame.contentWindow?.postMessage({ type: 'agent-action', ...cmd }, '*');
      }
    }
  } catch {}
}, 500);
