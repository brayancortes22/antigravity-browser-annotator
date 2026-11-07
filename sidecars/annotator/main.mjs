import { SidecarApp, Response } from 'sidecar_sdk';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const candidateExe = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe')
  : '';
if (!process.env.ANTIGRAVITY_AGENTAPI_EXE && candidateExe && existsSync(candidateExe)) {
  process.env.ANTIGRAVITY_AGENTAPI_EXE = candidateExe;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Workspace and files. The agent writes <workspace>/.qa/latest.json plus the
// screenshot; the pane reads them and stores comments in .qa/comments.json.
// ---------------------------------------------------------------------------

function toPath(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
  } catch {
    return '';
  }
}

const qaDir = (ws) => join(ws, '.qa');
const sessionFile = (ws) => join(qaDir(ws), 'latest.json');
const commentsFile = (ws) => join(qaDir(ws), 'comments.json');

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function loadSession(ws) {
  const raw = readJson(sessionFile(ws));
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.screenshot || !raw.viewport) return null;
  return raw;
}

function loadComments(ws, session) {
  const doc = readJson(commentsFile(ws), { comments: [] });
  const list = Array.isArray(doc?.comments) ? doc.comments : [];
  if (!session) return { comments: [], stale: false };
  if (doc?.sessionId && doc.sessionId !== session.id) {
    return { comments: [], stale: true };
  }
  return { comments: list, stale: false };
}

function saveComments(ws, session, comments) {
  writeJson(commentsFile(ws), {
    sessionId: session?.id || '',
    url: session?.url || '',
    updatedAt: new Date().toISOString(),
    comments,
  });
}

function insideQa(ws, relPath) {
  const root = resolve(qaDir(ws)).toLowerCase();
  const target = resolve(ws, relPath);
  const lower = target.toLowerCase();
  if (lower !== root && !lower.startsWith(root + sep)) return null;
  return target;
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function cleanText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  return {
    x: Math.max(0, n(rect.x)),
    y: Math.max(0, n(rect.y)),
    width: Math.max(1, n(rect.width)),
    height: Math.max(1, n(rect.height)),
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new SidecarApp();

let appVersion = Date.now();
app.api('/api/version', () => ({ version: appVersion }), 'GET');

app.page('/', () => readFileSync(join(__dirname, 'ui.html'), 'utf-8'));
app.page('/app.js', () => readFileSync(join(__dirname, 'app.js'), 'utf-8'));
app.page('/live-inspector.js', () => readFileSync(join(__dirname, 'live-inspector.js'), 'utf-8'));
app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css',
}), 'GET');

function handleSendLiveAnnotation(data) {
  const conversationId = data?.conversationId || app.config.conversationId || '82241de0-21c8-48b7-9cab-f1cb7e1102ea';
  const sel = data.selector || '(sin selector)';
  const comment = (data.comment || '').trim();
  const url = data.url || '';
  const tagClasses = data.tagClasses || '';
  const rect = data.rect ? (typeof data.rect === 'string' ? data.rect : `${data.rect.width}x${data.rect.height}px en (${data.rect.x}, ${data.rect.y})`) : '';

  const message = [
    '🎯 QA Annotator — Comentario de Inspección Visual:',
    `• URL: ${url}`,
    `• Elemento: \`${tagClasses || sel}\``,
    `• Selector CSS: \`${sel}\``,
    rect ? `• Bounding Box: ${rect}` : '',
    '',
    'Instrucción del usuario:',
    `> "${comment}"`,
    '',
    'Instrucción para el agente: Analiza este componente y aplica la corrección requerida.'
  ].filter(Boolean).join('\n');

  // Also save to workspace .qa/comments.json
  const ws = toPath(data?.workspace) || defaultWs;
  try {
    const cf = commentsFile(ws);
    const existing = readJson(cf, { comments: [] });
    const list = Array.isArray(existing?.comments) ? existing.comments : [];
    list.push({
      id: randomUUID(),
      selector: sel,
      tagClasses,
      comment,
      url,
      rect: data.rect || null,
      createdAt: new Date().toISOString(),
    });
    writeJson(cf, { comments: list, updatedAt: new Date().toISOString() });
  } catch {}

  let sent = false;
  try {
    if (conversationId) {
      app.sendMessage(conversationId, message);
      sent = true;
    }
  } catch (err) {
    console.error('[Annotator] app.sendMessage error, trying direct execution:', err);
    try {
      const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE || candidateExe;
      execFileSync(exe, ['agentapi', 'send-message', conversationId, message], {
        encoding: 'utf-8',
        env: process.env,
      });
      sent = true;
    } catch (directErr) {
      console.error('[Annotator] direct agentapi error:', directErr);
    }
  }
  return { ok: sent, sent };
}

