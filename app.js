/* Workouts PWA — viewer de workouts + notas, sincronizado con GitHub. */

const APP_VERSION = '1.14';

const $app = document.getElementById('app');

// ---------- Iconos (SVG inline; nada de emojis en la interfaz) ----------

const ICON = {
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9M18.7 18.7l-1.9-1.9M7.2 7.2 5.3 5.3"/>',
  clock: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 10v3.5l2.4 1.8M9.5 2.5h5"/>',
  play: '<polygon points="7.5 4.5 19.5 12 7.5 19.5" fill="currentColor" stroke="none"/>',
  prev: '<polygon points="18.5 19 9.5 12 18.5 5" fill="currentColor" stroke="none"/><rect x="4.5" y="5" width="2.6" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
  next: '<polygon points="5.5 5 14.5 12 5.5 19" fill="currentColor" stroke="none"/><rect x="16.9" y="5" width="2.6" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
  note: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8.5" y="2" width="7" height="4" rx="1.2"/><path d="M8.5 12h7M8.5 16h4.5"/>',
  message: '<path d="M21 14.5a2 2 0 0 1-2 2H8l-4 3.5V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  mute: '<polygon points="11 5 6 9 2.5 9 2.5 15 6 15 11 19" fill="currentColor" stroke="none"/><path d="M22 9.5l-5.5 5M16.5 9.5l5.5 5"/>',
  check: '<polyline points="20 6.5 9.5 17 4 11.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};

const icon = (name, size = 18) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// ---------- Storage ----------

const store = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

const getSettings = () => store.get('wk.settings', { owner: '', repo: '', token: '' });
const isConfigured = () => !!getSettings().token;

const getCache = () => store.get('wk.cache', { index: null, workouts: {}, remoteNotes: {}, shas: {} });
const setCache = (c) => store.set('wk.cache', c);

const getNote = (id) => store.get('wk.note.' + id, null);
const setNote = (id, note) => store.set('wk.note.' + id, note);

function blankNote(workout) {
  return {
    workout_id: workout.id,
    day_note: '',
    exercises: Object.fromEntries(workout.exercises.map(e => [e.id, { sets_done: 0, note: '' }])),
    updated_at: null,
    dirty: false,
  };
}

// ---------- GitHub API ----------

const GH = 'https://api.github.com';

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + getSettings().token,
    'Accept': 'application/vnd.github+json',
  };
}

