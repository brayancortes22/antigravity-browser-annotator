/**
 * Antigravity CDP Screencast & Inspector View
 * Renders live Chromium frames onto <canvas> and forwards user/agent interactions.
 */
class CdpStreamView {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.container = null;
    this.statusBadge = null;
    this.fpsText = null;
    this.inspectIndicator = null;

    this.isStreaming = false;
    this.inspectMode = false;
    this.inspectHoverNode = null;
    this.lastFrameTimestamp = 0;
    this.frameCount = 0;
    this.fpsTimer = null;
    this.fetchAbortController = null;
    this.pendingInspect = false;
    this.onAnnotationCallback = null;

    // Viewport native dimensions in Chromium
    this.nativeWidth = 1280;
    this.nativeHeight = 800;
    this.token = '';
  }

  init(options = {}) {
    this.canvas = document.getElementById(options.canvasId || 'cdp-canvas');
    this.container = document.getElementById(options.containerId || 'cdp-viewport-container');
    this.statusBadge = document.getElementById(options.statusBadgeId || 'cdp-status-badge');
    this.fpsText = document.getElementById(options.fpsTextId || 'cdp-fps-text');
    this.inspectIndicator = document.getElementById(options.inspectIndicatorId || 'inspect-status-indicator');
    this.onAnnotationCallback = options.onAnnotationCreated || null;
    const urlParams = new URLSearchParams(window.location.search);
    this.token = urlParams.get('token') || window.sidecarToken || '';

    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.#attachInputListeners();
    this.#startFpsCounter();
  }

  #getScaledCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.nativeWidth / rect.width;
    const scaleY = this.nativeHeight / rect.height;
    return {
      x: Math.round(Math.max(0, Math.min(this.nativeWidth, (e.clientX - rect.left) * scaleX))),
      y: Math.round(Math.max(0, Math.min(this.nativeHeight, (e.clientY - rect.top) * scaleY))),
    };
  }

  #attachInputListeners() {
    const c = this.canvas;
    if (!c) return;

    // Focus canvas on click so keyboard events are captured
    c.addEventListener('click', () => c.focus());

    // Mouse Move
    c.addEventListener('mousemove', (e) => {
      const coords = this.#getScaledCoords(e);
      if (this.inspectMode) {
        this.#handleInspectHover(coords.x, coords.y, e);
        return;
      }
      this.#sendInput({
        kind: 'mouse',
        type: 'mouseMoved',
        x: coords.x,
        y: coords.y,
      });
    });

    // Mouse Down
    c.addEventListener('mousedown', (e) => {
      const coords = this.#getScaledCoords(e);
      if (this.inspectMode) {
        this.#handleInspectClick(coords.x, coords.y, e);
        return;
      }
      const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      this.#sendInput({
        kind: 'mouse',
        type: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: 1,
      });
    });

    // Mouse Up
    c.addEventListener('mouseup', (e) => {
      if (this.inspectMode) return;
      const coords = this.#getScaledCoords(e);
      const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      this.#sendInput({
        kind: 'mouse',
        type: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: 1,
      });
    });

    // Wheel (Scroll)
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const coords = this.#getScaledCoords(e);
      this.#sendInput({
        kind: 'mouse',
        type: 'mouseWheel',
        x: coords.x,
        y: coords.y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    }, { passive: false });

    // Context Menu (Right Click)
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Keyboard Events
    c.addEventListener('keydown', (e) => {
      this.#sendInput({
        kind: 'key',
        type: 'rawKeyDown',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        text: e.key.length === 1 ? e.key : undefined,
      });
    });

    c.addEventListener('keyup', (e) => {
      this.#sendInput({
        kind: 'key',
        type: 'keyUp',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
      });
    });
  }

  async #sendInput(payload) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers['x-sidecar-token'] = this.token;
      const url = '/api/cdp/input' + (this.token ? '?token=' + encodeURIComponent(this.token) : '');
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch {}
  }

  setInspectMode(enabled) {
    this.inspectMode = enabled;
    if (this.canvas) {
      this.canvas.style.cursor = enabled ? 'crosshair' : 'default';
    }
    const tooltip = document.getElementById('inspect-tooltip');
    if (!enabled && tooltip) {
      tooltip.style.display = 'none';
    }
  }

  async #handleInspectHover(x, y, e) {
    if (this.pendingInspect) return;
    this.pendingInspect = true;

    try {
      const q = new URLSearchParams({ x, y, _t: Date.now() }); if (this.token) q.set('token', this.token); const res = await fetch('/api/cdp/inspect?' + q.toString());
      const data = await res.json();
      if (data?.ok && data.node) {
        this.inspectHoverNode = data.node;
        this.#renderInspectTooltip(data.node, e);
      }
    } catch {} finally {
      this.pendingInspect = false;
    }
  }

  #renderInspectTooltip(node, e) {
    const tooltip = document.getElementById('inspect-tooltip');
    if (!tooltip) return;

    document.getElementById('tt-classes').textContent = node.tagClasses || node.tag || 'elemento';
    document.getElementById('tt-dims').textContent = `${node.rect?.width || 0} × ${node.rect?.height || 0}`;
    document.getElementById('tt-padding').textContent = `x: ${node.rect?.x || 0}, y: ${node.rect?.y || 0}`;
    document.getElementById('tt-role').textContent = node.tag || 'nodo';

    const canvasRect = this.canvas.getBoundingClientRect();
    let ttTop = e.clientY - 90;
    if (ttTop < 10) ttTop = e.clientY + 20;
    let ttLeft = Math.min(Math.max(10, e.clientX - 100), canvasRect.width - 250);

    tooltip.style.top = Math.round(ttTop) + 'px';
    tooltip.style.left = Math.round(ttLeft) + 'px';
    tooltip.style.display = 'block';
  }

  #handleInspectClick(x, y, e) {
    if (!this.inspectHoverNode) return;
    const node = this.inspectHoverNode;
    const comment = prompt(`Comentario para el elemento "${node.tagClasses}":`, '');
    if (comment && comment.trim() && typeof this.onAnnotationCallback === 'function') {
      this.onAnnotationCallback({
        selector: node.selector,
        tagClasses: node.tagClasses,
        comment: comment.trim(),
        rect: node.rect,
      });
    }
  }

  show() {
    if (this.container) this.container.classList.remove('hidden');
    this.startStream();
  }

  hide() {
    if (this.container) this.container.classList.add('hidden');
    this.stopStream();
  }

  startStream() {
    if (this.isStreaming) return;
    this.isStreaming = true;
    this.#pollFrames();
  }

  stopStream() {
    this.isStreaming = false;
    if (this.fetchAbortController) {
      this.fetchAbortController.abort();
      this.fetchAbortController = null;
    }
  }

  async #pollFrames() {
    while (this.isStreaming) {
      try {
        const frameUrl = '/api/cdp/frame' + (this.token ? '?token=' + encodeURIComponent(this.token) : '');
        const res = await fetch(frameUrl);
        if (res.ok) {
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob);
          this.ctx.drawImage(bitmap, 0, 0, this.nativeWidth, this.nativeHeight);
          bitmap.close();
          this.frameCount++;
          this.lastFrameTimestamp = Date.now();
        }
      } catch (err) {
        await new Promise(r => setTimeout(r, 200));
      }
      // Minimal interval (~30ms = 33 FPS)
      await new Promise(r => setTimeout(r, 30));
    }
  }

  #startFpsCounter() {
    setInterval(() => {
      if (this.fpsText) {
        this.fpsText.textContent = this.isStreaming ? `${this.frameCount} FPS` : 'OFF';
      }
      this.frameCount = 0;
    }, 1000);
  }

  async navigate(url) {
    try {
      const q = new URLSearchParams({ url, _t: Date.now() });
      if (this.token) q.set('token', this.token);
      await fetch('/api/cdp/start?' + q.toString(), {
        headers: this.token ? { 'x-sidecar-token': this.token } : {},
      });
      this.show();
    } catch (err) {
      console.error('[CDP Navigate Error]:', err);
    }
  }
}

window.cdpStreamView = new CdpStreamView();