app.api('/api/send-live-annotation', handleSendLiveAnnotation, 'POST');
app.api('/api/send-live-annotation', handleSendLiveAnnotation, 'GET');

let pendingAgentAction = null;
let lastActionResult = null;
let lastProcessedActionId = null;

const defaultWs = process.env.ANTIGRAVITY_WORKSPACE || process.cwd();

function checkFileCommands(wsPath) {
  const ws = wsPath || defaultWs;
  const actionFile = join(ws, '.qa', 'agent_action.json');
  if (existsSync(actionFile)) {
    try {
      const data = JSON.parse(readFileSync(actionFile, 'utf-8'));
      if (data && data.id && data.id !== lastProcessedActionId) {
        lastProcessedActionId = data.id;
        pendingAgentAction = data;
      }
    } catch {}
  }
}

app.api('/api/agent/command', (data) => {
  pendingAgentAction = data;
  lastActionResult = null;
  return { ok: true, queued: true };
}, 'POST');

app.api('/api/agent/poll', (data) => {
  const ws = toPath(data?.workspace) || defaultWs;
  checkFileCommands(ws);
  const cmd = pendingAgentAction;
  pendingAgentAction = null;
  return { ok: true, command: cmd };
}, 'GET');

app.api('/api/agent/report', (data) => {
  lastActionResult = data;
  const ws = toPath(data?.workspace) || defaultWs;
  const resultFile = join(ws, '.qa', 'agent_result.json');
  try {
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
  return { ok: true };
}, 'POST');

app.api('/api/agent/status', () => {
  return { ok: true, result: lastActionResult };
}, 'GET');

app.api('/api/proxy', async (data) => {
  let rawUrl = (data.url || '').trim();
  if (!rawUrl) return new Response('Falta parámetro url', { status: 400 });

  let targetUrl = rawUrl;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(targetUrl) || /^localhost(:\d+)?/i.test(targetUrl) || /^127\.0\.0\.1(:\d+)?/i.test(targetUrl);

  if (!isLocal && !/^https?:\/\//i.test(targetUrl)) {
    if (!targetUrl.includes('.') || targetUrl.includes(' ')) {
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(targetUrl)}`;
    } else {
      targetUrl = `https://${targetUrl}`;
    }
  } else if (isLocal && !/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `http://${targetUrl}`;
  }

  try {
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    };

    let resp = await fetch(targetUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
    });

    // If Google search is challenged with CAPTCHA / 429, seamlessly fallback to Bing
    if (targetUrl.includes('google.com/search') && (!resp.ok || resp.status === 429)) {
      const u = new URL(targetUrl);
      const q = u.searchParams.get('q') || '';
      const fallbackUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      resp = await fetch(fallbackUrl, {
        headers: fetchHeaders,
        redirect: 'follow',
      });
      targetUrl = fallbackUrl;
    }

    const contentType = resp.headers.get('content-type') || 'text/html';
    if (contentType.includes('text/html')) {
      let html = await resp.text();

      // Check if Google returned a sorry/captcha page in body
      if (html.includes('google.com/sorry') && targetUrl.includes('google.com')) {
        const u = new URL(targetUrl);
        const q = u.searchParams.get('q') || '';
        const fallbackUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
        const fallbackResp = await fetch(fallbackUrl, {
          headers: fetchHeaders,
          redirect: 'follow',
        });
        if (fallbackResp.ok) {
          html = await fallbackResp.text();
          targetUrl = fallbackUrl;
        }
      }

      try {
        const u = new URL(targetUrl);
        const basePath = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1) || '/';
        const baseHref = `${u.origin}${basePath}`;
        const baseTag = `<base href="${baseHref}">`;
        const liveInspectorSource = readFileSync(join(__dirname, 'live-inspector.js'), 'utf-8');
        const scriptTag = `<script>\n${liveInspectorSource}\n</script>`;
        const linkLockdown = `<script>
          window.open = function(u) { if (u) window.location.href = u; return null; };
          document.addEventListener('click', function(e) {
            var a = e.target.closest('a');
            if (a && a.href) a.removeAttribute('target');
          }, true);
        </script>`;

        if (html.includes('<head>')) {
          html = html.replace('<head>', `<head>${baseTag}${scriptTag}${linkLockdown}`);
        } else if (html.includes('<html')) {
          html = html.replace(/<html[^>]*>/, `$&<head>${baseTag}${scriptTag}${linkLockdown}</head>`);
        } else {
          html = `${baseTag}${scriptTag}${linkLockdown}${html}`;
        }
      } catch {}

      return new Response(html, {
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const buffer = await resp.arrayBuffer();
    return new Response(buffer, {
      contentType: contentType,
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(`<!doctype html><html><body style="font-family:sans-serif;background:#09090b;color:#f4f4f5;padding:40px;text-align:center;">
      <h2 style="color:#ef4444;">No se pudo conectar a la dirección</h2>
      <p style="color:#a1a1aa;">${targetUrl}</p>
      <pre style="background:#18181b;padding:12px;border-radius:8px;display:inline-block;color:#f87171;">${err?.message || err}</pre>
      <p style="margin-top:20px;font-size:12px;color:#71717a;">Verifica que el servidor de desarrollo esté activo en esa dirección o que tu conexión a internet funcione.</p>
    </body></html>`, {
      contentType: 'text/html; charset=utf-8',
      status: 502,
    });
  }
}, 'GET');

app.api('/api/state', (data) => {
  const ws = toPath(data.workspace);
  if (!ws || !existsSync(ws)) {
    return { ok: false, error: 'workspace no disponible', session: null, comments: [] };
  }
  const session = loadSession(ws);
  const { comments, stale } = loadComments(ws, session);
  return {
    ok: true,
    workspace: ws,
    session,
    comments,
    stale,
    conversationId: app.config.conversationId || '',
  };
}, 'GET');

app.api('/api/shot', (data) => {
  const ws = toPath(data.workspace);
  if (!ws || typeof data.path !== 'string') return new Response('not found', { status: 404 });
  const target = insideQa(ws, data.path);
  if (!target || !existsSync(target)) return new Response('not found', { status: 404 });
  try {
    if (statSync(target).size > 12 * 1024 * 1024) return new Response('too large', { status: 413 });
    return new Response(readFileSync(target), {
      contentType: MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}, 'GET');

app.api('/api/comment', (data) => {
  const ws = toPath(data.workspace);
  const session = ws ? loadSession(ws) : null;
  if (!ws || !session) return { ok: false, error: 'sin sesion de QA' };
  const { comments } = loadComments(ws, session);
  const action = String(data.action || 'add');

  if (action === 'delete') {
    const id = String(data.id || '');
    const next = comments.filter((c) => c.id !== id);
    saveComments(ws, session, next);
    return { ok: true, comments: next };
  }
  if (action === 'clear') {
    saveComments(ws, session, []);
    return { ok: true, comments: [] };
  }

  const text = cleanText(data.text);
  if (!text) return { ok: false, error: 'comentario vacio' };
  const kind = data.kind === 'region' ? 'region' : 'element';
  const comment = {
    id: randomUUID(),
    kind,
    selector: kind === 'element' ? cleanText(data.selector, 400) : '',
    label: cleanText(data.label, 200),
    text,
    rect: cleanRect(data.rect),
    createdAt: new Date().toISOString(),
  };
  const next = [...comments, comment];
  saveComments(ws, session, next);
  return { ok: true, comments: next };
});

app.api('/api/send', (data) => {
  const ws = toPath(data.workspace);
  const session = ws ? loadSession(ws) : null;
  if (!ws || !session) return { ok: false, error: 'sin sesion de QA' };
  const { comments } = loadComments(ws, session);
  const selected = Array.isArray(data.ids) && data.ids.length
    ? comments.filter((c) => data.ids.includes(c.id))
    : comments;
  if (!selected.length) return { ok: false, error: 'no hay comentarios' };

  const conversationId = app.config.conversationId;
  if (!conversationId) return { ok: false, error: 'sin conversacion activa' };

  const lines = selected.map((c, i) => {
    const anchor = c.kind === 'element'
      ? `selector \`${c.selector || '(sin selector)'}\``
      : `region x=${c.rect?.x ?? 0} y=${c.rect?.y ?? 0} w=${c.rect?.width ?? 0} h=${c.rect?.height ?? 0}`;
    const label = c.label ? ` — ${c.label}` : '';
    return `${i + 1}. ${anchor}${label}: "${c.text}"`;
  });

  const message = [
    'QA Annotator — comentarios del usuario',
    `URL: ${session.url || '(sin url)'}`,
    `Viewport: ${session.viewport?.width || '?'}x${session.viewport?.height || '?'}`,
    `Captura: ${session.screenshot} (id ${session.id})`,
    '',
    ...lines,
    '',
    'Instruccion: mapea cada comentario a la seccion real, corrige, vuelve a capturar y responde comentario por comentario con evidencia.',
  ].join('\n');

  try {
    app.sendMessage(conversationId, message);
    return { ok: true, sent: selected.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

app.run();
