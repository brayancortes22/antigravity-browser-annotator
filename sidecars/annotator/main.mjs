import { SidecarApp, Response } from 'sidecar_sdk';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { BrowserManager } from './browser-manager.mjs';
import { CdpClient } from './cdp-client.mjs';

const browserManager = new BrowserManager({ port: 9444 });
const cdpClient = new CdpClient(9444);

process.on('exit', () => browserManager.stop());
process.on('SIGINT', () => { browserManager.stop(); process.exit(); });
process.on('SIGTERM', () => { browserManager.stop(); process.exit(); });


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
app.page('/youtube', () => readFileSync(join(__dirname, 'youtube.html'), 'utf-8'));
app.page('/cdp-stream-view.js', () => readFileSync(join(__dirname, 'cdp-stream-view.js'), 'utf-8'));

async function ensureCdpReady() {
  if (!browserManager.isRunning) {
    await browserManager.start();
  }
  if (!cdpClient.isConnected) {
    await cdpClient.connect();
  }
  return true;
}

app.api('/api/cdp/status', async () => {
  return {
    ok: true,
    running: browserManager.isRunning,
    connected: cdpClient.isConnected,
    url: cdpClient.currentUrl,
    title: cdpClient.pageTitle,
  };
}, 'GET');

app.api('/api/cdp/start', async (data) => {
  try {
    await ensureCdpReady();
    if (data?.url) {
      await cdpClient.navigate(data.url);
    }
    return { ok: true, url: cdpClient.currentUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'POST');
app.api('/api/cdp/start', async (data) => {
  try {
    await ensureCdpReady();
    if (data?.url) {
      await cdpClient.navigate(data.url);
    }
    return { ok: true, url: cdpClient.currentUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'GET');

app.api('/api/cdp/frame', async (data) => {
  const afterSequence = Math.max(0, Number(data?.since) || 0);
  const frame = await cdpClient.waitForFrame(afterSequence, 1000);
  if (!frame || frame.sequence <= afterSequence) {
    if (!cdpClient.isConnected) {
      ensureCdpReady().catch(() => {});
    }
    return new Response('', { status: 204 });
  }
  if (data?.format === 'json') {
    return { ok: true, data: frame.data, metadata: frame.metadata, timestamp: frame.timestamp };
  }
  return new Response(Buffer.from(frame.data, 'base64'), {
    contentType: 'image/jpeg',
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'X-Frame-Sequence': String(frame.sequence),
    },
  });
}, 'GET');

async function setCdpViewport(data) {
  try {
    await ensureCdpReady();
    const width = Number(data?.width);
    const height = Number(data?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { ok: false, error: 'El viewport requiere ancho y alto válidos.' };
    }
    await cdpClient.setViewport(width, height);
    return { ok: true, width: Math.round(width), height: Math.round(height) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
app.api('/api/cdp/viewport', setCdpViewport, 'POST');
app.api('/api/cdp/viewport', setCdpViewport, 'GET');

app.api('/api/cdp/navigate', async (data) => {
  try {
    await ensureCdpReady();
    const url = data?.url;
    if (!url) return { ok: false, error: 'Falta parámetro url' };
    await cdpClient.navigate(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'POST');
app.api('/api/cdp/navigate', async (data) => {
  try {
    await ensureCdpReady();
    const url = data?.url;
    if (!url) return { ok: false, error: 'Falta parámetro url' };
    await cdpClient.navigate(url);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'GET');

app.api('/api/cdp/reload', async () => {
  try {
    if (cdpClient.isConnected) {
      await cdpClient.reload();
      return { ok: true };
    }
    return { ok: false, error: 'CDP no conectado' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'POST');
app.api('/api/cdp/reload', async () => {
  try {
    if (cdpClient.isConnected) {
      await cdpClient.reload();
      return { ok: true };
    }
    return { ok: false, error: 'CDP no conectado' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'GET');

async function handleCdpInput(data) {
  try {
    if (!cdpClient.isConnected) return { ok: false, error: 'CDP no conectado' };
    if (data.kind === 'mouse') {
      await cdpClient.dispatchMouseEvent({
        type: data.type,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        button: data.button || 'left',
        clickCount: Number(data.clickCount) || (data.type === 'mousePressed' ? 1 : 0),
        deltaX: Number(data.deltaX) || 0,
        deltaY: Number(data.deltaY) || 0,
        modifiers: Number(data.modifiers) || 0,
      });
      return { ok: true };
    } else if (data.kind === 'text') {
      await cdpClient.send('Input.insertText', { text: String(data.text || '') });
      return { ok: true };
    } else if (data.kind === 'key') {
      await cdpClient.dispatchKeyEvent({
        type: data.type,
        text: data.text,
        unmodifiedText: data.unmodifiedText,
        key: data.key,
        code: data.code,
        windowsVirtualKeyCode: Number(data.windowsVirtualKeyCode) || 0,
        modifiers: Number(data.modifiers) || 0,
      });
      return { ok: true };
    }
    return { ok: false, error: 'Tipo de input desconocido' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
app.api('/api/cdp/input', handleCdpInput, 'POST');
app.api('/api/cdp/input', handleCdpInput, 'GET');

app.api('/api/cdp/inspect', async (data) => {
  try {
    if (!cdpClient.isConnected) return { ok: false, error: 'CDP no conectado' };
    const x = Number(data.x) || 0;
    const y = Number(data.y) || 0;
    const node = await cdpClient.inspectNodeAt(x, y);
    return { ok: true, node };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'POST');
app.api('/api/cdp/inspect', async (data) => {
  try {
    if (!cdpClient.isConnected) return { ok: false, error: 'CDP no conectado' };
    const x = Number(data.x) || 0;
    const y = Number(data.y) || 0;
    const node = await cdpClient.inspectNodeAt(x, y);
    return { ok: true, node };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, 'GET');

app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css',
}), 'GET');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (val) => typeof val === 'string' && UUID_RE.test(val.trim());

let cachedAgPorts = null;
let cachedAgPortsAt = 0;

function getAntigravityCdpPorts() {
  if (cachedAgPorts && Date.now() - cachedAgPortsAt < 3000) return cachedAgPorts;
  const configured = Number(process.env.ANTIGRAVITY_CDP_PORT);
  if (Number.isInteger(configured) && configured > 0 && configured < 65536) {
    cachedAgPorts = [configured];
    cachedAgPortsAt = Date.now();
    return cachedAgPorts;
  }
  if (process.platform !== 'win32') return [];
  try {
    const activePortFile = join(process.env.APPDATA || '', 'Antigravity', 'DevToolsActivePort');
    if (existsSync(activePortFile)) {
      const firstLine = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/)[0];
      const activePort = parseInt(firstLine, 10);
      if (Number.isInteger(activePort) && activePort > 0 && activePort < 65536) {
        cachedAgPorts = [activePort];
        cachedAgPortsAt = Date.now();
        return cachedAgPorts;
      }
    }
  } catch {}
  try {
    const tasklist = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set(
      tasklist
        .split('\n')
        .map((line) => {
          const match = line.match(/"[^"]*","(\d+)"/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
    );
    const netstat = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ports = new Set();
    for (const line of netstat.split('\n')) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const localAddr = parts[1] || '';
      const pid = parts[parts.length - 1];
      if (pids.has(pid) && localAddr.startsWith('127.0.0.1:')) {
        const port = parseInt(localAddr.split(':')[1], 10);
        if (port > 0 && port < 65536) ports.add(port);
      }
    }
    cachedAgPorts = Array.from(ports);
    cachedAgPortsAt = Date.now();
    return cachedAgPorts;
  } catch {
    cachedAgPorts = [];
    cachedAgPortsAt = Date.now();
    return [];
  }
}

function fetchLocalJson(url, timeoutMs = 800) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolveReq(JSON.parse(body));
        } catch (err) {
          rejectReq(err);
        }
      });
    });
    req.on('error', rejectReq);
    req.on('timeout', () => {
      req.destroy();
      rejectReq(new Error('timeout'));
    });
  });
}

async function cdpEvaluateOnce(wsUrl, expression, timeoutMs = 900) {
  if (typeof WebSocket !== 'function' || !wsUrl) return null;
  return new Promise((resolveEval) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolveEval(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish(null);
      return;
    }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }));
      } catch {
        finish(null);
      }
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) {
          finish(msg.result?.result?.value ?? null);
        }
      } catch {}
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

function parseHubUrlIds(rawUrl) {
  if (typeof rawUrl !== 'string') return { conversationId: '', projectId: '' };
  const cMatch = rawUrl.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const pMatch = rawUrl.match(/[?&]project=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return {
    conversationId: cMatch ? cMatch[1] : '',
    projectId: pMatch ? pMatch[1] : '',
  };
}

async function discoverLiveHubTargets() {
  const ports = getAntigravityCdpPorts();
  const lists = await Promise.all(
    ports.map(async (port) => {
      try {
        const items = await fetchLocalJson(`http://127.0.0.1:${port}/json/list`, 700);
        return Array.isArray(items) ? items.map((item) => ({ ...item, cdpPort: port })) : [];
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

async function resolveActiveConversationInfo(preferredId, preferredProjectId) {
  let conversationId = isUuid(preferredId) ? preferredId.trim() : '';
  let projectId = isUuid(preferredProjectId) ? preferredProjectId.trim() : '';

  // 1. Live query to Antigravity Hub target over loopback CDP (tracks active chat switch in real time)
  if (!conversationId || !projectId) {
    try {
      const targets = await discoverLiveHubTargets();
      const hub = targets.find((t) =>
        t.type === 'page' &&
        /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/c\/[0-9a-f-]{36}/i.test(t.url || '')
      );
      if (hub) {
        const liveHref = await cdpEvaluateOnce(hub.webSocketDebuggerUrl, 'location.href', 1500);
        const parsed = parseHubUrlIds(typeof liveHref === 'string' && liveHref.includes('/c/') ? liveHref : hub.url);
        if (!conversationId && isUuid(parsed.conversationId)) conversationId = parsed.conversationId;
        if (!projectId && isUuid(parsed.projectId)) projectId = parsed.projectId;
      }
    } catch {}
  }

  if (!conversationId && isUuid(app.config.conversationId)) {
    conversationId = app.config.conversationId.trim();
  }
  if (!conversationId && isUuid(process.env.ANTIGRAVITY_CONVERSATION_ID)) {
    conversationId = process.env.ANTIGRAVITY_CONVERSATION_ID.trim();
  }
  if (!projectId && isUuid(app.config.projectId)) {
    projectId = app.config.projectId.trim();
  }
  if (!projectId && isUuid(process.env.ANTIGRAVITY_PROJECT_ID)) {
    projectId = process.env.ANTIGRAVITY_PROJECT_ID.trim();
  }

  // 2. Fallback scan of ~/.gemini/antigravity/brain
  if (!conversationId) {
    try {
      const userProfile = process.env.USERPROFILE || process.env.HOME || '';
      const brainDir = join(userProfile, '.gemini', 'antigravity', 'brain');
      if (existsSync(brainDir)) {
        const entries = readdirSync(brainDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && isUuid(d.name))
          .map((d) => {
            try {
              const transcriptPath = join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
              if (existsSync(transcriptPath)) {
                return { id: d.name, mtime: statSync(transcriptPath).mtimeMs };
              }
              const dirPath = join(brainDir, d.name);
              return { id: d.name, mtime: statSync(dirPath).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);

        if (entries.length > 0) conversationId = entries[0].id;
      }
    } catch (err) {
      console.warn('[Annotator] Error discovering active conversationId:', err?.message || err);
    }
  }

  // 3. Resolve workspace & projectId from conversation metadata if still missing
  let workspacePath = '';
  if (conversationId) {
    try {
      const meta = app.getConversationMetadata(conversationId);
      const cm = meta?.response?.conversationMetadata?.metadata || meta?.response?.conversation_metadata?.metadata;
      if (!projectId && isUuid(cm?.projectId || cm?.project_id)) {
        projectId = (cm.projectId || cm.project_id).trim();
      }
      const wsUri = cm?.workspaces?.[0]?.workspaceFolderAbsoluteUri || cm?.workspaceUris?.[0] || '';
      if (wsUri) workspacePath = toPath(wsUri);
    } catch {}
  }

  return { conversationId, projectId, workspacePath };
}

function getCommentsMarkdownPath(ws) {
  const baseWs = ws && existsSync(ws) ? ws : join(__dirname, '..', '..');
  const mdPath = join(baseWs, '.qa', 'comments.md');
  mkdirSync(dirname(mdPath), { recursive: true });
  return mdPath;
}

function appendCommentMarkdown(ws, entry) {
  try {
    const mdPath = getCommentsMarkdownPath(ws);
    const block = [
      `## [${entry.createdAt}] ${entry.selector}`,
      entry.url ? `- URL: ${entry.url}` : '',
      entry.tagClasses ? `- Elemento: \`${entry.tagClasses}\`` : '',
      `- Comentario: ${entry.comment}`,
      '',
    ].filter(Boolean).join('\n');
    const prev = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : '# QA Annotator Comments\n\n';
    writeFileSync(mdPath, prev + block + '\n', 'utf-8');
    return pathToFileURL(mdPath).href;
  } catch {
    const fallback = getCommentsMarkdownPath('');
    if (!existsSync(fallback)) writeFileSync(fallback, '# QA Annotator Comments\n\n', 'utf-8');
    return pathToFileURL(fallback).href;
  }
}

function deliverMessageToConversation(conversationId, message, title = '🎯 QA Annotator', projectId = '') {
  let lastErr = null;
  const opts = { title };
  if (isUuid(projectId)) opts.projectId = projectId;

  // 1. Try sidecar app.sendMessage
  try {
    app.sendMessage(conversationId, message, opts);
    return { ok: true, method: 'sidecar_sdk' };
  } catch (err) {
    lastErr = err;
    console.warn('[Annotator] app.sendMessage failed, fallback to direct agentapi:', err?.message || err);
  }

  // 2. Direct fallback using language_server.exe agentapi send-message
  if (candidateExe && existsSync(candidateExe)) {
    try {
      const env = { ...process.env };
      if (isUuid(projectId)) env.ANTIGRAVITY_PROJECT_ID = projectId;
      const out = execFileSync(candidateExe, ['agentapi', 'send-message', '--title', title, conversationId, message], {
        encoding: 'utf-8',
        env,
        timeout: 8000,
        windowsHide: true,
      });
      return { ok: true, method: 'direct_agentapi', output: out.trim() };
    } catch (err) {
      lastErr = err;
      console.error('[Annotator] direct agentapi execution failed:', err?.message || err);
    }
  }

  return { ok: false, error: lastErr?.message || 'No se pudo enviar el mensaje a la conversación' };
}

async function handleSendLiveAnnotation(data) {
  const info = await resolveActiveConversationInfo(data?.conversationId, data?.projectId);
  const conversationId = info.conversationId;
  if (!conversationId) {
    return { ok: false, sent: false, error: 'No se pudo identificar una conversación activa en Antigravity.' };
  }
  const sel = data.selector || '(sin selector)';
  const comment = (data.comment || '').trim() || '(Sin descripción específica, revisar elemento marcado)';
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

  const ws = toPath(data?.workspace) || info.workspacePath || defaultWs;
  const createdAt = new Date().toISOString();
  try {
    const cf = commentsFile(ws);
    const existing = readJson(cf, { comments: [] });
    const list = Array.isArray(existing?.comments) ? existing.comments : [];
    const isDup = list.some(c => c.selector === sel && c.comment === comment && Math.abs(Date.now() - new Date(c.createdAt).getTime()) < 2000);
    if (!isDup) {
      list.push({
        id: randomUUID(),
        selector: sel,
        tagClasses,
        comment,
        url,
        rect: data.rect || null,
        createdAt,
      });
      writeJson(cf, { comments: list, updatedAt: createdAt });
    }
  } catch {}

  const artifactUri = appendCommentMarkdown(ws, { selector: sel, tagClasses, comment, url, createdAt });
  const result = deliverMessageToConversation(conversationId, message, '🎯 QA Annotator', info.projectId);
  return {
    ok: result.ok,
    sent: result.ok,
    conversationId,
    projectId: info.projectId || '',
    artifactUri,
    method: result.method,
    error: result.ok ? undefined : result.error,
  };
}

app.api('/api/active-conversation', async (data) => {
  const info = await resolveActiveConversationInfo(data?.conversationId, data?.projectId);
  const ws = toPath(data?.workspace) || info.workspacePath || defaultWs;
  const mdPath = getCommentsMarkdownPath(ws);
  if (!existsSync(mdPath)) {
    try { writeFileSync(mdPath, '# QA Annotator Comments\n\n', 'utf-8'); } catch {}
  }
  return {
    ok: Boolean(info.conversationId),
    conversationId: info.conversationId,
    projectId: info.projectId || '',
    artifactUri: pathToFileURL(mdPath).href,
  };
}, 'GET');

app.api('/api/send-live-annotation', handleSendLiveAnnotation, 'POST');
app.api('/api/send-live-annotation', handleSendLiveAnnotation, 'GET');

app.api('/api/send-to-agent', async (data) => {
  const info = await resolveActiveConversationInfo(data?.conversationId, data?.projectId);
  if (!info.conversationId) {
    return { ok: false, error: 'No se pudo identificar una conversación activa en Antigravity.' };
  }
  const message = cleanText(data?.message || data?.markdownText, 12000);
  if (!message) return { ok: false, error: 'Mensaje vacío' };
  const ws = toPath(data?.workspace) || info.workspacePath || defaultWs;
  const artifactUri = appendCommentMarkdown(ws, {
    selector: data?.title || 'QA Annotator',
    tagClasses: '',
    comment: message.slice(0, 500),
    url: data?.url || '',
    createdAt: new Date().toISOString(),
  });
  const result = deliverMessageToConversation(info.conversationId, message, data?.title || '🎯 QA Annotator', info.projectId);
  return {
    ok: result.ok,
    conversationId: info.conversationId,
    projectId: info.projectId || '',
    artifactUri,
    method: result.method,
    error: result.ok ? undefined : result.error,
  };
}, 'POST');

app.api('/api/inject-local-inspector', async (data) => {
  try {
    const rawUrl = String(data?.url || '').trim();
    const enabled = data?.active !== false;
    const targets = await discoverLiveHubTargets();
    let origin = '';
    try { origin = rawUrl ? new URL(rawUrl).origin : ''; } catch {}
    const matches = targets.filter((t) => {
      if ((t.type !== 'iframe' && t.type !== 'page') || !t.webSocketDebuggerUrl) return false;
      if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(t.url || '')) return false;
      if (origin) return String(t.url || '').startsWith(origin);
      return true;
    });
    if (!matches.length) return { ok: false, injected: 0 };
    const inspectorSource = readFileSync(join(__dirname, 'live-inspector.js'), 'utf-8');
    let injected = 0;
    for (const target of matches) {
      const expr = `${inspectorSource};\nwindow.postMessage({ type: 'set-inspect-mode', enabled: ${Boolean(enabled)} }, '*'); true;`;
      const ok = await cdpEvaluateOnce(target.webSocketDebuggerUrl, expr, 1200);
      if (ok !== null) injected++;
    }
    return { ok: injected > 0, injected };
  } catch (err) {
    return { ok: false, injected: 0, error: err?.message || String(err) };
  }
}, 'POST');

let pendingAgentAction = null;
let lastActionResult = null;
let lastProcessedActionId = null;

const defaultWs = process.env.ANTIGRAVITY_WORKSPACE || process.cwd();

function checkFileCommands(wsPath) {
  const candidates = [
    wsPath,
    process.env.ANTIGRAVITY_WORKSPACE,
    process.cwd()
  ].filter(Boolean);

  for (const candidate of candidates) {
    const ws = toPath(candidate);
    if (!ws) continue;
    const actionFile = join(ws, '.qa', 'agent_action.json');
    if (existsSync(actionFile)) {
      try {
        const data = JSON.parse(readFileSync(actionFile, 'utf-8'));
        if (data && data.id && data.id !== lastProcessedActionId) {
          lastProcessedActionId = data.id;
          const completed = readJson(join(ws, '.qa', 'agent_result.json'), {});
          if (completed?.id === data.id) continue;
          pendingAgentAction = data;
          break;
        }
      } catch {}
    }
  }
}

async function handleAgentCommand(data) {
  lastActionResult = null;

  if (cdpClient.isConnected) {
    try {
      let result = null;
      if (data.action === 'navigate' && data.url) {
        result = await cdpClient.navigate(data.url);
      } else if (data.action === 'click' && data.selector) {
        result = await cdpClient.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(data.selector)});
          if (!el) return { ok: false, reason: 'not-found' };
          el.click();
          return { ok: true, tag: el.tagName.toLowerCase() };
        })()`);
      } else if (data.action === 'fill' && data.selector && typeof data.text === 'string') {
        result = await cdpClient.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(data.selector)});
          if (!el) return { ok: false, reason: 'not-found' };
          const value = ${JSON.stringify(data.text)};
          el.focus();
          if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
            el.checked = ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
          } else if (el.isContentEditable) {
            el.textContent = value;
          } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          } else if (el instanceof HTMLSelectElement) {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
          } else {
            return { ok: false, reason: 'unsupported-control' };
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        })()`);
      } else if (data.action === 'snapshot') {
        result = await cdpClient.snapshot();
      } else if (data.action === 'scroll') {
        const deltaY = Math.max(-1600, Math.min(1600, Number(data.deltaY) || 600));
        const deltaX = Math.max(-1200, Math.min(1200, Number(data.deltaX) || 0));
        result = await cdpClient.dispatchMouseEvent({
          type: 'mouseWheel',
          x: Math.max(0, Number(data.x) || Math.round(cdpClient.viewport.width / 2)),
          y: Math.max(0, Number(data.y) || Math.round(cdpClient.viewport.height / 2)),
          deltaX,
          deltaY,
        });
      } else if (data.action === 'press_key' && typeof data.key === 'string') {
        const key = data.key;
        const code = data.code || key;
        await cdpClient.dispatchKeyEvent({ type: 'rawKeyDown', key, code });
        if (key.length === 1) await cdpClient.dispatchKeyEvent({ type: 'char', key, code, text: key, unmodifiedText: key });
        result = await cdpClient.dispatchKeyEvent({ type: 'keyUp', key, code });
      }
      if (result === null) return { ok: false, executed: false, error: 'Acción incompleta o no admitida' };
      lastActionResult = { id: data.id || '', action: data.action || '', result };
      return { ok: true, executed: true, result };
    } catch (e) {
      console.warn('[CDP Agent Action Warning]:', e.message);
      lastActionResult = { id: data.id || '', action: data.action || '', error: e.message };
      return { ok: false, executed: false, error: e.message };
    }
  }

  return { ok: false, executed: false, error: 'CDP no conectado' };
}
app.api('/api/agent/command', handleAgentCommand, 'POST');
app.api('/api/agent/command', handleAgentCommand, 'GET');

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

app.api('/api/send', async (data) => {
  const ws = toPath(data.workspace);
  const session = ws ? loadSession(ws) : null;
  if (!ws || !session) return { ok: false, error: 'sin sesion de QA' };
  const { comments } = loadComments(ws, session);
  const selected = Array.isArray(data.ids) && data.ids.length
    ? comments.filter((c) => data.ids.includes(c.id))
    : comments;
  if (!selected.length) return { ok: false, error: 'no hay comentarios' };

  const info = await resolveActiveConversationInfo(data?.conversationId, data?.projectId);
  const conversationId = info.conversationId;
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

  const result = deliverMessageToConversation(conversationId, message, 'QA Annotator', info.projectId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, sent: selected.length, conversationId, projectId: info.projectId || '' };
});

app.run();
