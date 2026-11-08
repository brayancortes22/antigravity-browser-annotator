import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class BrowserManager {
  #process = null;
  #port = 9444;
  #executablePath = null;
  #userDataDir = null;

  constructor(options = {}) {
    this.#port = options.port || 9444;
    this.#userDataDir = options.userDataDir || join(tmpdir(), 'antigravity-browser-profile');
    mkdirSync(this.#userDataDir, { recursive: true });
    this.#executablePath = this.#findBrowserExecutable();
  }

  get port() {
    return this.#port;
  }

  get isRunning() {
    return this.#process !== null && !this.#process.killed;
  }

  #findBrowserExecutable() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    if (isWin) {
      const prog = process.env.PROGRAMFILES || 'C:\\Program Files';
      const prog86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const local = process.env.LOCALAPPDATA || '';

      const candidates = [
        join(prog, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(prog86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(prog86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(prog, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(prog, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ];

      for (const p of candidates) {
        if (p && existsSync(p)) return p;
      }
    } else if (isMac) {
      const macCandidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
      for (const p of macCandidates) {
        if (existsSync(p)) return p;
      }
    } else {
      const linuxCandidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
      for (const p of linuxCandidates) {
        if (existsSync(p)) return p;
      }
    }

    return null;
  }

  async start() {
    if (this.isRunning) return true;
    if (!this.#executablePath) {
      throw new Error('No se encontró ningún navegador basado en Chromium (Chrome, Edge o Brave) en el sistema.');
    }

    const args = [
      `--remote-debugging-port=${this.#port}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      '--autoplay-policy=no-user-gesture-required',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${this.#userDataDir}`,
      '--mute-audio=false',
      '--hide-scrollbars=false',
      'about:blank'
    ];

    this.#process = spawn(this.#executablePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    this.#process.on('exit', () => {
      this.#process = null;
    });

    // Wait for the CDP HTTP port to respond
    const ready = await this.#waitForCdpReady();
    if (!ready) {
      this.stop();
      throw new Error(`Tiempo de espera agotado al conectar al puerto CDP ${this.#port}`);
    }

    return true;
  }

  async #waitForCdpReady(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.#port}/json/version`);
        if (res.ok) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  stop() {
    if (this.#process) {
      try {
        this.#process.kill('SIGKILL');
      } catch {}
      this.#process = null;
    }
  }
}