async function ghGetFile(path) {
  const { owner, repo } = getSettings();
  const res = await fetch(`${GH}/repos/${owner}/${repo}/contents/${path}?t=${Date.now()}`, {
    headers: ghHeaders(),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} al leer ${path}`);
  const data = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
  return { json: JSON.parse(text), sha: data.sha };
}

// Lista un directorio devolviendo { 'ruta/archivo.json': sha }. Permite
// descargar solo lo que cambió en vez de todo el repo en cada refresh.
async function ghListDir(path) {
  const { owner, repo } = getSettings();
  const res = await fetch(`${GH}/repos/${owner}/${repo}/contents/${path}?t=${Date.now()}`, {
    headers: ghHeaders(),
    cache: 'no-store',
  });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`GitHub ${res.status} al listar ${path}`);
  const arr = await res.json();
  return Object.fromEntries(
    arr.filter(f => f.type === 'file' && f.name.endsWith('.json')).map(f => [f.path, f.sha])
  );
}

async function ghPutFile(path, obj, message) {
  const { owner, repo } = getSettings();
  const existing = await ghGetFile(path);
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
  const body = {
    message,
    content: btoa(String.fromCharCode(...bytes)),
  };
  if (existing) body.sha = existing.sha;
  const res = await fetch(`${GH}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} al escribir ${path}`);
}

// ---------- Data loading ----------

let refreshing = false;
let lastRefresh = 0;
const REFRESH_MIN_MS = 60000; // no más de un refresh por minuto

// Devuelve true SOLO si algo cambió en el remoto (así renderHome no entra en
// bucle re-renderizándose a sí mismo). Descarga incremental por SHA: en estado
// estable son 3 peticiones, no una por cada workout y nota.
async function refreshData(force = false) {
  if (!isConfigured() || refreshing) return false;
  if (!force && Date.now() - lastRefresh < REFRESH_MIN_MS) return false;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    const prev = getCache();
    const [idx, woList, noteList] = await Promise.all([
      ghGetFile('index.json'),
      ghListDir('workouts'),
      ghListDir('notes'),
    ]);
    if (!idx) throw new Error('No existe index.json en el repo');

    const cache = {
      index: idx.json,
      workouts: { ...prev.workouts },
      remoteNotes: { ...prev.remoteNotes },
      shas: { ...(prev.shas || {}) },
    };
    let changed = JSON.stringify(prev.index) !== JSON.stringify(idx.json);
    const idOf = (path) => path.slice(path.indexOf('/') + 1).replace(/\.json$/, '');

    // Baja solo los archivos nuevos o cuyo SHA cambió
    const stale = Object.entries({ ...woList, ...noteList })
      .filter(([path, sha]) => cache.shas[path] !== sha);
    await Promise.all(stale.map(async ([path, sha]) => {
      const file = await ghGetFile(path);
      if (!file) return;
      if (path.startsWith('workouts/')) cache.workouts[idOf(path)] = file.json;
      else cache.remoteNotes[idOf(path)] = file.json;
      cache.shas[path] = sha;
      changed = true;
    }));

    // Purga lo que ya no existe en el remoto
    for (const path of Object.keys(cache.shas)) {
      if (path in woList || path in noteList) continue;
      if (path.startsWith('workouts/')) delete cache.workouts[idOf(path)];
      else delete cache.remoteNotes[idOf(path)];
      delete cache.shas[path];
      changed = true;
    }

    setCache(cache);
    // Adopta notas remotas si no hay cambios locales sin subir;
    // si la nota remota ya no existe, descarta la copia local limpia.
    for (const w of idx.json.workouts) {
      const remote = cache.remoteNotes[w.id];
      const local = getNote(w.id);
      if (remote) {
        if (!local || !local.dirty) setNote(w.id, { ...remote, dirty: false });
      } else if (local && !local.dirty) {
        localStorage.removeItem('wk.note.' + w.id);
      }
    }
    return changed;
  } catch (e) {
    console.warn('refreshData:', e.message);
    return false;
  } finally {
    refreshing = false;
  }
}

function getData() {
  if (isConfigured()) {
    const cache = getCache();
    if (cache.index) return { index: cache.index, workouts: cache.workouts, demo: false };
    return { index: null, workouts: {}, demo: false };
  }
  return { index: SAMPLE_DATA.index, workouts: SAMPLE_DATA.workouts, demo: true };
}

// ---------- Notes sync ----------

function pendingNoteIds() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith('wk.note.'))
    .map(k => k.slice('wk.note.'.length))
    .filter(id => getNote(id)?.dirty);
}

async function syncNotes() {
  if (!isConfigured()) return { ok: false, reason: 'demo' };
  const ids = pendingNoteIds();
  if (!ids.length) return { ok: true, synced: 0 };
  try {
    for (const id of ids) {
      const note = getNote(id);
      const { dirty, ...payload } = note;
      await ghPutFile(`notes/${id}.json`, payload, `notas: ${id}`);
      setNote(id, { ...note, dirty: false });
    }
    return { ok: true, synced: ids.length };
  } catch (e) {
    console.warn('syncNotes:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ---------- Helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const s = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function noteHasContent(note) {
  if (!note) return false;
  if (note.day_note?.trim()) return true;
  return Object.values(note.exercises || {}).some(e => e.sets_done > 0 || e.note?.trim());
}

// ---------- Interval timer ----------

let audioCtx = null;
let T = null;        // timer activo
let wakeLock = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== 'running') audioCtx.resume();
  // desbloquea la ruta de audio de iOS con un buffer silencioso de 1 muestra
  try {
    const b = audioCtx.createBufferSource();
    b.buffer = audioCtx.createBuffer(1, 1, 22050);
    b.connect(audioCtx.destination);
    b.start(0);
  } catch {}
}

function wakeAudio() {
  // iOS suspende el AudioContext tras interrupciones (llamadas, cambio de
  // AirPods, background); intenta revivirlo sin esperar un gesto.
  if (audioCtx && audioCtx.state !== 'running') audioCtx.resume();
}

const VOL_LEVELS = { bajo: 0.2, medio: 0.55, alto: 1.0 };
const getVol = () => store.get('wk.vol', 'alto');

function beep(freq, dur, delay = 0, soft = false) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const vol = VOL_LEVELS[getVol()] * (soft ? 0.45 : 1);
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'square'; // más penetrante que sine con música de fondo
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function parseSeconds(str) {
  if (!str) return null;
  const tokens = [...str.matchAll(/(\d+(?:\.\d+)?)\s*(min|seg|s)?/gi)]
    .map(m => ({ n: parseFloat(m[1]), u: m[2] ? m[2].toLowerCase() : null }));
  if (!tokens.length) return null;
  // rellena unidades faltantes con la del token siguiente ("2-3 min" → ambos min)
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!tokens[i].u) tokens[i].u = (i + 1 < tokens.length && tokens[i + 1].u) ? tokens[i + 1].u : 's';
  }
  return Math.max(...tokens.map(t => t.u === 'min' ? t.n * 60 : t.n));
}

// Un ejercicio es "temporizable" si sus reps están en segundos (holds).
function timedSpec(e) {
  if (!/\d\s*(s|seg)\b/i.test(e.reps || '')) return null;
  const work = parseSeconds(e.reps);
  if (!work) return null;
  return { work: Math.round(work), rest: Math.round(parseSeconds(e.rest) || 90) };
}

function startTimer(e) {
  stopTimer();
  ensureAudio();
  const spec = timedSpec(e);
  const phases = [{ label: 'Prepárate', kind: 'ready', dur: 10 }];
  for (let s = 1; s <= e.sets; s++) {
    phases.push({ label: `Serie ${s} de ${e.sets}`, kind: 'work', dur: spec.work });
    if (s < e.sets) phases.push({ label: `Descanso · va la ${s + 1} de ${e.sets}`, kind: 'rest', dur: spec.rest });
  }
  T = {
    name: e.name, spec, sets: e.sets, phases, idx: 0,
    endsAt: Date.now() + phases[0].dur * 1000,
    paused: false, lastTick: null,
    interval: setInterval(tickTimer, 200),
  };
  requestWakeLock();
  renderTimerOverlay();
  beep(880, 0.15);
}

// Ventana de ticks por fase: prep completa, últimos 10s del descanso
// (prepárate para la siguiente), últimos 5s de la serie (ya casi paras).
const TICK_WINDOW = { ready: 10, rest: 10, work: 5 };

function tickTimer() {
  if (!T || T.paused || T.done) return;
  wakeAudio();
  const remainMs = T.endsAt - Date.now();
  const remain = Math.ceil(remainMs / 1000);
  const win = TICK_WINDOW[T.phases[T.idx].kind] ?? 3;
  if (remain <= win && remain >= 1 && T.lastTick !== remain) {
    T.lastTick = remain;
    if (remain <= 3) beep(1100, 0.12);      // 3-2-1: más agudo
    else beep(880, 0.07, 0, true);          // tick suave
  }
  if (remainMs <= 0) {
    // Avanza las fases que correspondan, arrastrando el tiempo excedido.
    // Si la app estuvo congelada en background (iOS), esto la pone en el
    // punto real del ciclo al volver, aunque hayan pasado varias fases.
    let over = -remainMs;
    for (;;) {
      T.idx++;
      if (T.idx >= T.phases.length) {
        T.done = true;
        beep(1320, 0.25); beep(1320, 0.25, 0.35); beep(1760, 0.7, 0.7);
        clearInterval(T.interval);
        updateWakeLock();
        updateTimerDom();
        return;
      }
      const durMs = T.phases[T.idx].dur * 1000;
      if (over < durMs) {
        T.endsAt = Date.now() + durMs - over;
        break;
      }
      over -= durMs;
    }
    T.lastTick = null;
    if (T.phases[T.idx].kind === 'work') beep(1320, 0.5);
    else { beep(660, 0.25); beep(660, 0.25, 0.35); }
  }
  updateTimerDom();
}

function pauseTimer() {
  if (!T || T.done) return;
  if (T.paused) {
    T.endsAt = Date.now() + T.remainMs;
    T.paused = false;
  } else {
    T.remainMs = Math.max(0, T.endsAt - Date.now());
    T.paused = true;
  }
  updateTimerDom();
}

// Navegación manual entre fases. delta -1 = anterior, +1 = siguiente.
// Si llevas más de 3s dentro de una fase, "anterior" la reinicia en vez de retroceder
// (mismo comportamiento que un reproductor de música).
function goPhase(delta) {
  if (!T) return;
  ensureAudio();
  const p = T.phases[Math.min(T.idx, T.phases.length - 1)];
  const spent = T.done ? p.dur : p.dur - (T.paused ? T.remainMs : Math.max(0, T.endsAt - Date.now())) / 1000;
  let next = T.idx + delta;
  if (delta < 0 && !T.done && spent > 3) next = T.idx; // reinicia la fase actual
  if (next < 0) next = 0;
  if (next >= T.phases.length) { stopTimer(); return; }

  T.idx = next;
  T.done = false;
  T.lastTick = null;
  const durMs = T.phases[next].dur * 1000;
  if (T.paused) T.remainMs = durMs;
  else T.endsAt = Date.now() + durMs;
  if (!T.interval) T.interval = setInterval(tickTimer, 200); // reanuda si había terminado
  updateWakeLock();
  updateTimerDom();
}

const totalDuration = () => T.phases.reduce((s, p) => s + p.dur, 0);

function elapsedTotal() {
  if (T.done) return totalDuration();
  let e = 0;
  for (let i = 0; i < T.idx; i++) e += T.phases[i].dur;
  const p = T.phases[T.idx];
  const remain = (T.paused ? T.remainMs : Math.max(0, T.endsAt - Date.now())) / 1000;
  return e + (p.dur - remain);
}

function stopTimer() {
  if (!T) return;
  clearInterval(T.interval);
  T = null;
  updateWakeLock();
  document.getElementById('timer-overlay')?.remove();
}

function fmtClock(secs) {
  const m = Math.floor(secs / 60);
  return m ? `${m}:${String(secs % 60).padStart(2, '0')}` : String(secs);
}

function renderTimerOverlay() {
  document.getElementById('timer-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'timer-overlay';
  el.innerHTML = `
    <div class="t-name"></div>
    <div class="t-phase"></div>
    <div class="t-time"></div>
    <div class="t-spec">${T.sets} × ${T.spec.work}s · descanso ${fmtClock(T.spec.rest)}</div>
    <div class="t-map">${T.phases.map(p => `<span class="t-seg ${p.kind}" style="flex:${p.dur}"></span>`).join('')}</div>
    <div class="t-progress"><div class="t-bar" id="t-bar"></div></div>
    <div class="t-steps" id="t-steps"></div>
    <div class="t-audio" id="t-audio"></div>
    <div class="t-controls">
      <button class="btn-secondary t-nav" id="t-prev" aria-label="Fase anterior">${icon('prev', 20)}</button>
      <button class="btn-secondary" id="t-pause">Pausa</button>
      <button class="btn-secondary t-nav" id="t-next" aria-label="Fase siguiente">${icon('next', 20)}</button>
    </div>
    <button class="t-close" id="t-stop">Cerrar</button>`;
  document.body.appendChild(el);
  document.getElementById('t-pause').addEventListener('click', pauseTimer);
  document.getElementById('t-prev').addEventListener('click', () => goPhase(-1));
  document.getElementById('t-next').addEventListener('click', () => goPhase(1));
  document.getElementById('t-stop').addEventListener('click', stopTimer);
  el.addEventListener('click', ensureAudio); // cualquier tap revive el audio
  updateTimerDom();
}

function updateTimerDom() {
  const el = document.getElementById('timer-overlay');
  if (!el || !T) return;
  const p = T.phases[Math.min(T.idx, T.phases.length - 1)];
  el.className = T.done ? 'done' : p.kind;
  el.querySelector('.t-name').textContent = T.name;
  if (T.done) {
    el.querySelector('.t-phase').textContent = '¡Terminado!';
    el.querySelector('.t-time').textContent = '✓';
    document.getElementById('t-pause').style.display = 'none';
  } else {
    const remainMs = T.paused ? T.remainMs : Math.max(0, T.endsAt - Date.now());
    el.querySelector('.t-phase').textContent = T.paused ? `${p.label} · pausado` : p.label;
    el.querySelector('.t-time').textContent = fmtClock(Math.ceil(remainMs / 1000));
    document.getElementById('t-pause').style.display = '';
    document.getElementById('t-pause').textContent = T.paused ? 'Continuar' : 'Pausa';
  }

  // Progreso global del ciclo completo
  const total = totalDuration();
  const done = Math.min(total, Math.max(0, elapsedTotal()));
  document.getElementById('t-bar').style.width = (done / total * 100).toFixed(1) + '%';
  document.getElementById('t-steps').textContent = T.done
    ? `${T.phases.length} de ${T.phases.length} · ${fmtClock(total)} en total`
    : `Fase ${T.idx + 1} de ${T.phases.length} · faltan ${fmtClock(Math.ceil(total - done))} en total`;
  document.getElementById('t-prev').disabled = T.idx === 0 && !T.done;

  // Mapa de fases: pasadas atenuadas, actual resaltada, futuras tenues
  el.querySelectorAll('.t-seg').forEach((seg, i) => {
    seg.classList.toggle('past', T.done || i < T.idx);
    seg.classList.toggle('now', !T.done && i === T.idx);
  });
  const audioEl = document.getElementById('t-audio');
  if (audioEl) {
    audioEl.innerHTML = (audioCtx && audioCtx.state !== 'running' && !T.done)
      ? icon('mute', 14) + ' Audio dormido — toca la pantalla para reactivar los beeps'
      : '';
  }
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}
// Pantalla despierta siempre que estés dentro de un workout (no solo con
// timer corriendo) — en el gym la app queda abierta entre series.
function updateWakeLock() {
  if (location.hash.startsWith('#/w/') || (T && !T.done)) requestWakeLock();
  else releaseWakeLock();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wakeAudio();
    updateWakeLock();
    if (T && !T.done) tickTimer(); // ponte al día de inmediato tras volver de background
  }
});

// ---------- Mini timer de descanso (ejercicios por reps) ----------

let miniT = null; // { exId, endsAt, lastTick, interval }

function startRest(e) {
  ensureAudio();
  const wasRunning = miniT?.exId === e.id;
  stopRest();
  if (wasRunning) return; // segundo tap = cancelar
  const secs = Math.round(parseSeconds(e.rest) || 90);
  miniT = { exId: e.id, endsAt: Date.now() + secs * 1000, lastTick: null, interval: setInterval(tickRest, 250) };
  beep(660, 0.3);
  updateRestDom();
}

function tickRest() {
  if (!miniT) return;
  wakeAudio();
  const remain = Math.ceil((miniT.endsAt - Date.now()) / 1000);
  if (remain <= 3 && remain >= 1 && miniT.lastTick !== remain) {
    miniT.lastTick = remain;
    beep(1100, 0.12);
  }
  if (remain <= 0) {
    beep(1320, 0.5); beep(1320, 0.3, 0.6);
    stopRest();
    return;
  }
  updateRestDom();
}

function stopRest() {
  if (!miniT) return;
  clearInterval(miniT.interval);
  miniT = null;
  updateRestDom();
}

function updateRestDom() {
  document.querySelectorAll('[data-rest]').forEach(btn => {
    if (miniT && miniT.exId === btn.dataset.rest) {
      const remain = Math.max(0, Math.ceil((miniT.endsAt - Date.now()) / 1000));
      btn.innerHTML = icon('stop', 13) + ' ' + fmtClock(remain);
      btn.classList.add('running');
    } else {
      btn.innerHTML = icon('clock', 14) + ' ' + fmtClock(Number(btn.dataset.secs));
      btn.classList.remove('running');
    }
  });
}

// ---------- Views ----------

// Estado de UI del home (sobrevive re-renders de la sesión)
let showPast = false;
let weekNoteOpen = null; // null = decidir según si la nota es nueva
const wnKey = (s) => 'wn:' + s.length + ':' + s.slice(0, 40);

function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderHome() {
  const { index, workouts, demo } = getData();
  const today = todayISO();

  const cardHtml = (w) => {
    const isToday = w.date === today;
    const note = getNote(w.id) || (demo ? SAMPLE_DATA.notes[w.id] : null);
    const dirty = getNote(w.id)?.dirty;
    let pill = '';
    if (isToday) pill = '<span class="pill today">HOY</span>';
    else if (dirty) pill = '<span class="pill pending">POR SUBIR</span>';
    else if (noteHasContent(note)) pill = `<span class="pill done">${icon('check', 12)} CON NOTAS</span>`;
    return `
      <a class="wo-card ${isToday ? 'today-card' : ''}" href="#/w/${esc(w.id)}">
        <div class="row1"><span class="date">${esc(fmtDate(w.date))}</span>${pill}</div>
        <h3>${esc(w.title)}</h3>
        <div class="focus">${esc(w.focus || '')}</div>
      </a>`;
  };

  let cards = '';
  let pastHtml = '';
  if (index?.workouts?.length) {
    const sorted = [...index.workouts].sort((a, b) => a.date.localeCompare(b.date));
    // Semana vigente = la del día de hoy, o la más nueva publicada si ya
    // llegó la siguiente (domingo en la noche la nueva desplaza a la vieja).
    const latestMonday = mondayOf(sorted[sorted.length - 1].date);
    const curMonday = latestMonday > mondayOf(today) ? latestMonday : mondayOf(today);
    const current = sorted.filter(w => mondayOf(w.date) >= curMonday);
    const past = sorted.filter(w => mondayOf(w.date) < curMonday).reverse(); // recientes primero

    cards = current.map(cardHtml).join('')
      || `<div class="empty">No hay workouts esta semana todavía.</div>`;

    if (past.length) {
      pastHtml = `<button class="past-toggle" id="past-toggle">${showPast ? '▾' : '▸'}&nbsp; Semanas anteriores (${past.length})</button>`;
      if (showPast) {
        let lastWeek = null;
        pastHtml += past.map(w => {
          const wk = mondayOf(w.date);
          const label = wk !== lastWeek
            ? `<div class="section-label">Semana del ${esc(new Date(wk + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }))}</div>`
            : '';
          lastWeek = wk;
          return label + cardHtml(w);
        }).join('');
      }
    }
  } else {
    cards = `<div class="empty">No hay workouts todavía.<br>${isConfigured() ? 'Desliza tu dedo hacia abajo o revisa la configuración' : 'Configura GitHub en ajustes para ver los tuyos.'}</div>`;
  }

  // Nota del coach: colapsada en un botón; se abre sola solo si es nueva.
  let wnHtml = '';
  if (index?.week_note) {
    if (weekNoteOpen === null) weekNoteOpen = store.get('wk.wn.read') !== wnKey(index.week_note);
    wnHtml = weekNoteOpen
      ? `<div class="week-note">
           <button class="wn-head" id="wn-toggle"><span class="wn-title">${icon('note', 14)} Nota del coach</span><span class="wn-chevron">▾</span></button>
           <div class="wn-body">${esc(index.week_note).replace(/\n/g, '<br>')}</div>
         </div>`
      : `<button class="week-note-collapsed" id="wn-toggle"><span class="wn-title">${icon('note', 14)} Nota del coach</span><span class="wn-hint">leer ▸</span></button>`;
  }

  const pending = pendingNoteIds().length;

  $app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Workouts</h1>
        <div class="sub">${esc(fmtDate(today))}</div>
      </div>
      <button class="icon-btn" onclick="location.hash='#/settings'" aria-label="Configuración">${icon('gear', 20)}</button>
    </div>
    ${demo ? '<div class="banner">Modo demo con datos de ejemplo. Toca el engrane para conectar tu repo de GitHub.</div>' : ''}
    ${pending && !demo ? `<div class="banner warn">${pending} día(s) con notas sin subir. Se subirán al guardar con conexión.</div>` : ''}
    ${wnHtml}
    ${cards}
    ${pastHtml}
  `;

  document.getElementById('wn-toggle')?.addEventListener('click', () => {
    weekNoteOpen = !weekNoteOpen;
    if (!weekNoteOpen) store.set('wk.wn.read', wnKey(index.week_note));
    renderHome();
  });
  document.getElementById('past-toggle')?.addEventListener('click', () => {
    showPast = !showPast;
    renderHome();
  });

  if (isConfigured()) {
    refreshData().then(changed => {
      if (changed && location.hash.replace('#/', '') === '') renderHome();
    });
  }
}

