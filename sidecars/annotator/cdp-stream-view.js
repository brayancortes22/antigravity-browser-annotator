/**
 * Antigravity CDP Screencast & Inspector View
 * Renders live Chromium frames onto <canvas> and forwards user/agent interactions.
 */
class CdpStreamView {
  constructor() {
    this.canvas = null;
    this.textInputProxy = null;
    this.ctx = null;
    this.container = null;
    this.wrapper = null;
    this.inspectBox = null;
    this.inspectTooltip = null;
    this.inspectComment = null;
    this.inspectCommentInput = null;
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
    this.pendingInspectPoint = null;
    this.selectedInspectNode = null;
    this.onAnnotationCallback = null;

    // Viewport native dimensions in Chromium
    this.nativeWidth = 1280;
    this.nativeHeight = 800;
    this.frameSequence = 0;
    this.resizeTimer = null;
    this.inputQueue = Promise.resolve();
    this.moveFramePending = false;
    this.pendingMouseMove = null;
    this.proxyKeyActive = false;
    this.proxyInputHandled = '';
    this.currentUrl = '';
    this.streamGeneration = 0;
    this.token = '';
  }

  init(options = {}) {
    this.canvas = document.getElementById(options.canvasId || 'cdp-canvas');
    this.textInputProxy = document.getElementById('cdp-text-input-proxy');
    this.container = document.getElementById(options.containerId || 'cdp-viewport-container');
    this.wrapper = document.getElementById(options.wrapperId || 'cdp-canvas-wrapper');
    this.inspectBox = document.getElementById('cdp-inspect-box');
    this.inspectTooltip = document.getElementById('cdp-inspect-tooltip');
    this.inspectComment = document.getElementById('cdp-inspect-comment');
    this.inspectCommentInput = document.getElementById('cdp-inspect-comment-input');
    this.statusBadge = document.getElementById(options.statusBadgeId || 'cdp-status-badge');
    this.fpsText = document.getElementById(options.fpsTextId || 'cdp-fps-text');
    this.inspectIndicator = document.getElementById(options.inspectIndicatorId || 'inspect-status-indicator');
    this.onAnnotationCallback = options.onAnnotationCreated || null;
    const urlParams = new URLSearchParams(window.location.search);
    this.token = urlParams.get('token') || window.sidecarToken || '';

    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.#attachInputListeners();
    document.getElementById('cdp-inspect-submit')?.addEventListener('click', () => this.#submitInspectComment());
    document.getElementById('cdp-inspect-cancel')?.addEventListener('click', () => this.#clearInspectSelection());
    this.inspectCommentInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.#submitInspectComment();
      if (e.key === 'Escape') this.#clearInspectSelection();
    });
    document.addEventListener('paste', (e) => {
      if (!this.isStreaming || this.inspectMode || !this.#isBrowserInputTarget(e.target)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (typeof text !== 'string' || !text.length) return;
      e.preventDefault();
      this.#sendTypedText(text);
    }, true);
    document.addEventListener('beforeinput', (e) => {
      if (!this.isStreaming || this.inspectMode || !this.#isBrowserInputTarget(e.target)) return;
      if (!e.inputType?.startsWith('insert') || typeof e.data !== 'string' || !e.data.length) return;
      e.preventDefault();
      this.proxyInputHandled = e.data;
      this.#sendTypedText(e.data);
    }, true);
    this.textInputProxy?.addEventListener('input', () => {
      const text = this.textInputProxy.value;
      this.textInputProxy.value = '';
      if (text && text === this.proxyInputHandled) {
        this.proxyInputHandled = '';
        return;
      }
      if (text && !this.proxyKeyActive && !this.inspectMode) this.#sendTypedText(text);
    });
    this.#startFpsCounter();
    this.resizeObserver = new ResizeObserver(() => this.#scheduleViewportResize());
    this.resizeObserver.observe(this.container || this.canvas);
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

  #getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  #isBrowserInputTarget(target) {
    return target === this.canvas || target === this.textInputProxy
      || target === this.wrapper || target === document.body || target === document.documentElement;
  }

  #attachInputListeners() {
    const c = this.canvas;
    if (!c) return;

    // Keep a real editable focus target so paste/type_text from the host app
    // can be forwarded to the remote page through CDP.
    c.addEventListener('click', () => {
      if (this.inspectMode) c.focus();
      else (this.textInputProxy || c).focus({ preventScroll: true });
    });

    // Mouse Move
    c.addEventListener('mousemove', (e) => {
      const coords = this.#getScaledCoords(e);
      if (this.inspectMode) {
        this.#handleInspectHover(coords.x, coords.y, e);
        return;
      }
      this.pendingMouseMove = {
        kind: 'mouse',
        type: 'mouseMoved',
        x: coords.x,
        y: coords.y,
        modifiers: this.#getModifiers(e),
      };
      if (!this.moveFramePending) {
        this.moveFramePending = true;
        requestAnimationFrame(() => {
          this.moveFramePending = false;
          if (this.pendingMouseMove) this.#sendInput(this.pendingMouseMove);
        });
      }
    });

    // Mouse Down
    c.addEventListener('mousedown', (e) => {
      const coords = this.#getScaledCoords(e);
      if (this.inspectMode) {
        e.preventDefault();
        e.stopPropagation();
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
        modifiers: this.#getModifiers(e),
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
        modifiers: this.#getModifiers(e),
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
        modifiers: this.#getModifiers(e),
      });
    }, { passive: false });

    // Context Menu (Right Click)
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Keyboard Events
    const forwardKeyDown = (e) => {
      if (e.target === this.textInputProxy) {
        e.preventDefault();
        this.proxyKeyActive = true;
      }
      this.#sendInput({
        kind: 'key',
        type: 'rawKeyDown',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        modifiers: this.#getModifiers(e),
      });
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        this.#sendInput({
          kind: 'key',
          type: 'char',
          key: e.key,
          code: e.code,
          text: e.key,
          unmodifiedText: e.key,
          windowsVirtualKeyCode: e.keyCode,
          modifiers: this.#getModifiers(e),
        });
      }
    };

    const forwardKeyUp = (e) => {
      this.#sendInput({
        kind: 'key',
        type: 'keyUp',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        modifiers: this.#getModifiers(e),
      });
      if (e.target === this.textInputProxy) {
        this.proxyKeyActive = false;
        this.textInputProxy.value = '';
      }
    };

    document.addEventListener('keydown', (e) => {
      if (!this.isStreaming || this.inspectMode || !this.#isBrowserInputTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      forwardKeyDown(e);
    }, true);
    document.addEventListener('keyup', (e) => {
      if (!this.isStreaming || this.inspectMode || !this.#isBrowserInputTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      forwardKeyUp(e);
    }, true);
  }

  async #sendTypedText(text) {
    for (const character of Array.from(text)) {
      const key = character === '\n' ? 'Enter' : character;
      const code = character === '\n' ? 'Enter'
        : /^[a-z]$/i.test(character) ? `Key${character.toUpperCase()}`
          : /^\d$/.test(character) ? `Digit${character}` : 'Unidentified';
      const keyCode = character === '\n' ? 13
        : /^[a-z]$/i.test(character) ? character.toUpperCase().charCodeAt(0)
          : /^\d$/.test(character) ? character.charCodeAt(0) : 0;
      await this.#sendInput({ kind: 'key', type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode });
      await this.#sendInput({ kind: 'key', type: 'char', key, code, text: character, unmodifiedText: character, windowsVirtualKeyCode: keyCode });
      await this.#sendInput({ kind: 'key', type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    }
  }

  async #sendInput(payload) {
    const send = async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers['x-sidecar-token'] = this.token;
      const url = '/api/cdp/input' + (this.token ? '?token=' + encodeURIComponent(this.token) : '');
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    };
    if (payload.kind === 'key') {
      this.inputQueue = this.inputQueue.catch(() => {}).then(send).catch(() => {});
      return this.inputQueue;
    }
    try { await send(); } catch {}
  }

  setInspectMode(enabled) {
    this.inspectMode = enabled;
    if (this.canvas) {
      this.canvas.style.cursor = enabled ? 'crosshair' : 'default';
    }
    if (!enabled) {
      this.inspectHoverNode = null;
      if (this.inspectTooltip) this.inspectTooltip.style.display = 'none';
      this.#clearInspectSelection();
    }
  }

  async #handleInspectHover(x, y, e) {
    this.pendingInspectPoint = { x, y, e };
    if (this.pendingInspect) return;
    this.pendingInspect = true;

    try {
      while (this.pendingInspectPoint && this.inspectMode) {
        const point = this.pendingInspectPoint;
        this.pendingInspectPoint = null;
        const q = new URLSearchParams({ x: point.x, y: point.y, _t: Date.now() });
        if (this.token) q.set('token', this.token);
        const res = await fetch('/api/cdp/inspect?' + q.toString());
        const data = await res.json();
        if (data?.ok && data.node && !this.pendingInspectPoint) {
          this.inspectHoverNode = data.node;
          this.#renderInspectTooltip(data.node, point.e);
        }
      }
    } catch {} finally {
      this.pendingInspect = false;
    }
  }

  #renderInspectTooltip(node, e) {
    const tooltip = this.inspectTooltip;
    if (!tooltip) return;

    document.getElementById('cdp-tt-classes').textContent = node.selector || node.tagClasses || node.tag || 'elemento';
    document.getElementById('cdp-tt-dims').textContent = `${node.rect?.width || 0} × ${node.rect?.height || 0}`;
    document.getElementById('cdp-tt-text').textContent = node.text || node.tag || '';

    const rect = this.wrapper.getBoundingClientRect();
    const top = e.clientY - rect.top;
    const left = e.clientX - rect.left;
    let ttTop = top - 82;
    if (ttTop < 10) ttTop = top + 18;
    const ttLeft = Math.min(Math.max(10, left - 100), rect.width - 330);

    tooltip.style.top = Math.round(ttTop) + 'px';
    tooltip.style.left = Math.round(ttLeft) + 'px';
    tooltip.style.display = 'block';
  }

  async #handleInspectClick(x, y, e) {
    // Resolve the clicked point directly. A pointer can enter the canvas and
    // be clicked before the asynchronous hover inspection has completed.
    this.#showInspectMessage('Consultando elemento…', e);
    let node = this.inspectHoverNode;
    try {
      const q = new URLSearchParams({ x, y, _t: Date.now() });
      if (this.token) q.set('token', this.token);
      const res = await fetch('/api/cdp/inspect?' + q.toString());
      const data = await res.json();
      if (!res.ok || !data?.ok || !data.node) {
        this.#showInspectMessage(data?.error || 'No se encontró un elemento en ese punto.', e);
        return;
      }
      node = data.node;
      this.inspectHoverNode = node;
      this.#renderInspectTooltip(node, e);
      this.#showInspectSelection(node);
    } catch {
      this.#showInspectMessage('No se pudo consultar el elemento. Revisa la conexión CDP.', e);
    }
  }

  #showInspectMessage(message, e) {
    if (!this.inspectTooltip || !this.wrapper) return;
    document.getElementById('cdp-tt-classes').textContent = 'Inspector CDP';
    document.getElementById('cdp-tt-dims').textContent = '';
    document.getElementById('cdp-tt-text').textContent = message;
    const rect = this.wrapper.getBoundingClientRect();
    this.inspectTooltip.style.left = `${Math.max(8, e.clientX - rect.left)}px`;
    this.inspectTooltip.style.top = `${Math.max(8, e.clientY - rect.top + 16)}px`;
    this.inspectTooltip.style.display = 'block';
  }

  #showInspectSelection(node) {
    if (!this.inspectBox || !this.inspectComment || !this.wrapper) return;
    this.selectedInspectNode = node;
    const wrapperRect = this.wrapper.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const left = canvasRect.left - wrapperRect.left + (node.rect?.x || 0) * canvasRect.width / this.nativeWidth;
    const top = canvasRect.top - wrapperRect.top + (node.rect?.y || 0) * canvasRect.height / this.nativeHeight;
    const width = Math.max(2, (node.rect?.width || 1) * canvasRect.width / this.nativeWidth);
    const height = Math.max(2, (node.rect?.height || 1) * canvasRect.height / this.nativeHeight);

    Object.assign(this.inspectBox.style, {
      display: 'block',
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
    });
    document.getElementById('cdp-inspect-selector').textContent = node.selector || node.tagClasses || node.tag;
    this.inspectCommentInput.value = '';
    const boxTop = Math.min(Math.max(8, top + height + 8), wrapperRect.height - 70);
    const boxLeft = Math.min(Math.max(8, left), wrapperRect.width - 370);
    Object.assign(this.inspectComment.style, {
      display: 'block',
      left: `${Math.round(boxLeft)}px`,
      top: `${Math.round(boxTop)}px`,
    });
    this.inspectTooltip.style.display = 'none';
    setTimeout(() => this.inspectCommentInput?.focus(), 30);
  }

  async #submitInspectComment() {
    const node = this.selectedInspectNode;
    if (!node || typeof this.onAnnotationCallback !== 'function') {
      this.#clearInspectSelection();
      return;
    }
    const comment = this.inspectCommentInput?.value?.trim() || '(Sin descripción específica, revisar elemento marcado)';
    const submitBtn = document.getElementById('cdp-inspect-submit');
    const prevLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Enviando...';
    }
    try {
      await this.onAnnotationCallback({
        selector: node.selector,
        tagClasses: node.tagClasses,
        comment,
        rect: node.rect,
        url: this.currentUrl || undefined,
      });
      this.#clearInspectSelection();
    } catch (err) {
      console.error('[CDP Inspect Submit Error]:', err);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel || 'Enviar al chat';
      }
    }
  }

  #clearInspectSelection() {
    this.selectedInspectNode = null;
    if (this.inspectBox) this.inspectBox.style.display = 'none';
    if (this.inspectComment) this.inspectComment.style.display = 'none';
  }

  show() {
    if (this.container) this.container.classList.remove('hidden');
    this.#scheduleViewportResize();
    this.startStream();
  }

  hide() {
    if (this.container) this.container.classList.add('hidden');
    this.stopStream();
  }

  startStream() {
    if (this.isStreaming) return;
    this.isStreaming = true;
    const generation = ++this.streamGeneration;
    this.#pollFrames(generation);
  }

  stopStream() {
    this.isStreaming = false;
    this.streamGeneration++;
    if (this.fetchAbortController) {
      this.fetchAbortController.abort();
      this.fetchAbortController = null;
    }
  }

  #scheduleViewportResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const rect = (this.container || this.canvas)?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (Math.abs(width - this.nativeWidth) < 8 && Math.abs(height - this.nativeHeight) < 8) return;
      const q = new URLSearchParams({ width, height });
      if (this.token) q.set('token', this.token);
      fetch('/api/cdp/viewport?' + q.toString(), {
        method: 'POST',
        headers: this.token ? { 'x-sidecar-token': this.token } : {},
      }).catch(() => {});
    }, 140);
  }

  async #pollFrames(generation) {
    while (this.isStreaming && generation === this.streamGeneration) {
      let controller;
      try {
        const query = new URLSearchParams({ since: this.frameSequence });
        if (this.token) query.set('token', this.token);
        const frameUrl = '/api/cdp/frame?' + query.toString();
        controller = new AbortController();
        this.fetchAbortController = controller;
        const res = await fetch(frameUrl, { signal: controller.signal });
        if (res.status === 200) {
          const cType = res.headers.get('content-type') || '';
          if (cType.includes('image')) {
            const blob = await res.blob();
            const bitmap = await createImageBitmap(blob);
            if (bitmap.width && bitmap.height && (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height)) {
              this.nativeWidth = bitmap.width;
              this.nativeHeight = bitmap.height;
              this.canvas.width = bitmap.width;
              this.canvas.height = bitmap.height;
            }
            this.ctx.drawImage(bitmap, 0, 0, this.nativeWidth, this.nativeHeight);
            bitmap.close();
            this.frameCount++;
            this.lastFrameTimestamp = Date.now();
            this.frameSequence = Number(res.headers.get('x-frame-sequence')) || (this.frameSequence + 1);
          }
        }
      } catch (err) {
        if (!this.isStreaming || generation !== this.streamGeneration) break;
        await new Promise(r => setTimeout(r, 200));
      } finally {
        if (controller && this.fetchAbortController?.signal === controller.signal) this.fetchAbortController = null;
      }
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
      const response = await fetch('/api/cdp/start?' + q.toString(), {
        headers: this.token ? { 'x-sidecar-token': this.token } : {},
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'No se pudo navegar');
      this.currentUrl = result.url || url;
      this.show();
      return result;
    } catch (err) {
      console.error('[CDP Navigate Error]:', err);
      throw err;
    }
  }
}

window.cdpStreamView = new CdpStreamView();
