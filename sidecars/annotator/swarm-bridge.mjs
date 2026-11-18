import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REG_FILE = join(homedir(), '.swarm-qa-browser', 'bus.json');

export function getSwarmBusInfo() {
  if (!existsSync(REG_FILE)) return null;
  try { return JSON.parse(readFileSync(REG_FILE, 'utf8')); }
  catch { return null; }
}

export async function forwardSwarmCommand(action, params = {}) {
  const reg = getSwarmBusInfo();
  if (!reg) return { ok: false, error: 'Swarm Bus no activo' };
  try {
    const res = await fetch(`http://${reg.host}:${reg.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-swarm-token': reg.token },
      body: JSON.stringify({ action, params })
    });
    return res.json();
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function injectSwarmOverlayIntoCdp(cdpClient) {
  const overlayPath = join(import.meta.dirname, 'overlay.bundle.js');
  if (!existsSync(overlayPath)) return { ok: false, error: 'overlay.bundle.js not found' };
  try {
    const bundleSource = readFileSync(overlayPath, 'utf8');
    await cdpClient.send('Runtime.evaluate', { expression: bundleSource, silent: true });
    await cdpClient.send('Runtime.evaluate', {
      expression: `if (globalThis.__swarmQaOverlayFactory?.mountSwarmOverlay) {
        globalThis.__swarmQaOverlayFactory.mountSwarmOverlay({ doc: document, win: window });
      }`,
      silent: true
    });
    return { ok: true, injected: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
