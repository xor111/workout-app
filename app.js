/* Workouts PWA — viewer de workouts + notas, sincronizado con GitHub. */

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

// ---------- Views ----------

function renderHome() {
  const { index, workouts, demo } = getData();
  const today = todayISO();

  let cards = '';
  if (index?.workouts?.length) {
    const sorted = [...index.workouts].sort((a, b) => b.date.localeCompare(a.date));
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

  const exCards = w.exercises.map(e => {
    const en = note.exercises[e.id];
    const dots = Array.from({ length: e.sets }, (_, i) =>
      `<button class="set-dot ${i < en.sets_done ? 'on' : ''}" data-ex="${esc(e.id)}" data-set="${i + 1}">${i + 1}</button>`
    ).join('');
    return `
      <div class="ex-card">
        <h4>${esc(e.name)}</h4>
        <div class="ex-meta">
          <span>${e.sets} × ${esc(e.reps)}</span>
          ${e.weight ? `<span class="weight">${esc(e.weight)}</span>` : ''}
          ${e.rir ? `<span>RIR ${esc(e.rir)}</span>` : ''}
          ${e.rest ? `<span>⏱ ${esc(e.rest)}</span>` : ''}
        </div>
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
    <div class="section-label">Ejercicios</div>
    ${exCards}
    ${listSection('Enfriamiento', w.cooldown)}
    <div class="section-label">Nota del día</div>
    <textarea class="note-input day-note" id="day-note"
      placeholder="¿Cómo te fue hoy? Claude leerá esto para ajustar el siguiente workout.">${esc(note.day_note)}</textarea>
    <div class="save-bar">
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
  `;

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
