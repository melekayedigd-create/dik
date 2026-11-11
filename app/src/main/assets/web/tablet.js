/* BoardLink — tablet app */
(() => {
  'use strict';
  const BL = window.BoardLink;
  const $ = (s) => document.querySelector(s);
  BL.mountIcons();

  const store = {
    get(k, d) { try { const v = localStorage.getItem('bl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('bl.' + k, JSON.stringify(v)); } catch {} },
  };

  const isApp = !!window.AndroidBridge;
  const cid = 't-' + BL.uid();
  const send = BL.createSender(cid);
  const surface = new BL.Surface($('#surface'));

  let state = { mode: 'menu', bg: 'white', videoAspect: 16 / 9, layers: { board: [], video: [] } };
  let layer = 'board';
  let connected = false, pcs = 0, ips = [];
  const history = { board: { undo: [], redo: [] }, video: { undo: [], redo: [] } };

  /* ------------------------------ tools ------------------------------ */
  const COLORS = ['#1b1b1f', '#ffffff', '#e5383b', '#f77f00', '#fcbf49', '#2a9d8f', '#1d4ed8', '#7b2cbf'];
  const SIZES = { pen: [2, 4, 7, 12, 20], highlighter: [14, 22, 32, 44, 60], eraser: [16, 30, 50, 80, 120], text: [26, 38, 54, 74, 104] };
  const tool = { name: 'pen', color: store.get('color', COLORS[0]), sizeIdx: store.get('size', 1) };
  let stylusOnly = store.get('stylusOnly', false);
  const sizeFor = (name) => SIZES[name] ? SIZES[name][tool.sizeIdx] : SIZES.pen[tool.sizeIdx];

  // colors
  const colorsEl = $('#colors');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.dataset.color = c; b.title = c;
    b.onclick = () => setColor(c);
    colorsEl.append(b);
  });
  const custom = document.createElement('label');
  custom.className = 'swatch custom'; custom.title = 'Any colour';
  custom.innerHTML = '<input type="color" id="customColor">';
  colorsEl.append(custom);
  $('#customColor').addEventListener('input', (e) => setColor(e.target.value));

  function setColor(c) {
    tool.color = c; store.set('color', c);
    colorsEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.color === c || (s.classList.contains('custom') && !COLORS.includes(c))));
    if (tool.name === 'eraser' || tool.name === 'move') setTool('pen');
    paintSizes();
  }

  // sizes
  const sizesEl = $('#sizes');
  [0, 1, 2, 3, 4].forEach((i) => {
    const b = document.createElement('button');
    b.className = 'size'; b.title = 'Size ' + (i + 1);
    b.innerHTML = `<i style="width:${4 + i * 3}px;height:${4 + i * 3}px"></i>`;
    b.onclick = () => { tool.sizeIdx = i; store.set('size', i); paintSizes(); };
    sizesEl.append(b);
  });
  function paintSizes() {
    sizesEl.querySelectorAll('.size').forEach((b, i) => {
      b.classList.toggle('on', i === tool.sizeIdx);
      b.querySelector('i').style.background = i === tool.sizeIdx && tool.name !== 'eraser' ? tool.color : '';
    });
  }

  document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  function setTool(name) {
    tool.name = name;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
    document.body.className = 't-' + name;
    if (name !== 'move') select(null);
    if (name !== 'text') closeTextCard();
    paintSizes();
  }

  /* ------------------------------ layout ------------------------------ */
  const stage = $('#stage');
  function layout() {
    const pad = 16;
    surface.fit(stage.clientWidth - pad * 2, stage.clientHeight - pad * 2 - 30);
    placeSelectionUI();
  }
  new ResizeObserver(layout).observe(stage);

  /* --------------------------- connection ---------------------------- */
  function connect() {
    const es = new EventSource('/api/stream?role=tablet&cid=' + cid);
    es.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      for (const ev of msg.events || []) handle(ev);
    };
    es.onerror = () => { connected = false; paintStatus(); };
  }

  function handle(ev) {
    switch (ev.t) {
      case 'hello':
        connected = true;
        state = ev.state;
        setLayer(true);
        break;
      case 'presence': pcs = ev.pcs; break;
      case 'info': ips = ev.ips || []; renderAddrs(); break;
      case 'mode':
        if (ev.mode) state.mode = ev.mode;
        if (ev.videoAspect) state.videoAspect = ev.videoAspect;
        setLayer();
        break;
      case 'bg': state.bg = ev.value; if (layer === 'board') surface.setBg(ev.value); paintBg(); break;
      case 'vstate': paintPlay(ev.playing); break;
      case 'ai': aiInfo = ev; break;
      default:
        if (ev.layer) applyEv(ev);
    }
    paintStatus();
  }

  function applyEv(ev) {
    if (ev.layer === layer) {
      surface.apply(ev);
      state.layers[layer] = surface.objects;
      if (selectedId && !surface.get(selectedId)) select(null);
      else if (selectedId) placeSelectionUI();
    } else if (state.layers[ev.layer]) {
      state.layers[ev.layer] = BL.applyToList(state.layers[ev.layer], ev);
    }
  }

  function setLayer(force) {
    const next = state.mode === 'video' ? 'video' : 'board';
    const size = BL.layerSize(next, state);
    if (!force && next === layer && size.h === surface.size.h) return;
    layer = next;
    select(null); closeTextCard();
    surface.setSize(size);
    surface.setBg(layer === 'board' ? state.bg : 'video');
    surface.setObjects(state.layers[layer]);
    $('#videoCtl').hidden = layer !== 'video';
    $('#bgBtn').hidden = layer !== 'board';
    paintBg(); paintHistory(); layout();
  }

  function mainAddr() { return ips.length ? ips[0].addr : ''; }
  function paintStatus() {
    const el = $('#status'), t = $('#statusText');
    el.classList.remove('ok', 'bad', 'click');
    if (!connected) { el.classList.add('bad'); t.textContent = 'Starting BoardLink…'; return; }
    if (!pcs) {
      el.classList.add('click');
      t.innerHTML = mainAddr()
        ? `PC not connected · on the PC open BoardLink-PC.html and enter <b>${mainAddr()}</b>`
        : 'PC not connected · turn on <b>USB tethering</b> (tap for help)';
      return;
    }
    el.classList.add('ok');
    t.textContent = layer === 'video' ? 'PC connected · drawing on the video' : 'PC connected · drawing on the board';
  }
  $('#status').onclick = () => { if (!pcs) openSettings(); };
  // keep the address up to date (USB tethering can be switched on at any time)
  setInterval(() => {
    if (pcs && ips.length) return;
    fetch('/api/info').then((r) => r.json()).then((d) => { ips = d.ips || []; renderAddrs(); paintStatus(); }).catch(() => {});
  }, 4000);

  /* --------------------------- history ------------------------------- */
  function record(entry) {
    const h = history[layer];
    h.undo.push(entry); if (h.undo.length > 200) h.undo.shift();
    h.redo.length = 0; paintHistory();
  }
  function run(events) { for (const ev of events) { applyEv(ev); send(ev); } }
  function undo() { const h = history[layer], e = h.undo.pop(); if (!e) return; run(e.undo); h.redo.push(e); paintHistory(); }
  function redo() { const h = history[layer], e = h.redo.pop(); if (!e) return; run(e.redo); h.undo.push(e); paintHistory(); }
  function paintHistory() { $('#undoBtn').disabled = !history[layer].undo.length; $('#redoBtn').disabled = !history[layer].redo.length; }
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#clearBtn').onclick = () => {
    if (!surface.objects.length) return;
    if (!confirm(layer === 'video' ? 'Clear all drawings on the video?' : 'Clear the whole board?')) return;
    const before = BL.clone(surface.objects);
    const ev = { t: 'clear', layer };
    run([ev]);
    record({ undo: [{ t: 'restore', layer, objects: before }], redo: [{ t: 'clear', layer }] });
  };

  /* --------------------------- drawing ------------------------------- */
  const ink = surface.ink;
  let active = null;
  const r1 = (v) => Math.round(v * 10) / 10;
  const pressure = (e) => (e.pointerType === 'pen' ? Math.round((e.pressure || 0.5) * 100) / 100 : 0.5);

  ink.addEventListener('pointerdown', (e) => {
    if (active || e.button > 0) return;
    if (stylusOnly && e.pointerType === 'touch') return;
    e.preventDefault();
    const rect = ink.getBoundingClientRect();
    const [x, y] = surface.toVirtual(e.clientX, e.clientY, rect);
    if (tool.name === 'text') { openTextCard(x, y); return; }
    closeTextCard();
    ink.setPointerCapture(e.pointerId);
    if (tool.name === 'move') { startMove(e, x, y, rect); return; }
    const id = BL.uid();
    const obj = { id, type: 'stroke', tool: tool.name, color: tool.color, size: sizeFor(tool.name), pts: [r1(x), r1(y), pressure(e)] };
    const ev = { t: 'begin', layer, obj };
    surface.apply(ev); send(ev);
    active = { kind: 'draw', pointerId: e.pointerId, id, lx: x, ly: y, rect, layer };
  });

  ink.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (active.kind === 'draw') {
      const pts = [];
      for (const ce of list) {
        const [x, y] = surface.toVirtual(ce.clientX, ce.clientY, active.rect);
        if (Math.hypot(x - active.lx, y - active.ly) < 1.2) continue;
        pts.push(r1(x), r1(y), pressure(ce));
        active.lx = x; active.ly = y;
      }
      if (pts.length) { const ev = { t: 'pts', layer: active.layer, id: active.id, pts }; surface.apply(ev); send(ev); }
    } else moveTo(e);
  });

  function finish(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const a = active; active = null;
    if (a.kind === 'draw') {
      const ev = { t: 'end', layer: a.layer, id: a.id };
      surface.apply(ev); send(ev);
      const obj = surface.get(a.id);
      if (obj && a.layer === layer) record({ undo: [{ t: 'remove', layer, id: a.id }], redo: [{ t: 'add', layer, obj: BL.clone(obj) }] });
    } else endMove(a);
  }
  ink.addEventListener('pointerup', finish);
  ink.addEventListener('pointercancel', finish);
  ink.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------ move / resize ---------------------------- */
  let selectedId = null;
  const bbox = (o) => ({ x: o.x, y: o.y, w: o.w || 0, h: o.h || 0 });
  function hitTest(x, y) {
    const objs = surface.objects;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type !== 'image' && o.type !== 'text') continue;
      const b = bbox(o), m = 10;
      if (x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m) return o;
    }
    return null;
  }
  function select(id) {
    selectedId = id;
    surface.overlay = id ? drawSelection : null;
    surface.requestRender();
    placeSelectionUI();
  }
  function handleRadius() { return 22 * surface.size.w / surface.cssW; }
  function drawSelection(ctx, cssScale) {
    const o = surface.get(selectedId); if (!o) return;
    const b = bbox(o), px = 1 / cssScale;
    ctx.save();
    ctx.strokeStyle = '#e4572e'; ctx.lineWidth = 2 * px; ctx.setLineDash([8 * px, 6 * px]);
    ctx.strokeRect(b.x - 6 * px, b.y - 6 * px, b.w + 12 * px, b.h + 12 * px);
    if (o.type === 'image') {
      ctx.setLineDash([]); ctx.fillStyle = '#e4572e';
      ctx.beginPath(); ctx.arc(b.x + b.w, b.y + b.h, 11 * px, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * px; ctx.stroke();
    }
    ctx.restore();
  }
  function placeSelectionUI() {
    const btn = $('#delSel');
    const o = selectedId && surface.get(selectedId);
    if (!o) { btn.hidden = true; return; }
    const sr = stage.getBoundingClientRect(), wr = surface.ink.getBoundingClientRect();
    const k = wr.width / surface.size.w;
    let left = wr.left - sr.left + (o.x + (o.w || 0)) * k + 10;
    let top = wr.top - sr.top + o.y * k - 50;
    left = Math.min(Math.max(left, 8), sr.width - 48); top = Math.max(top, 44);
    btn.style.left = left + 'px'; btn.style.top = top + 'px'; btn.hidden = false;
  }
  function startMove(e, x, y, rect) {
    const cur = selectedId && surface.get(selectedId);
    if (cur && cur.type === 'image' && Math.hypot(x - (cur.x + cur.w), y - (cur.y + cur.h)) < handleRadius()) {
      active = { kind: 'resize', pointerId: e.pointerId, id: cur.id, sx: x, sy: y, orig: bbox(cur), rect, layer };
      return;
    }
    const hit = hitTest(x, y);
    if (!hit) { select(null); return; }
    select(hit.id);
    active = { kind: 'move', pointerId: e.pointerId, id: hit.id, sx: x, sy: y, orig: bbox(hit), rect, layer };
  }
  function moveTo(e) {
    const [x, y] = surface.toVirtual(e.clientX, e.clientY, active.rect);
    const dx = x - active.sx, dy = y - active.sy, o = active.orig;
    let patch;
    if (active.kind === 'move') patch = { x: r1(o.x + dx), y: r1(o.y + dy) };
    else { const w = Math.max(40, o.w + dx); patch = { w: r1(w), h: r1(w * o.h / o.w) }; }
    active.patch = patch;
    const ev = { t: 'update', layer, id: active.id, patch };
    surface.apply(ev); send(ev); placeSelectionUI();
  }
  function endMove(a) {
    if (!a.patch) return;
    const o = a.orig;
    const before = a.kind === 'move' ? { x: o.x, y: o.y } : { w: o.w, h: o.h };
    record({ undo: [{ t: 'update', layer, id: a.id, patch: before }], redo: [{ t: 'update', layer, id: a.id, patch: a.patch }] });
  }
  $('#delSel').onclick = () => {
    const i = surface.index(selectedId); if (i < 0) return;
    const obj = BL.clone(surface.objects[i]);
    run([{ t: 'remove', layer, id: obj.id }]);
    record({ undo: [{ t: 'add', layer, obj, index: i }], redo: [{ t: 'remove', layer, id: obj.id }] });
    select(null);
  };

  /* ----------------------------- text -------------------------------- */
  const textCard = $('#textCard');
  let textAt = null;
  function openTextCard(x, y) {
    textAt = { x, y };
    const sr = stage.getBoundingClientRect(), wr = ink.getBoundingClientRect();
    const k = wr.width / surface.size.w;
    let left = wr.left - sr.left + x * k, top = wr.top - sr.top + y * k + 12;
    left = Math.min(Math.max(8, left), sr.width - 330); top = Math.min(Math.max(48, top), sr.height - 170);
    textCard.style.left = left + 'px'; textCard.style.top = top + 'px';
    textCard.hidden = false;
    const ta = $('#textInput'); ta.value = ''; ta.style.color = tool.color === '#ffffff' ? '#fff' : '';
    setTimeout(() => ta.focus(), 30);
  }
  function closeTextCard() { textCard.hidden = true; textAt = null; }
  $('#textCancel').onclick = closeTextCard;
  textCard.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#textInput').value.replace(/\s+$/, '');
    if (!text || !textAt) { closeTextCard(); return; }
    addTextObject(text, textAt.x, textAt.y, sizeFor('text'));
    closeTextCard();
  });
  $('#textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) textCard.requestSubmit();
  });
  function addTextObject(text, x, y, size, color = tool.color) {
    const obj = { id: BL.uid(), type: 'text', text, color, size, x: r1(x), y: r1(y) };
    Object.assign(obj, BL.measureText(surface.ctx, obj));
    run([{ t: 'add', layer, obj }]);
    record({ undo: [{ t: 'remove', layer, id: obj.id }], redo: [{ t: 'add', layer, obj: BL.clone(obj) }] });
    return obj;
  }

  /* ----------------------------- images ------------------------------ */
  $('#imgInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    toast('Adding image…');
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const png = file.type === 'image/png' && file.size < 3e6;
      const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.88));
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      if (!res.ok) throw new Error('upload failed');
      const { src } = await res.json();
      const L = surface.size;
      const f = Math.min((L.w * 0.6) / c.width, (L.h * 0.6) / c.height, 2);
      const w = r1(c.width * f), h = r1(c.height * f);
      const obj = { id: BL.uid(), type: 'image', src, x: r1((L.w - w) / 2), y: r1((L.h - h) / 2), w, h };
      run([{ t: 'add', layer, obj }]);
      record({ undo: [{ t: 'remove', layer, id: obj.id }], redo: [{ t: 'add', layer, obj: BL.clone(obj) }] });
      setTool('move'); select(obj.id);
      toast('Image added — drag it, or pull the orange dot to resize');
    } catch (err) {
      toast(connected ? 'Could not add that image' : 'Not connected to the PC');
    }
  });

  /* --------------------------- right bar ----------------------------- */
  const BGS = ['white', 'grid', 'lines', 'dark'];
  const BG_LABEL = { white: 'White', grid: 'Grid', lines: 'Lines', dark: 'Chalk' };
  function paintBg() { $('#bgLabel').textContent = BG_LABEL[state.bg] || 'Page'; }
  $('#bgBtn').onclick = () => {
    const next = BGS[(BGS.indexOf(state.bg) + 1) % BGS.length];
    state.bg = next; surface.setBg(next); paintBg();
    send({ t: 'bg', value: next });
    if (next === 'dark' && tool.color === '#1b1b1f') setColor('#ffffff');
    if (next !== 'dark' && tool.color === '#ffffff') setColor('#1b1b1f');
  };
  $('#vPlay').onclick = () => send({ t: 'video', action: 'toggle' });
  $('#vBack').onclick = () => send({ t: 'video', action: 'back' });
  $('#vFwd').onclick = () => send({ t: 'video', action: 'fwd' });
  function paintPlay(playing) {
    const b = $('#vPlay');
    b.querySelector('svg').outerHTML = BL.icon(playing ? 'pause' : 'play');
    b.querySelector('span').textContent = playing ? 'Pause' : 'Play';
  }
  function paintStylus() { $('#stylusBtn').classList.toggle('on', stylusOnly); }
  $('#stylusBtn').onclick = () => {
    stylusOnly = !stylusOnly; store.set('stylusOnly', stylusOnly); paintStylus();
    toast(stylusOnly ? 'Pen only: finger and palm touches are ignored' : 'Fingers can draw again');
  };
  $('#fsBtn').hidden = isApp;
  $('#fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  /* ------------------------------- AI -------------------------------- */
  let aiInfo = { ready: true };
  const ai = $('#ai'), msgsEl = $('#aiMsgs'), aiText = $('#aiText');
  const chat = [];
  $('#aiSee').checked = store.get('aiSee', false);
  $('#aiSpeak').checked = store.get('aiSpeak', false);
  $('#aiLang').value = store.get('aiLang', (navigator.language || 'fr').startsWith('en') ? 'en-US' : (navigator.language || '').startsWith('ar') ? 'ar-TN' : 'fr-FR');
  $('#aiSee').onchange = (e) => store.set('aiSee', e.target.checked);
  $('#aiSpeak').onchange = (e) => { store.set('aiSpeak', e.target.checked); if (!e.target.checked) stopSpeaking(); };
  $('#aiLang').onchange = (e) => store.set('aiLang', e.target.value);

  function toggleAI(open = ai.hidden) {
    ai.hidden = !open;
    $('#aiBtn').classList.toggle('on', open);
    if (open) closeSettings();
    if (open && !aiInfo.ready && !chat.length) addBubble('error', 'The AI is not set up yet: add your Claude API key in Settings (gear button), or from the PC menu → AI settings.');
  }
  $('#aiBtn').onclick = () => toggleAI();
  $('#aiClose').onclick = () => toggleAI(false);

  // drag the AI window by its header
  (() => {
    const head = $('#aiHead'); let d = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = ai.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      d = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, sr };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      const x = Math.min(Math.max(0, e.clientX - d.sr.left - d.ox), d.sr.width - ai.offsetWidth);
      const y = Math.min(Math.max(0, e.clientY - d.sr.top - d.oy), d.sr.height - 60);
      ai.style.left = x + 'px'; ai.style.top = y + 'px'; ai.style.right = 'auto';
    });
    head.addEventListener('pointerup', () => (d = null));
  })();

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

  function addBubble(role, text) {
    $('#aiEmpty') && $('#aiEmpty').remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = fmt(text);
    msgsEl.append(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }
  function addActions(el, text) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.innerHTML = `<button data-a="board">${BL.icon('pin')}Put on board</button><button data-a="speak">${BL.icon('volume')}Read</button>`;
    bar.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'board') { putOnBoard(text); toast('Added to the board'); }
      else speak(text);
    };
    el.append(bar);
  }
  function wrap(text, max = 52) {
    const out = [];
    for (const para of text.replace(/\*\*/g, '').split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) {
        if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; }
        else line = (line + ' ' + w).trim();
      }
      out.push(line);
    }
    return out.join('\n');
  }
  function putOnBoard(text) {
    const size = 30;
    const color = layer === 'board' && state.bg === 'dark' ? '#ffffff' : (tool.color === '#ffffff' && state.bg !== 'dark' ? '#1b1b1f' : tool.color);
    const obj = addTextObject(wrap(text), 60, 60, size, color);
    setTool('move'); select(obj.id);
  }
  function speak(text) {
    const clean = text.replace(/\*\*/g, '').replace(/^- /gm, '');
    if (isApp) { window.AndroidBridge.speak(clean, $('#aiLang').value); return; }
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = $('#aiLang').value;
    speechSynthesis.speak(u);
  }
  function stopSpeaking() { if (isApp) window.AndroidBridge.stopSpeaking(); else if ('speechSynthesis' in window) speechSynthesis.cancel(); }
  function boardSnapshot() {
    const c = surface.composite(0.64, layer === 'board' ? state.bg : 'white');
    return c.toDataURL('image/jpeg', 0.8);
  }

  async function askAI(text) {
    chat.push({ role: 'user', content: text });
    addBubble('user', text);
    const pending = addBubble('assistant thinking', 'Thinking');
    try {
      const body = { messages: chat.slice(-20), image: $('#aiSee').checked ? boardSnapshot() : null };
      const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error || 'The AI did not answer.');
      chat.push({ role: 'assistant', content: d.text });
      pending.className = 'msg assistant';
      pending.innerHTML = fmt(d.text);
      addActions(pending, d.text);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      if ($('#aiSpeak').checked) speak(d.text);
    } catch (err) {
      chat.pop();
      pending.className = 'msg error';
      pending.textContent = connected ? err.message : 'Not connected to the PC.';
    }
  }
  $('#aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = aiText.value.trim(); if (!t) return;
    aiText.value = ''; autoGrow();
    askAI(t);
  });
  aiText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aiForm').requestSubmit(); } });
  function autoGrow() { aiText.style.height = 'auto'; aiText.style.height = Math.min(120, aiText.scrollHeight) + 'px'; }
  aiText.addEventListener('input', autoGrow);

  // voice input — native Android speech in the app, Web Speech in a browser
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#aiMic');
  let listening = false, rec = null, finalText = '';
  if (!isApp && !SR) mic.hidden = true;
  function micError(code) {
    toast(code === 'network' ? 'Voice typing needs internet on the tablet'
      : code === 'not-allowed' ? 'Allow the microphone for BoardLink'
      : code === 'no-speech' ? 'I did not hear anything — try again'
      : code === 'unavailable' ? 'Voice typing is not available: install or enable Google voice typing'
      : 'Microphone: ' + code);
  }
  function micEnd() {
    listening = false; rec = null; mic.classList.remove('rec');
    const t = finalText.trim(); finalText = '';
    if (t) { aiText.value = ''; autoGrow(); askAI(t); }
  }
  window.__blSpeech = (type, text) => {
    if (type === 'partial') { aiText.value = text; autoGrow(); }
    else if (type === 'final') { finalText = text; aiText.value = text; autoGrow(); }
    else if (type === 'error') { if (text !== 'no-speech' || !finalText) micError(text); }
    else if (type === 'end') micEnd();
  };
  mic.onclick = () => {
    if (listening) { if (isApp) window.AndroidBridge.stopListening(); else if (rec) rec.stop(); return; }
    stopSpeaking();
    listening = true; finalText = ''; mic.classList.add('rec');
    if (isApp) { window.AndroidBridge.listen($('#aiLang').value); return; }
    rec = new SR();
    rec.lang = $('#aiLang').value; rec.interimResults = true; rec.continuous = false;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      aiText.value = (finalText + interim).trim(); autoGrow();
    };
    rec.onerror = (e) => micError(e.error);
    rec.onend = micEnd;
    rec.start();
  };

  /* ---------------------------- settings ----------------------------- */
  const settings = $('#settings');
  function renderAddrs() {
    const box = $('#addrList');
    if (!box) return;
    if (!ips.length) { box.innerHTML = '<span class="muted small">No address yet — turn on <b>USB tethering</b> (or connect both devices to the same Wi-Fi).</span>'; return; }
    const label = { cable: 'USB cable', wifi: 'Wi-Fi', other: 'network' };
    box.innerHTML = ips.map((a) => `<div class="addr"><b>${a.addr}</b><em>${label[a.kind] || a.kind}</em></div>`).join('');
  }
  async function loadSettings() {
    try {
      const d = await (await fetch('/api/settings')).json();
      $('#keyState').textContent = d.hasKey ? `Key saved (${d.keyHint})` : 'No key yet — the AI window will not answer until you add one.';
      $('#modelInput').value = d.model || '';
    } catch {}
  }
  function openSettings() { toggleAI(false); settings.hidden = false; renderAddrs(); loadSettings(); }
  function closeSettings() { settings.hidden = true; }
  $('#setBtn').onclick = () => (settings.hidden ? openSettings() : closeSettings());
  $('#setClose').onclick = closeSettings;
  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { model: $('#modelInput').value.trim() };
    if ($('#keyInput').value.trim()) body.apiKey = $('#keyInput').value.trim();
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('#keyInput').value = '';
      toast('Settings saved');
      loadSettings();
    } catch { toast('Could not save'); }
  });

  /* ------------------------------ misc ------------------------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  setColor(tool.color);
  setTool('pen');
  paintStylus(); paintHistory(); paintStatus(); layout();
  connect();
})();
