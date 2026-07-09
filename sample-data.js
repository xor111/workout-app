/* Datos de ejemplo para el modo demo (sin GitHub configurado). */
const SAMPLE_DATA = {
  index: {
    workouts: [
      { id: '2026-07-09', date: '2026-07-09', title: 'Día 2 — Empuje', focus: 'Pecho, hombro, tríceps' },
      { id: '2026-07-07', date: '2026-07-07', title: 'Día 1 — Jalón', focus: 'Espalda y bíceps' },
    ],
  },
  workouts: {
    '2026-07-09': {
      id: '2026-07-09',
      date: '2026-07-09',
      title: 'Día 2 — Empuje',
      focus: 'Pecho, hombro, tríceps',
      warmup: ['5 min bici o remo suave', '2×15 band pull-aparts', '2×10 push-ups lentas'],
      exercises: [
        { id: 'bench-press', name: 'Press de banca', sets: 4, reps: '8-10', weight: '60 kg', rir: '2', rest: '2-3 min', coach_note: 'Primera semana: quédate lejos del fallo, estamos calibrando pesos.' },
        { id: 'overhead-press', name: 'Press militar con barra', sets: 3, reps: '8-10', weight: '35 kg', rest: '2 min' },
        { id: 'incline-db-press', name: 'Press inclinado con mancuernas', sets: 3, reps: '10-12', weight: '22 kg/lado', rest: '90s' },
        { id: 'lateral-raise', name: 'Elevaciones laterales', sets: 3, reps: '12-15', weight: '10 kg/lado', rest: '60s' },
        { id: 'triceps-pushdown', name: 'Extensión de tríceps en polea', sets: 3, reps: '12-15', weight: '25 kg', rest: '60s' },
      ],
      cooldown: ['Estiramiento de pecho en marco de puerta, 30s por lado'],
    },
    '2026-07-07': {
      id: '2026-07-07',
      date: '2026-07-07',
      title: 'Día 1 — Jalón',
      focus: 'Espalda y bíceps',
      warmup: ['5 min remo suave', '2×10 jalón al pecho ligero'],
      exercises: [
        { id: 'lat-pulldown', name: 'Jalón al pecho', sets: 4, reps: '8-10', weight: '55 kg', rest: '2 min' },
        { id: 'barbell-row', name: 'Remo con barra', sets: 3, reps: '8-10', weight: '50 kg', rest: '2 min' },
        { id: 'seated-cable-row', name: 'Remo en polea sentado', sets: 3, reps: '10-12', weight: '45 kg', rest: '90s' },
        { id: 'db-curl', name: 'Curl con mancuernas', sets: 3, reps: '10-12', weight: '12 kg/lado', rest: '60s' },
      ],
      cooldown: [],
    },
  },
  notes: {
    '2026-07-07': {
      workout_id: '2026-07-07',
      day_note: 'Buen día en general, terminé en ~55 min.',
      exercises: {
        'lat-pulldown': { sets_done: 4, note: '55 kg se sintió cómodo, puedo subir.' },
        'barbell-row': { sets_done: 3, note: '' },
        'seated-cable-row': { sets_done: 3, note: '' },
        'db-curl': { sets_done: 2, note: 'Me quedé sin tiempo, solo hice 2 series.' },
      },
      updated_at: '2026-07-07T19:10:00Z',
    },
  },
};
