/* BoardLink — drawing engine shared by the tablet app and the PC page */
(function (global) {
  'use strict';

  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif';
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function layerSize(name, state) {
    if (name === 'video') {
      const a = (state && state.videoAspect) || 16 / 9;
      return { w: 1600, h: Math.round(1600 / a) };
    }
    return { w: 1600, h: 1000 };
  }

  /* ---------- images ---------- */
  const imgCache = new Map();
  function getImage(src, onload) {
    let e = imgCache.get(src);
    if (!e) {
      const im = new Image();
      e = { im, ok: false, cbs: [] };
      imgCache.set(src, e);
      im.onload = () => { e.ok = true; const cbs = e.cbs; e.cbs = []; cbs.forEach((f) => f()); };
      im.src = src;
    }
    if (e.ok) return e.im;
    if (onload && !e.cbs.includes(onload)) e.cbs.push(onload);
    return null;
  }

  /* ---------- drawing ---------- */
  const penWidth = (size, p) => size * (0.3 + 1.4 * (p == null ? 0.5 : p)); // p=0.5 -> size

  function drawStroke(ctx, o) {
    const P = o.pts || [], n = Math.floor(P.length / 3);
    if (!n) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (o.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = ctx.fillStyle = '#000'; }
    else { ctx.strokeStyle = ctx.fillStyle = o.color; if (o.tool === 'highlighter') ctx.globalAlpha = 0.38; }
    if (n === 1) {
      const w = o.tool === 'pen' ? penWidth(o.size, P[2]) : o.size;
      ctx.beginPath(); ctx.arc(P[0], P[1], w / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return;
    }
    if (o.tool === 'pen') {
      let px = P[0], py = P[1], mx = px, my = py;
      for (let i = 1; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], p = P[i * 3 + 2];
        const nx = (px + x) / 2, ny = (py + y) / 2;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.quadraticCurveTo(px, py, nx, ny);
        ctx.lineWidth = penWidth(o.size, p); ctx.stroke();
        mx = nx; my = ny; px = x; py = y;
      }
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(px, py); ctx.stroke();
    } else {
      ctx.lineWidth = o.size;
      ctx.beginPath(); ctx.moveTo(P[0], P[1]);
      let px = P[0], py = P[1];
      for (let i = 1; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1];
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x; py = y;
      }
      ctx.lineTo(px, py); ctx.stroke();
    }
    ctx.restore();
  }

  const textLines = (o) => String(o.text || '').split('\n');
  function measureText(ctx, o) {
    ctx.save();
    ctx.font = `600 ${o.size}px ${FONT}`;
    let w = 0;
    const lines = textLines(o);
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    ctx.restore();
    return { w: Math.ceil(w), h: Math.ceil(lines.length * o.size * 1.25) };
  }
  function drawText(ctx, o) {
    ctx.save();
    ctx.font = `600 ${o.size}px ${FONT}`;
    ctx.fillStyle = o.color; ctx.textBaseline = 'top';
    textLines(o).forEach((l, i) => ctx.fillText(l, o.x, o.y + i * o.size * 1.25));
    ctx.restore();
  }
  function drawImageObj(ctx, o, onload) {
    const im = getImage(o.src, onload);
    if (im) ctx.drawImage(im, o.x, o.y, o.w, o.h);
    else { ctx.save(); ctx.fillStyle = 'rgba(127,127,127,.18)'; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.restore(); }
  }
  function drawObject(ctx, o, onload) {
    if (o.type === 'stroke') drawStroke(ctx, o);
    else if (o.type === 'text') drawText(ctx, o);
    else if (o.type === 'image') drawImageObj(ctx, o, onload);
  }

  function drawBackground(ctx, bg, w, h) {
    if (!bg || bg === 'none') return;
    ctx.save();
    if (bg === 'dark') { ctx.fillStyle = '#1f2723'; ctx.fillRect(0, 0, w, h); }
    else if (bg === 'video') {
      ctx.fillStyle = '#2b2f38'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.font = `700 120px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VIDEO', w / 2, h / 2);
    } else {
      ctx.fillStyle = bg === 'lines' ? '#fffdf7' : '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 1.6;
      if (bg === 'grid') {
        ctx.strokeStyle = '#e1e7ef';
        ctx.beginPath();
        for (let x = 50; x < w; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (let y = 50; y < h; y += 50) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
      } else if (bg === 'lines') {
        ctx.strokeStyle = '#cfe0f0';
        ctx.beginPath();
        for (let y = 90; y < h; y += 56) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
        ctx.strokeStyle = '#f2b9b9'; ctx.beginPath(); ctx.moveTo(110, 0); ctx.lineTo(110, h); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---------- list operations (same rules as the server) ---------- */
  function indexOf(list, id) { for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return i; return -1; }
  function applyToList(list, ev) {
    switch (ev.t) {
      case 'begin': case 'add': {
        const o = clone(ev.obj);
        if (typeof ev.index === 'number' && ev.index >= 0 && ev.index <= list.length) list.splice(ev.index, 0, o);
        else list.push(o);
        return list;
      }
      case 'pts': { const i = indexOf(list, ev.id); if (i >= 0) for (const v of ev.pts) list[i].pts.push(v); return list; }
      case 'update': { const i = indexOf(list, ev.id); if (i >= 0) Object.assign(list[i], ev.patch); return list; }
      case 'remove': { const i = indexOf(list, ev.id); if (i >= 0) list.splice(i, 1); return list; }
      case 'clear': list.length = 0; return list;
      case 'restore': return clone(ev.objects || []);
      default: return list;
    }
  }

  /* ---------- Surface: a board area with background + ink canvases ---------- */
  class Surface {
    constructor(wrapper) {
      this.wrap = wrapper;
      wrapper.classList.add('bl-surface');
      this.bgCanvas = document.createElement('canvas');
      this.ink = document.createElement('canvas');
      this.bgCanvas.className = 'bl-bg'; this.ink.className = 'bl-ink';
      wrapper.append(this.bgCanvas, this.ink);
      this.ctx = this.ink.getContext('2d');
      this.cache = document.createElement('canvas');
      this.cctx = this.cache.getContext('2d');
      this.objects = [];
      this.live = new Set();
      this.size = { w: 1600, h: 1000 };
      this.bg = 'white';
      this.scale = 1; this.dpr = 1; this.cssW = 1; this.cssH = 1;
      this.dirty = true; this.frameReq = false;
      this.overlay = null;
      this._imgCb = () => { this.dirty = true; this.requestRender(); };
    }
    setSize(size) {
      if (size.w === this.size.w && size.h === this.size.h) return;
      this.size = size;
      if (this._box) this.fit(this._box[0], this._box[1]);
    }
    setBg(bg) { this.bg = bg; this.drawBg(); }
    fit(boxW, boxH) {
      this._box = [boxW, boxH];
      const a = this.size.w / this.size.h;
      let w = boxW, h = w / a;
      if (h > boxH) { h = boxH; w = h * a; }
      w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.cssW = w; this.cssH = h; this.dpr = dpr;
      this.wrap.style.width = w + 'px'; this.wrap.style.height = h + 'px';
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      for (const c of [this.ink, this.bgCanvas, this.cache]) if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      this.scale = pw / this.size.w;
      this.drawBg();
      this.dirty = true; this.requestRender();
      return { w, h };
    }
    drawBg() {
      const c = this.bgCanvas.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
      c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      drawBackground(c, this.bg, this.size.w, this.size.h);
    }
    setObjects(list) { this.objects = list; this.live.clear(); this.dirty = true; this.requestRender(); }
    index(id) { return indexOf(this.objects, id); }
    get(id) { const i = this.index(id); return i >= 0 ? this.objects[i] : null; }
    apply(ev) {
      if (ev.t === 'begin') { applyToList(this.objects, ev); this.live.add(ev.obj.id); }
      else if (ev.t === 'pts') {
        applyToList(this.objects, ev);
        if (!this.live.has(ev.id)) { this.live.add(ev.id); this.dirty = true; }
      } else if (ev.t === 'end') { this.live.delete(ev.id); this.dirty = true; }
      else if (ev.t === 'restore') { this.objects = applyToList(this.objects, ev); this.live.clear(); this.dirty = true; }
      else { applyToList(this.objects, ev); if (ev.t === 'remove') this.live.delete(ev.id); if (ev.t === 'clear') this.live.clear(); this.dirty = true; }
      this.requestRender();
    }
    requestRender() {
      if (this.frameReq) return;
      this.frameReq = true;
      requestAnimationFrame(() => { this.frameReq = false; this.render(); });
    }
    rebuild() {
      const c = this.cctx;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.cache.width, this.cache.height);
      c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      for (const o of this.objects) if (!this.live.has(o.id)) drawObject(c, o, this._imgCb);
      this.dirty = false;
    }
    render() {
      if (this.dirty) this.rebuild();
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.ink.width, this.ink.height);
      c.drawImage(this.cache, 0, 0);
      c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      if (this.live.size) for (const o of this.objects) if (this.live.has(o.id)) drawObject(c, o, this._imgCb);
      if (this.overlay) this.overlay(c, this.scale / this.dpr);
    }
    toVirtual(clientX, clientY, rect) {
      const r = rect || this.ink.getBoundingClientRect();
      return [(clientX - r.left) / r.width * this.size.w, (clientY - r.top) / r.height * this.size.h];
    }
    /** full-resolution picture (background + ink) */
    composite(scale = 1, bg = this.bg) {
      const W = Math.round(this.size.w * scale), H = Math.round(this.size.h * scale);
      const ink = document.createElement('canvas'); ink.width = W; ink.height = H;
      const ic = ink.getContext('2d'); ic.setTransform(scale, 0, 0, scale, 0, 0);
      for (const o of this.objects) drawObject(ic, o);
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const oc = out.getContext('2d'); oc.setTransform(scale, 0, 0, scale, 0, 0);
      drawBackground(oc, bg, this.size.w, this.size.h);
      oc.setTransform(1, 0, 0, 1, 0, 0); oc.drawImage(ink, 0, 0);
      return out;
    }
  }

  /* ---------- icons (inline SVG) ---------- */
  const ICONS = {
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    move: '<path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
    play: '<polygon points="7 4 20 12 7 20 7 4"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    back: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    fwd: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><path d="M12 17v5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
    board: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    pin: '<path d="M12 17v5"/><path d="M5 17h14l-2-4V5H7v8Z"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    usb: '<circle cx="10" cy="7" r="1"/><circle cx="4" cy="20" r="1"/><path d="M4.7 19.3 19 5"/><path d="m21 3-3 1 2 2Z"/><path d="M9.26 7.68 5 12l2 5"/><path d="m10 14 5 2 3.5-3.5"/><path d="m18 12 1-1 1 1-1 1Z"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  function mountIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      if (!el.querySelector(':scope > svg')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    });
  }

  /* ---------- network: ordered, batched event sender ---------- */
  function createSender(cid) {
    let queue = [], sending = false, timer = null;
    function flush() {
      timer = null;
      if (sending || !queue.length) return;
      sending = true;
      const events = queue; queue = [];
      fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid, events }) })
        .catch(() => {})
        .finally(() => { sending = false; if (queue.length) schedule(0); });
    }
    function schedule(ms) { if (!timer) timer = setTimeout(flush, ms); }
    return function send(ev) {
      const last = queue[queue.length - 1];
      if (last && ev.t === 'pts' && last.t === 'pts' && last.id === ev.id) last.pts = last.pts.concat(ev.pts);
      else if (last && ev.t === 'update' && last.t === 'update' && last.id === ev.id) last.patch = { ...last.patch, ...ev.patch };
      else queue.push(ev.t === 'begin' || ev.t === 'add' ? { ...ev, obj: clone(ev.obj) } : ev.t === 'pts' ? { ...ev, pts: ev.pts.slice() } : ev);
      schedule(16);
    };
  }

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);

  global.BoardLink = { Surface, layerSize, drawObject, drawBackground, measureText, applyToList, getImage, icon, mountIcons, createSender, uid, clone, FONT };
})(window);