function renderWorkout(id) {
  const { workouts, demo } = getData();
  const w = workouts[id];
  if (!w) {
    $app.innerHTML = `<button class="back-btn" onclick="location.hash=''">‹ Volver</button><div class="empty">No encontré este workout.</div>`;
    return;
  }

  let note = getNote(id);
  if (!note) {
    note = demo && SAMPLE_DATA.notes[id]
      ? { ...SAMPLE_DATA.notes[id], dirty: false }
      : blankNote(w);
    // completa ejercicios faltantes
  }
  for (const e of w.exercises) {
    if (!note.exercises[e.id]) note.exercises[e.id] = { sets_done: 0, note: '' };
  }

  const hasSections = w.exercises.some(e => e.section);
  let lastSection = null;
  const exCards = w.exercises.map(e => {
    const en = note.exercises[e.id];
    const dots = Array.from({ length: e.sets }, (_, i) =>
      `<button class="set-dot ${i < en.sets_done ? 'on' : ''}" data-ex="${esc(e.id)}" data-set="${i + 1}">${i + 1}</button>`
    ).join('');
    let sectionHtml = '';
    if (e.section && e.section !== lastSection) {
      sectionHtml = `<div class="section-label">${esc(e.section)}</div>`;
      lastSection = e.section;
    }
    const videoUrl = e.video
      || `https://www.youtube.com/results?search_query=${encodeURIComponent(e.video_q || (e.name.replace(/\(.*?\)/g, '').trim() + ' técnica tutorial'))}`;
    const restSecs = !timedSpec(e) && e.sets > 1 ? Math.round(parseSeconds(e.rest) || 0) : 0;
    return `
      ${sectionHtml}
      <div class="ex-card">
        <div class="ex-head">
          <h4>${esc(e.name)}</h4>
          ${timedSpec(e) ? `<button class="timer-btn" data-timer="${esc(e.id)}" aria-label="Iniciar timer">${icon('clock', 17)}</button>` : ''}
          <a class="video-btn" href="${esc(videoUrl)}" target="_blank" rel="noopener" aria-label="Ver técnica en YouTube">${icon('play', 13)}</a>
        </div>
        <div class="ex-meta">
          <span>${e.sets} × ${esc(e.reps)}</span>
          ${e.weight ? `<span class="weight">${esc(e.weight)}</span>` : ''}
          ${e.rir ? `<span>RIR ${esc(e.rir)}</span>` : ''}
          ${e.rest && !restSecs ? `<span>${icon('clock', 13)} ${esc(e.rest)}</span>` : ''}
        </div>
        ${e.cue ? `<div class="cue">${esc(e.cue)}</div>` : ''}
        ${e.coach_note ? `<div class="coach-note">${icon('message', 15)} ${esc(e.coach_note)}</div>` : ''}
        <div class="set-row">
          <span class="lbl">Series</span>${dots}
          ${restSecs ? `<button class="rest-btn" data-rest="${esc(e.id)}" data-secs="${restSecs}">${icon('clock', 14)} ${fmtClock(restSecs)}</button>` : ''}
        </div>
        <textarea class="note-input" rows="1" data-exnote="${esc(e.id)}"
          placeholder="Nota para Claude…">${esc(en.note)}</textarea>
      </div>`;
  }).join('');

  const listSection = (label, items) => items?.length
    ? `<div class="section-label">${label}</div><ul class="simple-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '';

  $app.innerHTML = `
    <button class="back-btn" onclick="location.hash=''">‹ Volver</button>
    <div class="wo-head">
      <div class="date">${esc(fmtDate(w.date))}</div>
      <h2>${esc(w.title)}</h2>
      <div class="focus">${esc(w.focus || '')}</div>
      ${w.date === todayISO() ? '<div class="session-row" id="session-row"></div>' : ''}
    </div>
    ${listSection('Calentamiento', w.warmup)}
    ${hasSections ? '' : '<div class="section-label">Ejercicios</div>'}
    ${exCards}
    ${listSection('Enfriamiento', w.cooldown)}
    <div class="section-label">Nota del día</div>
    <textarea class="note-input day-note" id="day-note"
      placeholder="¿Cómo te fue hoy? Claude leerá esto para ajustar el siguiente workout.">${esc(note.day_note)}</textarea>
    <div class="save-bar">
      <button class="bar-back" onclick="location.hash=''" aria-label="Volver al inicio">‹</button>
      <button class="btn-primary" id="save-btn">Guardar notas</button>
    </div>
    <div class="sync-status" id="sync-status">${syncStatusText(note)}</div>
  `;

  // Inicio/fin de sesión automáticos. Reglas anti-ruido: solo el workout de
  // HOY registra tiempos, solo marcar series cuenta (las notas se escriben a
  // cualquier hora), y una ráfaga >2h después de la última actividad no
  // extiende el fin (series marcadas tarde por olvido).
  const markActivity = () => {
    if (w.date !== todayISO()) return;
    const now = new Date().toISOString();
    if (!note.started_at) note.started_at = now;
    else if (note.time_manual_end) return; // cerró con el botón: respetar
    else if (note.ended_at && Date.now() - Date.parse(note.ended_at) > 2 * 3600 * 1000) return;
    note.ended_at = now;
  };

  // Cronómetro de sesión: botón manual con la captura automática de respaldo
  const renderSessionRow = () => {
    const row = document.getElementById('session-row');
    if (!row) return;
    if (!note.started_at) {
      row.innerHTML = `<button class="session-btn" id="session-start">${icon('play', 15)} Iniciar entrenamiento</button>`;
      document.getElementById('session-start').addEventListener('click', () => {
        note.started_at = new Date().toISOString();
        note.time_manual = true;
        persist();
        renderSessionRow();
      });
    } else if (note.time_manual_end && note.ended_at) {
      const mins = Math.max(1, Math.round((Date.parse(note.ended_at) - Date.parse(note.started_at)) / 60000));
      row.innerHTML = `<span class="session-done">${icon('check', 14)} Entrenaste ${fmtDur(mins)} (${hhmm(note.started_at)}–${hhmm(note.ended_at)})</span>`;
    } else {
      const mins = Math.max(0, Math.floor((Date.now() - Date.parse(note.started_at)) / 60000));
      row.innerHTML = `<span class="session-live">${icon('clock', 16)} ${fmtDur(mins)} en curso</span>
        <button class="session-btn stop" id="session-end">${icon('stop', 13)} Terminar</button>`;
      document.getElementById('session-end').addEventListener('click', () => {
        note.ended_at = new Date().toISOString();
        note.time_manual_end = true;
        persist();
        renderSessionRow();
      });
    }
  };
  clearInterval(sessionInterval);
  sessionInterval = setInterval(renderSessionRow, 30000);
  renderSessionRow();

  const persist = () => {
    note.updated_at = new Date().toISOString();
    note.dirty = true;
    setNote(id, note);
    document.getElementById('sync-status').textContent = 'Cambios guardados en el teléfono, sin subir.';
    document.getElementById('sync-status').className = 'sync-status warn';
  };

  $app.querySelectorAll('.set-dot').forEach(btn => {
    btn.addEventListener('click', () => {
      const exId = btn.dataset.ex;
      const n = Number(btn.dataset.set);
      const en = note.exercises[exId];
      en.sets_done = (en.sets_done === n) ? n - 1 : n;
      markActivity();
      persist();
      renderWorkout(id);
      window.scrollTo(0, document.documentElement.scrollTop);
    });
  });

  $app.querySelectorAll('[data-timer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = w.exercises.find(x => x.id === btn.dataset.timer);
      if (ex) startTimer(ex);
    });
  });

  $app.querySelectorAll('[data-rest]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = w.exercises.find(x => x.id === btn.dataset.rest);
      if (ex) startRest(ex);
    });
  });
  updateRestDom(); // restaura el estado si hay un descanso corriendo tras re-render

  $app.querySelectorAll('[data-exnote]').forEach(ta => {
    autoGrow(ta);
    ta.addEventListener('input', () => {
      note.exercises[ta.dataset.exnote].note = ta.value;
      autoGrow(ta);
      persist();
    });
  });

  const dayNote = document.getElementById('day-note');
  dayNote.addEventListener('input', () => { note.day_note = dayNote.value; persist(); });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('save-btn');
    const status = document.getElementById('sync-status');
    if (!note.dirty) { note.updated_at = new Date().toISOString(); note.dirty = true; setNote(id, note); }
    if (!isConfigured()) {
      status.textContent = 'Modo demo: las notas solo se guardan en este teléfono.';
      status.className = 'sync-status warn';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Subiendo…';
    const result = await syncNotes();
    btn.disabled = false;
    btn.textContent = 'Guardar notas';
    if (result.ok) {
      note = getNote(id);
      status.innerHTML = icon('check', 14) + ' Notas subidas. Claude las verá en su siguiente sesión.';
      status.className = 'sync-status ok';
    } else {
      status.textContent = 'Sin conexión o error al subir. Quedaron guardadas en el teléfono.';
      status.className = 'sync-status warn';
    }
  });
}

// ---------- Cronómetro de sesión (manual) ----------

let sessionInterval = null;

const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

function fmtDur(mins) {
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins} min`;
}

