/* Workouts PWA — viewer de workouts + notas, sincronizado con GitHub. */

const APP_VERSION = '1.5';

const $app = document.getElementById('app');

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

const getCache = () => store.get('wk.cache', { index: null, workouts: {}, remoteNotes: {} });
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

async function refreshData() {
  if (!isConfigured() || refreshing) return false;
  refreshing = true;
  try {
    const idx = await ghGetFile('index.json');
    if (!idx) throw new Error('No existe index.json en el repo');
    const cache = { index: idx.json, workouts: {}, remoteNotes: {} };
    await Promise.all(idx.json.workouts.map(async (w) => {
      const [wo, note] = await Promise.all([
        ghGetFile(`workouts/${w.id}.json`),
        ghGetFile(`notes/${w.id}.json`),
      ]);
      if (wo) cache.workouts[w.id] = wo.json;
      if (note) cache.remoteNotes[w.id] = note.json;
    }));
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
    return true;
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
  if (audioCtx.state === 'suspended') audioCtx.resume();
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
  const remainMs = T.endsAt - Date.now();
  const remain = Math.ceil(remainMs / 1000);
  const win = TICK_WINDOW[T.phases[T.idx].kind] ?? 3;
  if (remain <= win && remain >= 1 && T.lastTick !== remain) {
    T.lastTick = remain;
    if (remain <= 3) beep(1100, 0.12);      // 3-2-1: más agudo
    else beep(880, 0.07, 0, true);          // tick suave
  }
  if (remainMs <= 0) {
    T.idx++;
    if (T.idx >= T.phases.length) {
      T.done = true;
      beep(1320, 0.25); beep(1320, 0.25, 0.35); beep(1760, 0.7, 0.7);
      clearInterval(T.interval);
      releaseWakeLock();
      updateTimerDom();
      return;
    }
    const p = T.phases[T.idx];
    T.endsAt = Date.now() + p.dur * 1000;
    T.lastTick = null;
    if (p.kind === 'work') beep(1320, 0.5);
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

function stopTimer() {
  if (!T) return;
  clearInterval(T.interval);
  T = null;
  releaseWakeLock();
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
    <div class="t-controls">
      <button class="btn-secondary" id="t-pause">Pausa</button>
      <button class="btn-secondary" id="t-stop">Cerrar</button>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('t-pause').addEventListener('click', pauseTimer);
  document.getElementById('t-stop').addEventListener('click', stopTimer);
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
    document.getElementById('t-pause').textContent = T.paused ? 'Continuar' : 'Pausa';
  }
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (T && !T.done && document.visibilityState === 'visible') requestWakeLock();
});

// ---------- Views ----------

function renderHome() {
  const { index, workouts, demo } = getData();
  const today = todayISO();

  let cards = '';
  if (index?.workouts?.length) {
    const sorted = [...index.workouts].sort((a, b) => a.date.localeCompare(b.date));
    cards = sorted.map(w => {
      const isToday = w.date === today;
      const note = getNote(w.id) || (demo ? SAMPLE_DATA.notes[w.id] : null);
      const dirty = getNote(w.id)?.dirty;
      let pill = '';
      if (isToday) pill = '<span class="pill today">HOY</span>';
      else if (dirty) pill = '<span class="pill pending">POR SUBIR</span>';
      else if (noteHasContent(note)) pill = '<span class="pill done">✓ CON NOTAS</span>';
      return `
        <a class="wo-card ${isToday ? 'today-card' : ''}" href="#/w/${esc(w.id)}">
          <div class="row1"><span class="date">${esc(fmtDate(w.date))}</span>${pill}</div>
          <h3>${esc(w.title)}</h3>
          <div class="focus">${esc(w.focus || '')}</div>
        </a>`;
    }).join('');
  } else {
    cards = `<div class="empty">No hay workouts todavía.<br>${isConfigured() ? 'Desliza tu dedo hacia abajo o revisa la configuración ⚙️' : 'Configura GitHub en ⚙️ para ver los tuyos.'}</div>`;
  }

  const pending = pendingNoteIds().length;

  $app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Workouts</h1>
        <div class="sub">${esc(fmtDate(today))}</div>
      </div>
      <button class="icon-btn" onclick="location.hash='#/settings'" aria-label="Configuración">⚙️</button>
    </div>
    ${demo ? '<div class="banner">Modo demo con datos de ejemplo. Toca ⚙️ para conectar tu repo de GitHub.</div>' : ''}
    ${pending && !demo ? `<div class="banner warn">${pending} día(s) con notas sin subir. Se subirán al guardar con conexión.</div>` : ''}
    ${cards}
  `;

  if (isConfigured()) {
    refreshData().then(ok => { if (ok && location.hash.replace('#/', '') === '') renderHome(); });
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
      || `https://www.youtube.com/results?search_query=${encodeURIComponent(e.name.replace(/\(.*?\)/g, '').trim() + ' técnica tutorial')}`;
    return `
      ${sectionHtml}
      <div class="ex-card">
        <div class="ex-head">
          <h4>${esc(e.name)}</h4>
          ${timedSpec(e) ? `<button class="timer-btn" data-timer="${esc(e.id)}" aria-label="Iniciar timer">⏱</button>` : ''}
          <a class="video-btn" href="${esc(videoUrl)}" target="_blank" rel="noopener" aria-label="Ver técnica en YouTube">▶</a>
        </div>
        <div class="ex-meta">
          <span>${e.sets} × ${esc(e.reps)}</span>
          ${e.weight ? `<span class="weight">${esc(e.weight)}</span>` : ''}
          ${e.rir ? `<span>RIR ${esc(e.rir)}</span>` : ''}
          ${e.rest ? `<span>⏱ ${esc(e.rest)}</span>` : ''}
        </div>
        ${e.cue ? `<div class="cue">${esc(e.cue)}</div>` : ''}
        ${e.coach_note ? `<div class="coach-note">💬 ${esc(e.coach_note)}</div>` : ''}
        <div class="set-row"><span class="lbl">Series</span>${dots}</div>
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
      status.textContent = '✓ Notas subidas. Claude las verá en su siguiente sesión.';
      status.className = 'sync-status ok';
    } else {
      status.textContent = 'Sin conexión o error al subir. Quedaron guardadas en el teléfono.';
      status.className = 'sync-status warn';
    }
  });
}

function syncStatusText(note) {
  if (note.dirty) return 'Tienes cambios sin subir.';
  if (note.updated_at) return '✓ Notas sincronizadas.';
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
      msg.textContent = `✓ Conectado. Encontré ${idx.json.workouts.length} workout(s).`;
      msg.className = 'settings-msg ok';
      await refreshData();
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
