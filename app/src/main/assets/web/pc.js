/* BoardLink — PC page (main menu, board, video + draw) */
(() => {
  'use strict';
  const BL = window.BoardLink;
  const $ = (s) => document.querySelector(s);
  BL.mountIcons();

  const cid = 'p-' + BL.uid();
  const send = BL.createSender(cid);
  let state = { mode: 'menu', bg: 'white', videoAspect: 16 / 9, layers: { board: [], video: [] } };
  let view = 'menu';
  let tablets = 0, online = false;

  const board = new BL.Surface($('#boardSurface'));
  const annot = new BL.Surface($('#annotSurface'));
  annot.setBg('none');


  /* ------------------------------ views ------------------------------ */
  function show(name, push = true) {
    view = name;
    for (const v of ['menu', 'board', 'video']) $('#' + v).hidden = v !== name;
    state.mode = name;
    send({ t: 'mode', mode: name, videoAspect: state.videoAspect });
    if (push) history.replaceState(null, '', name === 'menu' ? '/' : '#' + name);
    if (name === 'board') layoutBoard();
    if (name === 'video') layoutAnnot();
  }
  $('#goBoard').onclick = () => show('board');
  $('#goVideo').onclick = () => show('video');
  document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); show('menu'); }));
  document.querySelectorAll('[data-fs]').forEach((b) => (b.onclick = () => {
    const el = $(b.dataset.fs);
    if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {});
  }));

  /* --------------------------- connection ---------------------------- */
  function connect() {
    const es = new EventSource('/api/stream?role=pc&cid=' + cid);
    es.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      for (const ev of msg.events || []) handle(ev);
    };
    es.onerror = () => { online = false; paintStatus(); };
  }
  let first = true;
  function handle(ev) {
    switch (ev.t) {
      case 'hello':
        online = true;
        state = ev.state;
        board.setSize(BL.layerSize('board', state));
        board.setBg(state.bg);
        board.setObjects(state.layers.board);
        annot.setSize(BL.layerSize('video', state));
        annot.setObjects(state.layers.video);
        paintBg(); paintHint();
        if (first) { first = false; const h = location.hash.slice(1); show(h === 'board' || h === 'video' ? h : 'menu', false); }
        else send({ t: 'mode', mode: view, videoAspect: state.videoAspect });
        break;
      case 'presence': tablets = ev.tablets; break;
      case 'bg': state.bg = ev.value; board.setBg(ev.value); paintBg(); break;
      case 'video': remoteVideo(ev.action); break;
      default:
        if (ev.layer === 'board') { board.apply(ev); state.layers.board = board.objects; paintHint(); }
        else if (ev.layer === 'video') {
          annot.apply(ev); state.layers.video = annot.objects;
          if ((ev.t === 'begin' || ev.t === 'add') && view === 'video' && hasVideo && $('#annot').hidden) openAnnot(true);
        }
    }
    paintStatus();
  }

  function paintStatus() {
    const tab = $('#pillTab');
    const ok = online && tablets > 0;
    tab.className = 'pill ' + (ok ? 'ok' : 'bad');
    $('#tabText').textContent = ok ? `Tablet connected · ${location.hostname}`
      : online ? 'Open the BoardLink app on the tablet' : 'Tablet not reachable — check the cable / USB tethering';
    for (const id of ['#boardPill', '#videoPill']) {
      const p = $(id); p.className = 'mini-pill ' + (ok ? 'ok' : 'bad');
      p.querySelector('em').textContent = ok ? 'tablet connected' : 'tablet not connected';
    }
  }

  /* --------------------------- AI settings --------------------------- */
  const aiModal = $('#aiModal');
  async function loadAI() {
    try {
      const d = await (await fetch('/api/settings')).json();
      $('#aiKeyState').textContent = d.hasKey ? `A key is saved (${d.keyHint}). Leave empty to keep it.` : 'No key saved yet.';
      $('#aiModel').value = d.model || '';
    } catch { $('#aiKeyState').textContent = 'Tablet not reachable.'; }
  }
  $('#aiSetBtn').onclick = () => { aiModal.hidden = false; $('#aiKey').value = ''; loadAI(); setTimeout(() => $('#aiKey').focus(), 50); };
  $('#aiCancel').onclick = () => (aiModal.hidden = true);
  aiModal.addEventListener('click', (e) => { if (e.target === aiModal) aiModal.hidden = true; });
  $('#aiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { model: $('#aiModel').value.trim() };
    if ($('#aiKey').value.trim()) body.apiKey = $('#aiKey').value.trim();
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw 0;
      aiModal.hidden = true; toast('AI settings saved on the tablet');
    } catch { toast('Could not save — is the tablet connected?'); }
  });

  /* ------------------------------ board ------------------------------ */
  const boardStage = $('#boardStage');
  function layoutBoard() { if (view === 'board') board.fit(boardStage.clientWidth - 40, boardStage.clientHeight - 40); }
  new ResizeObserver(layoutBoard).observe(boardStage);
  function paintBg() { document.querySelectorAll('#bgSeg button').forEach((b) => b.classList.toggle('on', b.dataset.bg === state.bg)); }
  function paintHint() { $('#boardHint').hidden = board.objects.length > 0; }
  $('#bgSeg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.bg = b.dataset.bg; board.setBg(state.bg); paintBg();
    send({ t: 'bg', value: state.bg });
  };
  $('#boardClear').onclick = () => {
    if (!board.objects.length || !confirm('Clear the whole board?')) return;
    const ev = { t: 'clear', layer: 'board' }; board.apply(ev); state.layers.board = board.objects; send(ev); paintHint();
  };
  $('#boardSave').onclick = () => download(board.composite(1.25), 'board');

  function download(canvas, name) {
    const a = document.createElement('a');
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    a.download = `boardlink-${name}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    toast('Saved to your Downloads folder');
  }

  /* ------------------------------ video ------------------------------ */
  const vid = $('#vid'), vstage = $('#videoStage');
  let hasVideo = false, videoUrl = null;
  function loadVideo(file) {
    if (!file) return;
    const okType = (file.type || '').startsWith('video/') || /\.(mp4|webm|mkv|mov|m4v|ogv|ogg|avi)$/i.test(file.name);
    if (!okType) { toast('That file is not a video'); return; }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    vid.src = videoUrl;
    vid.hidden = false; $('#drop').hidden = true; $('#annotBtn').hidden = false;
    $('#videoName').textContent = file.name;
    hasVideo = true;
    vid.play().catch(() => {});
  }
  for (const id of ['#videoInput', '#videoInput2']) $(id).addEventListener('change', (e) => { loadVideo(e.target.files[0]); e.target.value = ''; });
  vstage.addEventListener('dragover', (e) => { e.preventDefault(); vstage.classList.add('dragging'); });
  vstage.addEventListener('dragleave', (e) => { if (e.target === vstage) vstage.classList.remove('dragging'); });
  vstage.addEventListener('drop', (e) => {
    e.preventDefault(); vstage.classList.remove('dragging');
    const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadVideo(f);
  });
  vid.addEventListener('loadedmetadata', () => {
    if (vid.videoWidth && vid.videoHeight) {
      state.videoAspect = vid.videoWidth / vid.videoHeight;
      annot.setSize(BL.layerSize('video', state));
      send({ t: 'mode', mode: view, videoAspect: state.videoAspect });
    }
    layoutAnnot();
  });
  vid.addEventListener('error', () => toast('Chrome cannot play this video format. Try MP4 (H.264) or WebM.'));
  function paintPlay() { const b = $('#abPlay'); b.innerHTML = BL.icon(vid.paused ? 'play' : 'pause'); }
  vid.addEventListener('play', () => { send({ t: 'vstate', playing: true }); paintPlay(); });
  vid.addEventListener('pause', () => { send({ t: 'vstate', playing: false }); paintPlay(); });
  $('#abPlay').onclick = () => remoteVideo('toggle');
  function remoteVideo(action) {
    if (!hasVideo) return;
    if (action === 'toggle') vid.paused ? vid.play().catch(() => {}) : vid.pause();
    else if (action === 'back') vid.currentTime = Math.max(0, vid.currentTime - 10);
    else if (action === 'fwd') vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 10);
  }

  /* -------------------------- drawing window ------------------------- */
  const annotEl = $('#annot'), annotBody = $('#annotBody');
  let annotMode = 'over'; // "over" = on top of the video, "win" = floating window
  function openAnnot(auto) {
    annotEl.hidden = false; $('#annotBar').hidden = false; $('#annotBtn').classList.add('on');
    layoutAnnot();
    if (auto) toast('Drawing from the tablet — drawing window opened');
  }
  function closeAnnot() { annotEl.hidden = true; $('#annotBar').hidden = true; $('#annotBtn').classList.remove('on'); }
  $('#annotBtn').onclick = () => (annotEl.hidden ? openAnnot() : closeAnnot());
  $('#abClose').onclick = closeAnnot;
  $('#abMode').onclick = () => {
    annotMode = annotMode === 'over' ? 'win' : 'over';
    annotEl.className = 'annot ' + annotMode;
    if (annotMode === 'win') {
      const sr = vstage.getBoundingClientRect();
      annotEl.style.width = '520px'; annotEl.style.height = '330px';
      annotEl.style.left = Math.max(10, sr.width - 620) + 'px'; annotEl.style.top = Math.max(70, sr.height - 440) + 'px';
      annot.setBg('white');
      toast('Floating window: the video keeps playing behind it');
    } else { annot.setBg('none'); toast('Drawing directly over the video'); }
    layoutAnnot();
  };
  function videoRect() {
    const sw = vstage.clientWidth, sh = vstage.clientHeight;
    const vw = vid.videoWidth || 16, vh = vid.videoHeight || 9;
    const k = Math.min(sw / vw, sh / vh);
    const w = vw * k, h = vh * k;
    return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
  }
  function layoutAnnot() {
    if (view !== 'video' || annotEl.hidden) return;
    if (annotMode === 'over') {
      const r = videoRect();
      Object.assign(annotEl.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      annot.fit(r.w, r.h);
    } else {
      annot.fit(annotBody.clientWidth, annotBody.clientHeight);
    }
  }
  new ResizeObserver(layoutAnnot).observe(vstage);
  new ResizeObserver(() => { if (annotMode === 'win') layoutAnnot(); }).observe(annotEl);

  // drag the floating window
  (() => {
    const head = $('#annotHead'); let d = null;
    head.addEventListener('pointerdown', (e) => {
      const r = annotEl.getBoundingClientRect();
      d = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, sr: vstage.getBoundingClientRect() };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!d || d.id !== e.pointerId) return;
      const x = Math.min(Math.max(0, e.clientX - d.sr.left - d.ox), d.sr.width - 80);
      const y = Math.min(Math.max(0, e.clientY - d.sr.top - d.oy), d.sr.height - 40);
      annotEl.style.left = x + 'px'; annotEl.style.top = y + 'px';
    });
    head.addEventListener('pointerup', () => (d = null));
  })();

  // PC drawing tools (mouse / pen tablet on the PC)
  const PCOL = ['#e5383b', '#fcbf49', '#2a9d8f', '#1d4ed8', '#ffffff', '#1b1b1f'];
  const PSIZE = { pen: [3, 6, 12], highlighter: [18, 30, 46], eraser: [20, 44, 90] };
  const ptool = { name: 'pen', color: PCOL[0], sizeIdx: 1 };
  const mine = [];
  PCOL.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'ab-sw'; b.style.background = c; b.dataset.c = c; b.title = c;
    b.onclick = () => { ptool.color = c; if (ptool.name === 'eraser') setPTool('pen'); paintPTools(); };
    $('#abColors').append(b);
  });
  [0, 1, 2].forEach((i) => {
    const b = document.createElement('button');
    b.className = 'ab-size'; b.innerHTML = `<i style="width:${5 + i * 5}px;height:${5 + i * 5}px"></i>`;
    b.onclick = () => { ptool.sizeIdx = i; paintPTools(); };
    $('#abSizes').append(b);
  });
  document.querySelectorAll('[data-ptool]').forEach((b) => (b.onclick = () => setPTool(b.dataset.ptool)));
  function setPTool(n) { ptool.name = n; paintPTools(); }
  function paintPTools() {
    document.querySelectorAll('[data-ptool]').forEach((b) => b.classList.toggle('on', b.dataset.ptool === ptool.name));
    document.querySelectorAll('.ab-sw').forEach((b) => b.classList.toggle('on', b.dataset.c === ptool.color));
    document.querySelectorAll('.ab-size').forEach((b, i) => b.classList.toggle('on', i === ptool.sizeIdx));
  }
  paintPTools();

  let drawing = null;
  const r1 = (v) => Math.round(v * 10) / 10;
  annot.ink.addEventListener('pointerdown', (e) => {
    if (drawing || e.button > 0) return;
    e.preventDefault();
    annot.ink.setPointerCapture(e.pointerId);
    const rect = annot.ink.getBoundingClientRect();
    const [x, y] = annot.toVirtual(e.clientX, e.clientY, rect);
    const id = BL.uid();
    const p = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    const obj = { id, type: 'stroke', tool: ptool.name, color: ptool.color, size: PSIZE[ptool.name][ptool.sizeIdx], pts: [r1(x), r1(y), p] };
    const ev = { t: 'begin', layer: 'video', obj };
    annot.apply(ev); send(ev);
    drawing = { id, pointerId: e.pointerId, rect, lx: x, ly: y };
  });
  annot.ink.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    const pts = [];
    for (const ce of list) {
      const [x, y] = annot.toVirtual(ce.clientX, ce.clientY, drawing.rect);
      if (Math.hypot(x - drawing.lx, y - drawing.ly) < 1.2) continue;
      pts.push(r1(x), r1(y), ce.pointerType === 'pen' ? Math.round((ce.pressure || 0.5) * 100) / 100 : 0.5);
      drawing.lx = x; drawing.ly = y;
    }
    if (pts.length) { const ev = { t: 'pts', layer: 'video', id: drawing.id, pts }; annot.apply(ev); send(ev); }
  });
  const endDraw = (e) => {
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const ev = { t: 'end', layer: 'video', id: drawing.id };
    annot.apply(ev); send(ev); mine.push(drawing.id); drawing = null;
    state.layers.video = annot.objects;
  };
  annot.ink.addEventListener('pointerup', endDraw);
  annot.ink.addEventListener('pointercancel', endDraw);

  $('#abUndo').onclick = () => {
    while (mine.length) {
      const id = mine.pop();
      if (annot.get(id)) { const ev = { t: 'remove', layer: 'video', id }; annot.apply(ev); send(ev); return; }
    }
    toast('Nothing to undo here (use Undo on the tablet for tablet drawings)');
  };
  $('#abClear').onclick = () => {
    if (!annot.objects.length) return;
    const ev = { t: 'clear', layer: 'video' }; annot.apply(ev); state.layers.video = annot.objects; send(ev);
  };
  $('#abShot').onclick = () => {
    if (!hasVideo || !vid.videoWidth) return;
    const W = Math.min(vid.videoWidth, 1920), H = Math.round(W * vid.videoHeight / vid.videoWidth);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(vid, 0, 0, W, H);
    ctx.drawImage(annot.composite(W / annot.size.w, 'none'), 0, 0, W, H);
    download(c, 'video-frame');
  };

  /* ------------------------------ misc ------------------------------- */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (view === 'video' && hasVideo) {
      if (e.code === 'Space' && e.target !== vid) { e.preventDefault(); remoteVideo('toggle'); }
      if (e.key.toLowerCase() === 'd') annotEl.hidden ? openAnnot() : closeAnnot();
    }
    if (e.key === 'Escape' && !aiModal.hidden) { aiModal.hidden = true; return; }
    if (e.key === 'Escape' && !document.fullscreenElement && view !== 'menu' && annotEl.hidden) show('menu');
  });
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  paintStatus();
  connect();
})();
