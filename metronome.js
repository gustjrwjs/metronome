// 개인용 메트로놈 — Web Audio 미리 예약(lookahead) 방식으로 정확한 박자를 냅니다.
(() => {
  'use strict';

  // ---------- 소리 합성 (AudioContext / OfflineAudioContext 공용) ----------
  // level: 2 = 강박, 1 = 약박, 0.5 = 세분 박
  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
      b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(ctx, b);
    }
    return b;
  }

  function env(ctx, t, peak, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    return g;
  }

  function tone(ctx, out, t, type, freq, peak, decay) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = env(ctx, t, peak, decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.02);
    return o;
  }

  // 강박은 음이 높고 크게, 약박은 중간, 세분 박은 작게. 최대 진폭은 0.9 이하(클리핑 방지)
  const amp = (lv) => (lv === 2 ? 1 : lv === 1 ? 0.6 : 0.3);
  const SOUNDS = {
    click(ctx, out, t, lv) {
      const f = lv === 2 ? 2000 : lv === 1 ? 1400 : 1000;
      tone(ctx, out, t, 'square', f, 0.55 * amp(lv), 0.03);
    },
    wood(ctx, out, t, lv) {
      const f = lv === 2 ? 1250 : lv === 1 ? 900 : 750;
      tone(ctx, out, t, 'sine', f, 0.65 * amp(lv), 0.07);
      tone(ctx, out, t, 'triangle', f * 2.4, 0.2 * amp(lv), 0.025);
    },
    beep(ctx, out, t, lv) {
      const f = lv === 2 ? 1760 : lv === 1 ? 880 : 660;
      tone(ctx, out, t, 'sine', f, 0.8 * amp(lv), 0.09);
    },
    cowbell(ctx, out, t, lv) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = lv === 2 ? 1000 : 800; bp.Q.value = 1.5;
      bp.connect(out);
      const k = lv === 2 ? 1.25 : 1;
      tone(ctx, bp, t, 'square', 540 * k, 0.45 * amp(lv), 0.18);
      tone(ctx, bp, t, 'square', 800 * k, 0.45 * amp(lv), 0.18);
    },
    hihat(ctx, out, t, lv) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      const decay = lv === 2 ? 0.12 : lv === 1 ? 0.05 : 0.03;
      const g = env(ctx, t, 0.6 * amp(lv), decay);
      src.connect(hp).connect(g).connect(out);
      src.start(t);
      src.stop(t + decay + 0.02);
    },
  };

  // 폴리리듬용 소리: 메인 소리와 섞여도 구분되게 높고 맑은 음
  function polySound(ctx, out, t) {
    tone(ctx, out, t, 'triangle', 2350, 0.32, 0.05);
    tone(ctx, out, t, 'sine', 3520, 0.12, 0.03);
  }

  // ---------- 박자표 ----------
  const SIGS = ['1/4', '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '2/2', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'];
  const beatsOf = (sig) => Number(sig.split('/')[0]);
  function defaultPattern(sig) {
    const [n, d] = sig.split('/').map(Number);
    const p = Array(n).fill(1);
    p[0] = 2;
    if (d === 8 && n % 3 === 0 && n > 3) for (let i = 3; i < n; i += 3) p[i] = 2; // 6/8, 9/8, 12/8
    return p;
  }
  // 박 묶음 후보: 2·3으로 나누는 방법 (4/4 → 2+2, 7/8 → 2+2+3 …), 짧은 것부터 최대 6개
  function groupings(n) {
    const res = [];
    (function rec(rem, acc) {
      if (rem === 0) { if (acc.length > 1) res.push(acc); return; }
      for (const part of [2, 3]) if (part <= rem) rec(rem - part, [...acc, part]);
    })(n, []);
    if (n % 4 === 0 && n > 4) res.push(Array(n / 4).fill(4));
    res.sort((x, y) => x.length - y.length);
    return res.slice(0, 6).map((g) => g.join('+'));
  }
  function patternFromGrouping(g) {
    const p = [];
    for (const part of g.split('+').map(Number)) { p.push(2); for (let i = 1; i < part; i++) p.push(1); }
    return p;
  }

  // ---------- 리듬(한 박 나누기) ----------
  // offs: 한 박 안에서 각 음의 위치(0~1). 스윙은 state.swing 비율 사용
  const even = (n) => Array.from({ length: n }, (_, k) => k / n);
  const SUBDIVS = {
    '1': { name: '없음', offs: () => [0] },
    '2': { name: '8분', offs: () => even(2) },
    '3': { name: '셋잇단', offs: () => even(3) },
    '4': { name: '16분', offs: () => even(4) },
    swing: { name: '스윙', offs: (s) => [0, s.swing] },
    dotted: { name: '점8분', offs: () => [0, 0.75] },
    '5': { name: '5잇단', offs: () => even(5) },
    '6': { name: '6잇단', offs: () => even(6) },
    '7': { name: '7잇단', offs: () => even(7) },
  };
  const SUB_ORDER = ['1', '2', '3', '4', 'swing', 'dotted', '5', '6', '7'];
  const tickCount = (sub) => SUBDIVS[sub].offs({ swing: 0.6 }).length;

  // ---------- 상태 ----------
  const STORE = 'metronome.settings.v1';
  const PSTORE = 'metronome.presets.v1';
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // 예전 저장값(sub 하나)도 새 구조(박마다 subs, masks)로 맞춰 줌
  function normalize(s) {
    if (!SIGS.includes(s.sig)) s.sig = '4/4';
    const n = beatsOf(s.sig);
    if (!Array.isArray(s.pattern) || s.pattern.length !== n) s.pattern = defaultPattern(s.sig);
    const fallback = SUBDIVS[String(s.sub)] ? String(s.sub) : '1';
    const subs = Array.isArray(s.subs) ? s.subs : [];
    s.subs = Array.from({ length: n }, (_, i) => (SUBDIVS[subs[i]] ? subs[i] : SUBDIVS[subs[0]] ? subs[0] : fallback));
    const masks = Array.isArray(s.masks) ? s.masks : [];
    s.masks = s.subs.map((sub, i) => (Array.isArray(masks[i]) && masks[i].length === tickCount(sub) ? masks[i].map(Boolean) : null));
    delete s.sub;
    s.swing = Math.min(0.75, Math.max(0.5, Number(s.swing) || 2 / 3));
    s.poly = Number(s.poly) || 0;
    s.grouping = typeof s.grouping === 'string' ? s.grouping : '';
    return s;
  }

  const state = normalize(Object.assign(
    { bpm: 120, sig: '4/4', sound: 'click', accentFirst: true, vol: 80 },
    load(STORE, {})
  ));
  const persist = () => save(STORE, state);

  // ---------- 소리 낼 시점 계산 ----------
  // 한 박 안의 음들: [{t, level, beat, idx}] (level 2=강박, 1=약박, 0.5=세분, 0=무음)
  function beatEvents(s, beat, tBeat, beatDur) {
    const p = s.pattern[beat], mask = s.masks[beat];
    return SUBDIVS[s.subs[beat]].offs(s).map((o, i) => {
      let level = i === 0 ? (p === 2 && !s.accentFirst ? 1 : p) : p === 0 ? 0 : 0.5;
      if (mask && !mask[i]) level = 0;
      return { t: tBeat + o * beatDur, level, beat, idx: i };
    });
  }
  // 폴리리듬: 한 마디 동안 poly번을 고르게
  function polyEvents(s, tBar, barDur) {
    if (!s.poly) return [];
    return Array.from({ length: s.poly }, (_, k) => ({ t: tBar + (k * barDur) / s.poly, kind: 'poly' }));
  }
  // 오프라인 렌더링/테스트용: t0부터 duration 동안의 모든 음
  function eventsFor(s, t0, duration) {
    const out = [], beatDur = 60 / s.bpm, n = s.pattern.length;
    for (let b = 0, t = t0; t < t0 + duration; b++, t += beatDur) {
      const beat = b % n;
      if (beat === 0) out.push(...polyEvents(s, t, beatDur * n));
      out.push(...beatEvents(s, beat, t, beatDur).map((e) => ({ ...e, kind: 'main' })));
    }
    return out.filter((e) => e.t < t0 + duration).sort((x, y) => x.t - y.t);
  }

  // ---------- 스케줄러 ----------
  let ctx = null, master = null, bus = null;
  let running = false, timer = null;
  let nextTime = 0, curBeat = 0;
  const LOOKAHEAD_MS = 25, AHEAD_S = 0.12;
  const visualQueue = [];
  const log = []; // 테스트용 예약 기록 (최근 2000개)
  const pushLog = (e) => { log.push(e); if (log.length > 2000) log.shift(); };

  // 아이폰: 무음(진동) 모드면 Web Audio 소리가 꺼짐 → '미디어 재생'으로 취급되게 함
  //  1) iOS 17+ : navigator.audioSession.type = 'playback'
  //  2) 그 이하/카톡 같은 앱 내 브라우저: 소리 없는 <audio>를 반복 재생해 두면 미디어 채널로 바뀜
  let silentEl = null;
  function silentWavUrl() {
    const n = 4410, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }
  function unlockIOS() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    try {
      if (!silentEl) {
        silentEl = document.createElement('audio');
        silentEl.src = silentWavUrl();
        silentEl.loop = true;
        silentEl.setAttribute('playsinline', '');
        silentEl.setAttribute('webkit-playsinline', '');
      }
      const p = silentEl.play(); if (p) p.catch(() => {});
    } catch {}
    // 사용자 터치 안에서 아주 짧은 무음 버퍼를 한 번 재생해야 소리가 열리는 iOS 버전 대응
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination); src.start(0);
    } catch {}
  }

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    master.gain.value = state.vol / 100;
    unlockIOS();
    if (ctx.state !== 'running') ctx.resume();
  }

  function scheduler() {
    // 화면이 가려지면 브라우저가 타이머를 늦추므로 더 멀리(1.5초) 미리 예약
    const ahead = document.hidden ? 1.5 : AHEAD_S;
    // 타이머가 크게 밀렸으면 지난 박을 몰아서 치지 않고 지금부터 다시 맞춤
    if (nextTime < ctx.currentTime - 0.05) nextTime = ctx.currentTime + 0.02;
    while (nextTime < ctx.currentTime + ahead) {
      if (curBeat >= state.pattern.length) curBeat = 0;
      const beatDur = 60 / state.bpm;
      if (curBeat === 0) {
        for (const e of polyEvents(state, nextTime, beatDur * state.pattern.length)) {
          polySound(ctx, bus, e.t);
          pushLog({ t: e.t, kind: 'poly', bpm: state.bpm });
        }
      }
      for (const e of beatEvents(state, curBeat, nextTime, beatDur)) {
        if (e.level > 0) SOUNDS[state.sound](ctx, bus, e.t, e.level);
        pushLog({ t: e.t, kind: 'main', beat: e.beat, sub: e.idx, level: e.level, bpm: state.bpm });
      }
      visualQueue.push({ t: nextTime, beat: curBeat });
      nextTime += beatDur;
      curBeat = (curBeat + 1) % state.pattern.length;
    }
  }

  let wakeLock = null;
  async function start() {
    ensureCtx();
    // 정지하면 이미 예약된 음까지 한 번에 끊을 수 있게 매번 새 통로(bus)로 연결
    bus = ctx.createGain();
    bus.connect(master);
    running = true;
    curBeat = 0;
    nextTime = ctx.currentTime + 0.06;
    visualQueue.length = 0;
    scheduler();
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    ui();
  }
  function stop() {
    running = false;
    clearInterval(timer);
    visualQueue.length = 0;
    try { bus?.disconnect(); } catch {}
    bus = null;
    try { silentEl?.pause(); } catch {}
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
    ui();
  }
  document.addEventListener('visibilitychange', async () => {
    if (running && document.visibilityState === 'visible') {
      // 아이폰은 전화·다른 앱 뒤에 소리가 '중단(interrupted)' 상태로 남음 → 다시 켬
      try { if (ctx && ctx.state !== 'running') ctx.resume(); } catch {}
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    }
  });

  // ---------- 화면 ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    beats: $('beats'), bpmNum: $('bpmNum'), tempoName: $('tempoName'), bpmRange: $('bpmRange'),
    play: $('play'), tap: $('tap'), tapReset: $('tapReset'), tapInfo: $('tapInfo'), sig: $('sig'), sub: $('sub'),
    subLabel: $('subLabel'), swingRow: $('swingRow'), swing: $('swing'), swingVal: $('swingVal'),
    grouping: $('grouping'), poly: $('poly'),
    sound: $('sound'), accentFirst: $('accentFirst'), vol: $('vol'), presets: $('presets'), savePreset: $('savePreset'),
    beatPop: $('beatPop'), bpTitle: $('bpTitle'), bpSubs: $('bpSubs'), bpTicks: $('bpTicks'), bpAll: $('bpAll'), bpClose: $('bpClose'),
  };

  function tempoName(b) {
    return b < 40 ? 'Grave' : b < 60 ? 'Largo' : b < 66 ? 'Larghetto' : b < 76 ? 'Adagio' : b < 108 ? 'Andante'
      : b < 120 ? 'Moderato' : b < 156 ? 'Allegro' : b < 176 ? 'Vivace' : b < 200 ? 'Presto' : 'Prestissimo';
  }

  // 세분 버튼 그림 (악보 모양)
  function noteSvg(id) {
    const head = (x, r = 4) => `<ellipse cx="${x}" cy="28" rx="${r}" ry="${r * 0.7}" transform="rotate(-20 ${x} 28)"/>`;
    const stem = (x, top, r = 4) => `<rect x="${x + r - 1}" y="${top}" width="1.4" height="${28 - top}"/>`;
    const num = (x, n) => `<text x="${x}" y="8.5" font-size="9" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">${n}</text>`;
    const beam = (x1, x2, y) => `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="3"/>`;
    let g = '';
    if (id === '1') {
      g = head(19) + stem(19, 7);
    } else if (id === 'swing') {
      // 4분 + 8분을 셋잇단 괄호로 묶은 모양 (스윙 표기)
      g = head(11) + stem(11, 11) + head(29) + stem(29, 11);
      g += '<path d="M32.4 11 q6 4 3 10" stroke="currentColor" stroke-width="1.6" fill="none"/>';
      g += '<path d="M14 10 v-2.5 h18 v2.5" stroke="currentColor" stroke-width="1" fill="none"/>' + num(23, 3).replace('y="8.5"', 'y="6.5"');
    } else if (id === 'dotted') {
      g = head(10) + stem(10, 11) + '<circle cx="17" cy="29" r="1.6"/>' + head(30) + stem(30, 11);
      g += beam(13, 34.4, 11) + beam(28, 34.4, 16.5);
    } else {
      const n = Number(id), r = n >= 5 ? 3.2 : 4;
      const xs = { 2: [12, 28], 3: [7, 19, 31], 4: [5, 14.5, 24, 33.5] }[n] || Array.from({ length: n }, (_, k) => 4 + (k * 33) / (n - 1));
      for (const x of xs) g += head(x, r) + stem(x, 11, r);
      const x1 = xs[0] + r - 1, x2 = xs[xs.length - 1] + r + 0.4;
      g += beam(x1, x2, 11);
      if (n >= 4) g += beam(x1, x2, 16.5);
      if (n === 3 || n >= 5) g += num((x1 + x2) / 2, n);
    }
    return `<svg viewBox="0 0 44 34" fill="currentColor" aria-hidden="true">${g}</svg>`;
  }

  const allSame = () => state.subs.every((x) => x === state.subs[0]) && state.masks.every((m) => !m);
  function setAllSubs(id) {
    state.subs = state.subs.map(() => id);
    state.masks = state.masks.map(() => null);
    persist(); renderBeats(); ui();
  }
  function fillSubButtons(container, current, onPick) {
    container.innerHTML = '';
    for (const id of SUB_ORDER) {
      const b = document.createElement('button');
      b.dataset.v = id;
      b.setAttribute('role', 'radio');
      b.title = SUBDIVS[id].name;
      b.innerHTML = `${noteSvg(id)}<span>(${SUBDIVS[id].name})</span>`;
      b.classList.toggle('sel', id === current);
      b.setAttribute('aria-checked', id === current);
      b.onclick = (e) => { e.stopPropagation(); onPick(id); };
      container.appendChild(b);
    }
    // 선택된 게 화면 밖이면 보이게 넘겨 줌
    const sel = container.querySelector('.sel');
    if (sel) container.scrollLeft = Math.max(0, sel.offsetLeft - container.offsetLeft - 8);
  }
  function renderSubs() { fillSubButtons(els.sub, allSame() ? state.subs[0] : null, setAllSubs); }

  // 박 점: 누르면 강박→약박→무음, 길게 누르면(또는 우클릭) 그 박의 리듬 편집
  let dots = [];
  function renderBeats() {
    els.beats.innerHTML = '';
    const mixed = !allSame();
    dots = state.pattern.map((p, i) => {
      const col = document.createElement('div');
      col.className = 'beat-col' + (i > 0 && p === 2 ? ' group-start' : '');
      const d = document.createElement('div');
      d.className = 'dot' + (p === 2 ? ' accent' : p === 0 ? ' mute' : '');
      d.title = `${i + 1}박 (길게 누르면 리듬 편집)`;
      let lpTimer = null, lpFired = false;
      d.addEventListener('pointerdown', () => {
        lpFired = false;
        lpTimer = setTimeout(() => { lpFired = true; openBeatEditor(i); }, 450);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) d.addEventListener(ev, () => clearTimeout(lpTimer));
      d.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(lpTimer); openBeatEditor(i); });
      d.onclick = (e) => {
        if (lpFired) { e.stopPropagation(); lpFired = false; return; }
        state.pattern[i] = state.pattern[i] === 2 ? 1 : state.pattern[i] === 1 ? 0 : 2;
        state.grouping = 'custom';
        persist(); renderBeats(); ui();
      };
      col.appendChild(d);
      if (mixed) {
        const mini = document.createElement('button');
        mini.className = 'mini' + (state.masks[i] ? ' masked' : '');
        mini.title = `${i + 1}박 리듬: ${SUBDIVS[state.subs[i]].name}`;
        mini.innerHTML = noteSvg(state.subs[i]);
        mini.onclick = (e) => { e.stopPropagation(); openBeatEditor(i); };
        col.appendChild(mini);
      }
      els.beats.appendChild(col);
      return d;
    });
    fitDots();
  }
  // 박이 많으면(7/8, 12/8 …) 점을 줄여서 한 줄에 들어가게
  function fitDots() {
    const n = dots.length, cs = getComputedStyle(els.beats);
    const w = els.beats.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!w) return;
    const gap = n > 5 ? 5 : 8, groups = els.beats.querySelectorAll('.group-start').length;
    const size = Math.floor((w - gap * (n - 1) - groups * 6) / n);
    els.beats.style.gap = gap + 'px';
    els.beats.style.setProperty('--dot-fit', Math.max(22, size) + 'px');
  }
  addEventListener('resize', fitDots);

  // 박 리듬 편집 창: 세분 고르기 + 소리 낼 음 고르기(골라 치기)
  let editBeat = -1;
  function openBeatEditor(i) {
    editBeat = i;
    els.beatPop.hidden = false;
    renderBeatEditor();
  }
  function renderBeatEditor() {
    const i = editBeat;
    if (i < 0 || i >= state.subs.length) { els.beatPop.hidden = true; return; }
    els.bpTitle.textContent = `${i + 1}박 리듬`;
    fillSubButtons(els.bpSubs, state.subs[i], (id) => {
      state.subs[i] = id; state.masks[i] = null;
      persist(); renderBeats(); renderBeatEditor(); ui();
    });
    els.bpTicks.innerHTML = '';
    const n = tickCount(state.subs[i]);
    for (let k = 0; k < n; k++) {
      const on = !state.masks[i] || state.masks[i][k];
      const b = document.createElement('button');
      b.className = 'tick' + (on ? ' on' : '') + (k === 0 ? ' first' : '');
      b.setAttribute('aria-pressed', on);
      b.title = `${k + 1}번째 음 ${on ? '끄기' : '켜기'}`;
      b.onclick = (e) => {
        e.stopPropagation();
        const m = state.masks[i] ? [...state.masks[i]] : Array(n).fill(true);
        m[k] = !m[k];
        state.masks[i] = m.every(Boolean) ? null : m;
        persist(); renderBeats(); renderBeatEditor(); ui();
      };
      els.bpTicks.appendChild(b);
    }
  }

  function renderGroupingOptions() {
    const sel = els.grouping;
    sel.innerHTML = '';
    sel.add(new Option('기본', ''));
    for (const g of groupings(state.pattern.length)) sel.add(new Option(g, g));
    const custom = new Option('직접', 'custom');
    custom.hidden = true;
    sel.add(custom);
    sel.disabled = sel.options.length <= 2;
  }
  function renderPolyOptions() {
    const sel = els.poly, n = state.pattern.length;
    sel.innerHTML = '';
    sel.add(new Option('끄기', '0'));
    for (let p = 2; p <= 9; p++) if (p !== n) sel.add(new Option(`${p} : ${n}`, String(p)));
  }

  function ui() {
    els.bpmNum.textContent = state.bpm;
    els.bpmRange.value = state.bpm;
    els.tempoName.textContent = tempoName(state.bpm);
    els.sig.value = state.sig;
    const same = allSame();
    els.sub.querySelectorAll('button').forEach((b) => {
      const on = same && b.dataset.v === state.subs[0];
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', on);
    });
    els.subLabel.textContent = same ? '세분 (한 박을 나눔)' : '세분 · 박마다 다름 (점 아래 음표로 편집)';
    els.swingRow.hidden = !state.subs.includes('swing');
    els.swing.value = Math.round(state.swing * 100);
    els.swingVal.textContent = `${Math.round(state.swing * 100)}%`;
    els.grouping.value = state.grouping;
    if (els.grouping.value !== state.grouping) els.grouping.value = '';
    els.poly.value = String(state.poly);
    if (els.poly.value !== String(state.poly)) { state.poly = 0; els.poly.value = '0'; }
    els.sound.value = state.sound;
    els.accentFirst.classList.toggle('on', state.accentFirst);
    els.accentFirst.setAttribute('aria-pressed', state.accentFirst);
    els.vol.value = state.vol;
    els.play.textContent = running ? '■ 정지' : '▶ 시작';
    els.play.classList.toggle('running', running);
  }
  function renderAll() {
    renderGroupingOptions(); renderPolyOptions(); renderSubs(); renderBeats(); ui();
    if (!els.beatPop.hidden) renderBeatEditor();
  }

  function setBpm(b) {
    state.bpm = Math.max(30, Math.min(300, Math.round(b)));
    persist(); ui();
  }

  function draw() {
    if (ctx && running) {
      let cur = null;
      while (visualQueue.length && visualQueue[0].t <= ctx.currentTime) cur = visualQueue.shift();
      if (cur) {
        dots.forEach((d, i) => d.classList.toggle('on', i === cur.beat));
        const ms = Math.min(120, 60000 / state.bpm / 2);
        setTimeout(() => dots[cur.beat]?.classList.remove('on'), ms);
      }
    } else {
      dots.forEach((d) => d.classList.remove('on'));
    }
    requestAnimationFrame(draw);
  }

  // 탭 템포
  let taps = [], tapStartBpm = null;
  function tap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    if (!taps.length) tapStartBpm = state.bpm; // 탭을 시작하기 전 BPM 기억
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const iv = [];
      for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
      setBpm(60000 / avg);
      els.tapInfo.textContent = `(${taps.length}번)`;
    } else {
      els.tapInfo.textContent = '(계속 누르세요)';
    }
  }
  // 탭 초기화: 기록을 지우고 탭 시작 전 BPM으로 되돌림
  function tapReset() {
    if (tapStartBpm != null) setBpm(tapStartBpm);
    taps = []; tapStartBpm = null;
    els.tapInfo.textContent = '';
  }

  // 프리셋
  let presets = load(PSTORE, []);
  function renderPresets() {
    els.presets.innerHTML = '';
    if (!presets.length) {
      els.presets.innerHTML = '<div class="empty">저장된 프리셋이 없습니다</div>';
      return;
    }
    presets.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'preset';
      const b = document.createElement('button');
      b.className = 'load';
      b.innerHTML = `<span></span><small>${p.bpm} BPM · ${p.sig}</small>`;
      b.firstChild.textContent = p.name;
      b.onclick = () => {
        const { name, ...rest } = p;
        delete state.subs; delete state.masks;
        Object.assign(state, { swing: 2 / 3, poly: 0, grouping: '' }, structuredClone(rest));
        normalize(state);
        persist(); renderAll();
      };
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '✕'; del.title = '삭제';
      del.onclick = () => {
        if (confirm(`"${p.name}" 프리셋을 삭제할까요?`)) { presets.splice(i, 1); save(PSTORE, presets); renderPresets(); }
      };
      row.append(b, del);
      els.presets.appendChild(row);
    });
  }

  // ---------- 테마 선택 (왼쪽 위 동그라미) ----------
  const THEMES = [
    { id: 'soft', name: '눈이 편한', bar: '#f3efe7', swatch: 'linear-gradient(135deg, #f3efe7 50%, #cf7f5c 50%)' },
    { id: 'taeguk', name: '태극', bar: '#f6f3ec', swatch: 'linear-gradient(180deg, #cd2e3a 50%, #0047a0 50%)' },
    { id: 'mint', name: '흰/초록', bar: '#f7faf6', swatch: 'linear-gradient(135deg, #f7faf6 15%, #86b393 50%, #2f6b4f 90%)' },
    { id: 'lux', name: '블랙/골드', bar: '#0b0b0c', swatch: 'linear-gradient(135deg, #0b0b0c 50%, #d4af37 50%)' },
    { id: 'rose', name: '로즈', bar: '#fdf7f4', swatch: 'linear-gradient(135deg, #fdf7f4 15%, #e8b4a6 50%, #c9707e 90%)' },
    { id: 'lavender', name: '라벤더', bar: '#f9f6ff', swatch: 'linear-gradient(135deg, #f9f6ff 10%, #c4b1ff 50%, #ff9f8a 95%)' },
    { id: 'orange', name: '블랙/오렌지', bar: '#14161a', swatch: 'linear-gradient(135deg, #14161a 50%, #ff7a3d 50%)' },
  ];
  const themeBtn = $('themeBtn'), themePop = $('themePop');
  function currentTheme() { return document.documentElement.dataset.theme || 'soft'; }
  function applyTheme(id) {
    if (id === 'soft') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = id;
    try { localStorage.setItem('metronome.theme', id); } catch {}
    renderThemes();
  }
  function renderThemes() {
    const cur = THEMES.find((t) => t.id === currentTheme()) || THEMES[0];
    themeBtn.style.setProperty('--swatch', cur.swatch);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', cur.bar);
    themePop.innerHTML = '';
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.style.setProperty('--swatch', t.swatch);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t.name);
      b.setAttribute('aria-checked', t.id === cur.id);
      b.classList.toggle('sel', t.id === cur.id);
      b.onclick = (e) => { e.stopPropagation(); applyTheme(t.id); themePop.hidden = true; };
      themePop.appendChild(b);
    }
  }
  themeBtn.onclick = (e) => { e.stopPropagation(); themePop.hidden = !themePop.hidden; };
  document.addEventListener('click', (e) => { if (!themePop.hidden && !themePop.contains(e.target)) themePop.hidden = true; });

  // ---------- 이벤트 ----------
  SIGS.forEach((s) => els.sig.add(new Option(s, s)));
  els.play.onclick = () => (running ? stop() : start());
  els.tap.onclick = tap;
  els.tapReset.onclick = tapReset;
  els.bpmRange.oninput = () => setBpm(+els.bpmRange.value);
  document.querySelectorAll('.step').forEach((b) => (b.onclick = () => setBpm(state.bpm + +b.dataset.d)));
  els.sig.onchange = () => {
    const keep = allSame() ? state.subs[0] : '1';
    state.sig = els.sig.value;
    state.pattern = defaultPattern(state.sig);
    state.subs = Array(state.pattern.length).fill(keep);
    state.masks = Array(state.pattern.length).fill(null);
    state.grouping = '';
    editBeat = -1; els.beatPop.hidden = true;
    persist(); renderAll();
  };
  els.grouping.onchange = () => {
    const g = els.grouping.value;
    state.grouping = g;
    state.pattern = g ? patternFromGrouping(g) : defaultPattern(state.sig);
    persist(); renderBeats(); ui();
  };
  els.poly.onchange = () => { state.poly = Number(els.poly.value); persist(); };
  els.swing.oninput = () => { state.swing = Number(els.swing.value) / 100; persist(); ui(); };
  els.sound.onchange = () => { state.sound = els.sound.value; persist(); };
  els.accentFirst.onclick = () => { state.accentFirst = !state.accentFirst; persist(); ui(); };
  els.vol.oninput = () => { state.vol = +els.vol.value; if (master) master.gain.value = state.vol / 100; persist(); };
  els.bpClose.onclick = (e) => { e.stopPropagation(); els.beatPop.hidden = true; editBeat = -1; };
  els.bpAll.onclick = (e) => {
    e.stopPropagation();
    const i = editBeat;
    state.subs = state.subs.map(() => state.subs[i]);
    state.masks = state.masks.map(() => (state.masks[i] ? [...state.masks[i]] : null));
    persist(); renderBeats(); renderSubs(); ui();
    els.beatPop.hidden = true; editBeat = -1;
  };
  document.addEventListener('click', (e) => {
    if (!els.beatPop.hidden && !els.beatPop.contains(e.target)) { els.beatPop.hidden = true; editBeat = -1; }
  });
  // 가로로 넘기는 세분 목록: PC에서는 마우스 휠로도 넘어가게
  for (const el of [els.sub, els.bpSubs]) {
    el.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }
  els.savePreset.onclick = () => {
    const name = prompt('프리셋 이름 (예: 곡 제목)', `${state.bpm} BPM ${state.sig}`);
    if (!name) return;
    const { bpm, sig, pattern, subs, masks, swing, poly, grouping, sound, accentFirst } = state;
    presets.push({ name: name.trim(), ...structuredClone({ bpm, sig, pattern, subs, masks, swing, poly, grouping, sound, accentFirst }) });
    save(PSTORE, presets); renderPresets();
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); running ? stop() : start(); }
    else if (e.key === 't' || e.key === 'T') tap();
    else if (e.key === 'Escape') tapReset();
    else if (e.key === 'ArrowUp') setBpm(state.bpm + (e.shiftKey ? 5 : 1));
    else if (e.key === 'ArrowDown') setBpm(state.bpm - (e.shiftKey ? 5 : 1));
  });

  renderThemes(); renderAll(); renderPresets();
  requestAnimationFrame(draw);

  // ---------- 테스트용 공개 API ----------
  window.Metronome = {
    state, log, SOUNDS, eventsFor, normalize, groupings, start, stop,
    // 설정 s로 seconds초 분량을 오프라인 렌더링해 오디오 버퍼를 돌려줌
    async renderOffline(s, seconds, sampleRate = 48000) {
      const oc = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
      for (const e of eventsFor(normalize(structuredClone(s)), 0.05, seconds - 0.3)) {
        if (e.kind === 'poly') polySound(oc, oc.destination, e.t);
        else if (e.level > 0) SOUNDS[s.sound](oc, oc.destination, e.t, e.level);
      }
      return oc.startRendering();
    },
  };
})();
