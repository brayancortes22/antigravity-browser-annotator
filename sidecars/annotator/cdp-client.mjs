export class CdpClient {
  #ws = null;
  #msgId = 1;
  #pendingRequests = new Map();
  #subscribers = new Set();
  #latestFrame = null;
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
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = window.chrome || { runtime: {} };"
    });

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
      this.#latestFrame = { data, metadata, timestamp: Date.now() };

      // Immediately acknowledge frame so Chrome keeps emitting at full speed
      this.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

      // Notify all UI stream subscribers
      for (const cb of this.#subscribers) {
        try { cb(this.#latestFrame); } catch {}
      }
    } else if (msg.method === 'Page.frameNavigated') {
      if (msg.params?.frame?.url && !msg.params.frame.parentId) {
        this.#currentUrl = msg.params.frame.url;
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

  async navigate(url) {
    this.#currentUrl = url;
    return this.send('Page.navigate', { url });
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

  disconnect() {
    this.#subscribers.clear();
    if (this.#ws) {
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
  }
}