function syncStatusText(note) {
  if (note.dirty) return 'Tienes cambios sin subir.';
  if (note.updated_at) return 'Notas sincronizadas.';
  return '';
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function renderSettings() {
  const s = getSettings();
  $app.innerHTML = `
    <button class="back-btn" onclick="location.hash=''">‹ Volver</button>
    <div class="wo-head"><h2>Configuración</h2></div>
    <div class="field">
      <label>Usuario de GitHub</label>
      <input id="f-owner" value="${esc(s.owner)}" autocapitalize="off" autocorrect="off" placeholder="tu-usuario">
    </div>
    <div class="field">
      <label>Repositorio de datos</label>
      <input id="f-repo" value="${esc(s.repo)}" autocapitalize="off" autocorrect="off" placeholder="workout-data">
    </div>
    <div class="field">
      <label>Token (fine-grained PAT)</label>
      <input id="f-token" type="password" value="${esc(s.token)}" placeholder="github_pat_…">
      <div class="hint">Token con permiso de Contents (lectura y escritura) solo sobre el repo de datos.</div>
    </div>
    <div class="save-bar"><button class="btn-primary" id="save-settings">Guardar y probar conexión</button></div>
    <div class="settings-msg" id="settings-msg"></div>
    <div class="section-label">App</div>
    <div class="field">
      <label>Volumen de beeps del timer</label>
      <div class="vol-row">
        ${['bajo', 'medio', 'alto'].map(v =>
          `<button class="vol-btn ${getVol() === v ? 'on' : ''}" data-vol="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`
        ).join('')}
      </div>
      <div class="hint">Toca una opción para escuchar una muestra.</div>
    </div>
    <button class="btn-secondary" id="force-refresh">Actualizar app</button>
    <div class="sync-status">Workouts v${APP_VERSION}</div>
  `;

  $app.querySelectorAll('.vol-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      store.set('wk.vol', btn.dataset.vol);
      $app.querySelectorAll('.vol-btn').forEach(b => b.classList.toggle('on', b === btn));
      ensureAudio();
      beep(1100, 0.15);
      beep(1320, 0.2, 0.25);
    });
  });

  document.getElementById('force-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('force-refresh');
    btn.disabled = true;
    btn.textContent = 'Actualizando…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } finally {
      location.reload();
    }
  });

  document.getElementById('save-settings').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    store.set('wk.settings', {
      owner: document.getElementById('f-owner').value.trim(),
      repo: document.getElementById('f-repo').value.trim(),
      token: document.getElementById('f-token').value.trim(),
    });
    msg.textContent = 'Probando conexión…';
    msg.className = 'settings-msg';
    try {
      const idx = await ghGetFile('index.json');
      if (!idx) throw new Error('Conecté al repo pero no encontré index.json.');
      msg.innerHTML = icon('check', 14) + ` Conectado. Encontré ${idx.json.workouts.length} workout(s).`;
      msg.className = 'settings-msg ok';
      await refreshData(true);
      setTimeout(() => { location.hash = ''; }, 900);
    } catch (e) {
      msg.textContent = '✗ ' + e.message;
      msg.className = 'settings-msg err';
    }
  });
}

// ---------- Router ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  window.scrollTo(0, 0);
  clearInterval(sessionInterval);
  updateWakeLock();
  if (hash === 'settings') return renderSettings();
  if (hash.startsWith('w/')) return renderWorkout(decodeURIComponent(hash.slice(2)));
  renderHome();
}

window.addEventListener('hashchange', route);
route();

// Reintenta subir notas pendientes al recuperar conexión
window.addEventListener('online', () => { syncNotes(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}
