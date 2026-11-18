export class CdpClient {
  #ws = null;
  #msgId = 1;
  #pendingRequests = new Map();
  #subscribers = new Set();
  #latestFrame = null;
  #frameSequence = 0;
  #frameWaiters = new Set();
  #navigationVersion = 0;
  #viewport = { width: 1280, height: 800 };
  #currentUrl = 'about:blank';
  #pageTitle = '';

  constructor(port = 9444) {
    this.port = port;
  }

  get latestFrame() {
    return this.#latestFrame;
  }

  get currentUrl() {
    return this.#currentUrl;
  }

  get pageTitle() {
    return this.#pageTitle;
  }

  get viewport() {
    return this.#viewport;
  }

  get isConnected() {
    return this.#ws !== null && this.#ws.readyState === 1; // WebSocket.OPEN
  }

  async connect() {
    if (this.isConnected) return;

    // Retrieve active page target from CDP list
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    const targets = await res.json();
    let pageTarget = targets.find(t => t.type === 'page');

    if (!pageTarget) {
      const newRes = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
      pageTarget = await newRes.json();
    }

    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No se pudo encontrar o crear un target de página en CDP');
    }

    this.#ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      this.#ws.onopen = resolve;
      this.#ws.onerror = reject;
    });

    this.#ws.onmessage = (event) => this.#handleMessage(event.data);
    this.#ws.onclose = () => {
      this.#ws = null;
    };

    // Initialize CDP domains
    await this.send('Page.enable');
    await this.send('DOM.enable');
    await this.send('Runtime.enable');
    // Start real-time screencast
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  }

  #handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id && this.#pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.#pendingRequests.get(msg.id);
      this.#pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP Error'));
      else resolve(msg.result);
      return;
    }

    if (msg.method === 'Page.screencastFrame') {
      const { data, metadata, sessionId } = msg.params;
      this.#latestFrame = { data, metadata, timestamp: Date.now(), sequence: ++this.#frameSequence };

      // Immediately acknowledge frame so Chrome keeps emitting at full speed
      this.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

      // Notify all UI stream subscribers
      for (const cb of this.#subscribers) {
        try { cb(this.#latestFrame); } catch {}
      }
      for (const waiter of this.#frameWaiters) waiter(this.#latestFrame);
    } else if (msg.method === 'Page.frameNavigated') {
      if (msg.params?.frame?.url && !msg.params.frame.parentId) {
        this.#currentUrl = msg.params.frame.url;
        this.#navigationVersion++;
      }
    } else if (msg.method === 'Page.loadEventFired') {
      this.evaluate('document.title').then(res => {
        if (res && typeof res === 'string') this.#pageTitle = res;
      }).catch(() => {});
    }
  }

  send(method, params = {}) {
    if (!this.isConnected) {
      return Promise.reject(new Error('CDP WebSocket no está conectado'));
    }
    const id = this.#msgId++;
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  subscribeFrames(callback) {
    this.#subscribers.add(callback);
    if (this.#latestFrame) callback(this.#latestFrame);
    return () => this.#subscribers.delete(callback);
  }

  waitForFrame(afterSequence = 0, timeoutMs = 1000) {
    if (this.#latestFrame && this.#latestFrame.sequence > afterSequence) {
      return Promise.resolve(this.#latestFrame);
    }
    return new Promise((resolve) => {
      let timer;
      const finish = (frame) => {
        clearTimeout(timer);
        this.#frameWaiters.delete(onFrame);
        resolve(frame || this.#latestFrame);
      };
      const onFrame = (frame) => {
        if (frame.sequence > afterSequence) finish(frame);
      };
      this.#frameWaiters.add(onFrame);
      timer = setTimeout(() => {
        clearTimeout(timer);
        this.#frameWaiters.delete(onFrame);
        resolve(null);
      }, timeoutMs);
    });
  }

  async setViewport(width, height) {
    const boundedWidth = Math.max(320, Math.min(2560, Math.round(width)));
    const boundedHeight = Math.max(240, Math.min(1600, Math.round(height)));
    const result = await this.send('Emulation.setDeviceMetricsOverride', {
      width: boundedWidth,
      height: boundedHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.#viewport = { width: boundedWidth, height: boundedHeight };
    return result;
  }

  async navigate(url) {
    this.#currentUrl = url;
    const startingVersion = this.#navigationVersion;
    const result = await this.send('Page.navigate', { url });
    if (result?.errorText) return { url: this.#currentUrl, loadState: 'error', error: result.errorText };
    if (!result?.loaderId) return { ...result, url: this.#currentUrl, loadState: 'same-document' };
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (this.#navigationVersion > startingVersion) {
        const readyState = await this.evaluate('document.readyState').catch(() => 'loading');
        if (readyState === 'complete') return { url: this.#currentUrl, loadState: 'complete' };
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return { url: this.#currentUrl, loadState: 'timeout' };
  }

  async reload() {
    return this.send('Page.reload', { ignoreCache: true });
  }

  async dispatchMouseEvent(event) {
    // type: mousePressed, mouseReleased, mouseMoved, mouseWheel
    return this.send('Input.dispatchMouseEvent', event);
  }

  async dispatchKeyEvent(event) {
    // type: rawKeyDown, keyDown, keyUp, char
    return this.send('Input.dispatchKeyEvent', event);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  }

  async inspectNodeAt(x, y) {
    const expr = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const classes = el.classList.length ? '.' + Array.from(el.classList).join('.') : '';
      return {
        tag,
        selector: tag + id + (classes ? classes.split(' ').join('') : ''),
        tagClasses: tag + (classes || ''),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        text: (el.innerText || el.textContent || '').trim().slice(0, 100),
      };
    })()`;
    return this.evaluate(expr);
  }

  async snapshot() {
    return this.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 20000),
      controls: Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]'))
        .slice(0, 120)
        .map((el, index) => {
          const selector = (() => {
            if (el.id) return '#' + CSS.escape(el.id);
            if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
            const parts = [];
            let node = el;
            while (node && node.nodeType === 1 && node !== document.documentElement) {
              let part = node.tagName.toLowerCase();
              const parent = node.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
              }
              parts.unshift(part);
              node = parent;
              const candidate = parts.join(' > ');
              try { if (document.querySelectorAll(candidate).length === 1) break; } catch {}
            }
            return parts.join(' > ');
          })();
          return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 180),
          type: el.getAttribute('type') || '',
          selector,
          disabled: Boolean(el.disabled),
          href: el instanceof HTMLAnchorElement ? el.href : undefined
          };
        })
    }))()`);
  }

  disconnect() {
    this.#subscribers.clear();
    if (this.#ws) {
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
  }
}
