#!/usr/bin/env node
/**
 * Captura headless con Chrome/Edge via CDP (sin Playwright, sin ventanas).
 *
 * Uso:
 *   node capture.mjs --url http://localhost:3000 --out .qa
 *   node capture.mjs --url http://localhost:3000 --out .qa --mobile
 *   node capture.mjs --url http://localhost:3000 --out .qa --width 1440 --height 1200 --wait 1500
 *
 * Escribe:
 *   <out>/latest.json       (sesion para el panel QA Annotator)
 *   <out>/shots/<id>.png
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
}
const has = (name) => process.argv.includes(`--${name}`);

const url = arg('url');
if (!url) {
  console.error('Falta --url <http://...>');
  process.exit(2);
}
const out = resolve(arg('out', '.qa'));
const mobile = has('mobile');
const width = Number(arg('width', mobile ? 390 : 1440));
const height = Number(arg('height', mobile ? 844 : 900));
const waitMs = Number(arg('wait', 1200));
const workspace = dirname(out);

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || '';
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No encontre Chrome ni Edge. Define CHROME_PATH.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf-8').trim();
      if (text) return text;
    }
    await sleep(100);
  }
  throw new Error(`No aparecio ${path}`);
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', (e) => rej(new Error(String(e?.message || 'ws error'))), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    const set = listeners.get(msg.method);
    if (set) for (const fn of [...set]) fn(msg.params);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const once = (method, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const set = listeners.get(method) || new Set();
    listeners.set(method, set);
    const timer = setTimeout(() => {
      set.delete(fn);
      reject(new Error(`timeout esperando ${method}`));
    }, timeoutMs);
    const fn = (params) => {
      clearTimeout(timer);
      set.delete(fn);
      resolve(params);
    };
    set.add(fn);
  });

  return { ws, opened, send, once };
}

const collect = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  const seen = new Set();
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const cls = [...n.classList].filter((c) => /^[A-Za-z][\\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const nodes = document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="checkbox"],h1,h2,h3,h4,img,header,nav,main,section,footer,article,form,table,label');
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    if (!text && !['IMG', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    const key = selectorOf(el);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      selector: key,
      tag: el.tagName.toLowerCase(),
      text,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      area: Math.round(r.width * r.height),
    });
    if (out.length >= 220) break;
  }
  out.sort((a, b) => b.area - a.area);
  return {
    title: document.title,
    url: location.href,
    width: vw,
    height: vh,
    elements: out.map(({ area, ...rest }) => rest),
  };
})()`;

const tmp = mkdtempSync(join(tmpdir(), 'qa-annotator-'));
const child = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--remote-debugging-port=0',
  `--user-data-dir=${tmp}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let client;
try {
  const active = await waitForFile(join(tmp, 'DevToolsActivePort'), 20000);
  const port = active.split(/\r?\n/)[0];
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then((r) => r.json());

  client = cdpClient(target.webSocketDebuggerUrl);
  await client.opened;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
  });

  const loaded = client.once('Page.loadEventFired', 20000).catch(() => null);
  await client.send('Page.navigate', { url });
  await loaded;
  await sleep(waitMs);

  const evaluated = await client.send('Runtime.evaluate', {
    expression: collect,
    returnByValue: true,
    awaitPromise: true,
  });
  const page = evaluated?.result?.value;
  if (!page) throw new Error('No pude leer el DOM de la pagina');

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });

  const id = `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const shotsDir = join(out, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const png = join(shotsDir, `${id}.png`);
  writeFileSync(png, Buffer.from(shot.data, 'base64'));

  const session = {
    id,
    createdAt: new Date().toISOString(),
    url: page.url,
    title: page.title,
    viewport: { width: page.width, height: page.height },
    screenshot: relative(workspace, png).split('\\').join('/'),
    elements: page.elements,
  };
  writeFileSync(join(out, 'latest.json'), JSON.stringify(session, null, 2), 'utf-8');

  console.log(JSON.stringify({
    ok: true,
    id,
    url: session.url,
    title: session.title,
    viewport: session.viewport,
    elements: session.elements.length,
    screenshot: png,
    session: join(out, 'latest.json'),
  }, null, 2));
} catch (err) {
  console.error(`[qa-annotator] ${err?.message || err}`);
  process.exitCode = 1;
} finally {
  try { client?.ws.close(); } catch {}
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
