const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

// ====== CONFIGURACIÓN (puedes cambiar estas líneas) ======
const ADMIN_PIN = process.env.ADMIN_PIN || 'docentia'; // contraseña del administrador
const PORT = process.env.PORT || 3000;
const QUESTION_TIME = 20; // segundos por pregunta
// =========================================================

// ---- Cuestionario de nivel de IA (4 preguntas de opción múltiple) ----
const AI_QUIZ = [
  {
    text: '¿Con qué frecuencia usas herramientas de IA como ChatGPT, Gemini o Copilot?',
    options: ['Nunca las he usado', 'Las he probado alguna vez', 'Las uso varias veces al mes', 'Las uso casi a diario'],
    points: [0, 1, 2, 3],
  },
  {
    text: '¿Qué es un «prompt»?',
    options: ['No lo sé', 'Un tipo de virus informático', 'La instrucción o pregunta que le escribes a una IA', 'Una marca de ordenadores'],
    points: [0, 0, 3, 0],
  },
  {
    text: '¿Qué describe mejor a un modelo de lenguaje (como ChatGPT)?',
    options: [
      'No tengo ni idea',
      'Un buscador que copia páginas web',
      'Un sistema entrenado con muchos textos que genera respuestas prediciendo palabras',
      'Una persona escribiendo en tiempo real',
    ],
    points: [0, 1, 3, 0],
  },
  {
    text: '¿Cómo aplicas la IA en tu trabajo?',
    options: ['No la aplico', 'Solo por curiosidad personal', 'Para tareas puntuales (redactar, resumir, traducir)', 'La tengo integrada en mi forma de trabajar'],
    points: [0, 1, 2, 3],
  },
];

// ---- Preguntas del juego: Cultura General Andaluza ----
// correct = posición (0 o 1) de la opción correcta
const QUESTIONS = [
  { text: 'La Alhambra se encuentra en la ciudad de Granada.', options: ['Verdadero', 'Falso'], correct: 0, info: 'La Alhambra es un conjunto palaciego nazarí situado en Granada.' },
  { text: 'El gazpacho andaluz se sirve tradicionalmente caliente.', options: ['Verdadero', 'Falso'], correct: 1, info: 'El gazpacho es una sopa fría de tomate, pepino, pimiento, ajo, aceite y vinagre.' },
  { text: '¿Cuál es el río más largo de Andalucía?', options: ['Genil', 'Guadalquivir'], correct: 1, info: 'El Guadalquivir recorre Andalucía de este a oeste hasta desembocar en Sanlúcar de Barrameda.' },
  { text: '¿En qué ciudad se encuentra la Giralda?', options: ['Sevilla', 'Córdoba'], correct: 0, info: 'La Giralda es el campanario de la Catedral de Sevilla, antiguo alminar almohade.' },
  { text: 'El flamenco fue declarado Patrimonio Cultural Inmaterial de la Humanidad por la UNESCO.', options: ['Verdadero', 'Falso'], correct: 0, info: 'Fue declarado en 2010.' },
  { text: '¿Cuál es el pico más alto de la península ibérica?', options: ['Aneto', 'Mulhacén'], correct: 1, info: 'El Mulhacén, en Sierra Nevada (Granada), mide 3.479 metros.' },
  { text: '¿Qué ciudad es famosa por su Mezquita-Catedral?', options: ['Córdoba', 'Málaga'], correct: 0, info: 'La Mezquita-Catedral de Córdoba es Patrimonio de la Humanidad desde 1984.' },
  { text: 'El famoso jamón de Jabugo procede de la provincia de Huelva.', options: ['Verdadero', 'Falso'], correct: 0, info: 'Jabugo está en la Sierra de Aracena y Picos de Aroche, en Huelva.' },
  { text: '¿Cuál de estas provincias andaluzas NO tiene costa?', options: ['Cádiz', 'Jaén'], correct: 1, info: 'Jaén (junto con Córdoba y Sevilla) es una provincia de interior.' },
  { text: 'El Día de Andalucía se celebra el 28 de febrero.', options: ['Verdadero', 'Falso'], correct: 0, info: 'Conmemora el referéndum de autonomía del 28 de febrero de 1980.' },
];

const TEAM_NAMES = ['Giralda', 'Alhambra', 'Mezquita', 'Torre del Oro', 'Doñana', 'Sierra Nevada', 'Alcazaba', 'Maestranza', 'Caminito del Rey', 'Cabo de Gata'];
const TEAM_COLORS = ['#0b7a3e', '#d9480f', '#1c7ed6', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5f3dc4', '#2b8a3e', '#f08c00'];

// ---- Servidor ----
const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/quiz', (req, res) => res.json(AI_QUIZ.map(({ text, options }) => ({ text, options }))));

app.get('/api/join-info', async (req, res) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `${proto}://${host}/`;
    const qr = await QRCode.toDataURL(url, { width: 480, margin: 1 });
    res.json({ url, qr });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

// ---- Estado del juego (en memoria) ----
const players = new Map(); // token -> jugador
let state = freshState();
let revealTimer = null;

function freshState() {
  return { phase: 'lobby', teams: [], qIndex: -1, qStatus: 'idle', qEndsAt: 0, teamAnswers: {} };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const normLoc = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const playerName = (token) => (players.get(token) || {}).name || '';

// ---- Generación de grupos heterogéneos ----
function groupsCost(groups, gAI, gExp) {
  let c = 0;
  for (const grp of groups) {
    if (!grp.length) continue;
    const ai = grp.map((p) => p.aiScore / 12);
    const ex = grp.map((p) => Math.min(p.years, 40) / 40);
    c += 30 * (mean(ai) - gAI) ** 2;          // nivel medio de IA parecido entre equipos
    c += 10 * (mean(ex) - gExp) ** 2;         // experiencia media parecida entre equipos
    if (grp.length > 1) c += 0.4 * (1 - (Math.max(...ai) - Math.min(...ai))); // mezclar niveles dentro del equipo
    const cnt = {};
    grp.forEach((p) => { cnt[p.locKey] = (cnt[p.locKey] || 0) + 1; });
    Object.values(cnt).forEach((n) => { c += 0.15 * (n * (n - 1)) / 2; }); // penaliza repetir localidad
  }
  return c;
}

function generateTeams(size) {
  const ready = [...players.values()].filter((p) => p.ready);
  ready.forEach((p) => { p.teamId = null; });
  const k = Math.max(1, Math.ceil(ready.length / size));

  // 1) Reparto "serpiente" por nivel de IA (mezcla expertos y novatos)
  const sorted = shuffle(ready.slice()).sort((a, b) => b.aiScore - a.aiScore);
  const groups = Array.from({ length: k }, () => []);
  sorted.forEach((p, i) => {
    const round = Math.floor(i / k), pos = i % k;
    groups[round % 2 === 0 ? pos : k - 1 - pos].push(p);
  });

  // 2) Mejora por intercambios: localidades y experiencia más variadas
  if (k > 1) {
    const gAI = mean(ready.map((p) => p.aiScore / 12));
    const gExp = mean(ready.map((p) => Math.min(p.years, 40) / 40));
    let best = groupsCost(groups, gAI, gExp);
    for (let i = 0; i < 6000; i++) {
      const a = Math.floor(Math.random() * k), b = Math.floor(Math.random() * k);
      if (a === b || !groups[a].length || !groups[b].length) continue;
      const i1 = Math.floor(Math.random() * groups[a].length);
      const i2 = Math.floor(Math.random() * groups[b].length);
      [groups[a][i1], groups[b][i2]] = [groups[b][i2], groups[a][i1]];
      const c = groupsCost(groups, gAI, gExp);
      if (c < best) best = c;
      else [groups[a][i1], groups[b][i2]] = [groups[b][i2], groups[a][i1]];
    }
  }

  state.teams = groups.map((g, i) => ({
    id: i,
    name: TEAM_NAMES[i % TEAM_NAMES.length] + (i >= TEAM_NAMES.length ? ' ' + (Math.floor(i / TEAM_NAMES.length) + 1) : ''),
    color: TEAM_COLORS[i % TEAM_COLORS.length],
    score: 0,
    lastGain: 0,
    members: g.map((p) => p.token),
  }));
  groups.forEach((g, i) => g.forEach((p) => { p.teamId = i; }));
}

// ---- Juego ----
function openQuestion() {
  state.qStatus = 'open';
  state.teamAnswers = {};
  state.qEndsAt = Date.now() + QUESTION_TIME * 1000;
  state.teams.forEach((t) => { t.lastGain = 0; });
  clearTimeout(revealTimer);
  revealTimer = setTimeout(reveal, QUESTION_TIME * 1000 + 300);
  broadcastAll();
}

function reveal() {
  if (state.phase !== 'playing' || state.qStatus !== 'open') return;
  clearTimeout(revealTimer);
  state.qStatus = 'revealed';
  const q = QUESTIONS[state.qIndex];
  state.teams.forEach((t) => {
    const a = state.teamAnswers[t.id];
    t.lastGain = 0;
    if (a) {
      a.correct = a.choice === q.correct;
      a.gain = 0;
      if (a.correct) {
        const left = Math.max(0, state.qEndsAt - a.at);
        a.gain = 100 + Math.round((50 * left) / (QUESTION_TIME * 1000)); // 100 + bonus por rapidez
        t.score += a.gain;
        t.lastGain = a.gain;
      }
    }
  });
  broadcastAll();
}

// ---- Vistas que se envían a cada cliente ----
function ranking() {
  return state.teams
    .map((t) => ({ id: t.id, name: t.name, color: t.color, score: t.score, gain: t.lastGain }))
    .sort((a, b) => b.score - a.score);
}

function questionView(teamId) {
  if (state.qIndex < 0) return null;
  const q = QUESTIONS[state.qIndex];
  const revealed = state.qStatus === 'revealed';
  const v = {
    index: state.qIndex,
    total: QUESTIONS.length,
    text: q.text,
    options: q.options,
    status: state.qStatus,
    msLeft: revealed ? 0 : Math.max(0, state.qEndsAt - Date.now()),
    totalTime: QUESTION_TIME,
    answered: Object.keys(state.teamAnswers).length,
    teamCount: state.teams.length,
  };
  if (teamId !== null && teamId !== undefined && state.teamAnswers[teamId]) {
    const a = state.teamAnswers[teamId];
    v.mine = { choice: a.choice, by: playerName(a.by) };
  }
  if (revealed) {
    v.correct = q.correct;
    v.info = q.info;
    v.results = state.teams.map((t) => {
      const a = state.teamAnswers[t.id];
      return { teamId: t.id, name: t.name, color: t.color, choice: a ? a.choice : null, correct: !!a && a.correct, gain: a ? a.gain : 0 };
    });
  }
  return v;
}

function playerView(p) {
  const team = p.teamId !== null ? state.teams[p.teamId] : null;
  const showRank = state.phase === 'finished' || (state.phase === 'playing' && state.qStatus === 'revealed');
  return {
    phase: state.phase,
    me: { name: p.name, ready: p.ready },
    team: team
      ? { id: team.id, name: team.name, color: team.color, score: team.score, members: team.members.map((tk) => ({ name: playerName(tk), me: tk === p.token })) }
      : null,
    question: state.phase === 'playing' ? questionView(p.teamId) : null,
    ranking: showRank ? ranking() : null,
  };
}

function adminView() {
  return {
    phase: state.phase,
    players: [...players.values()].map((p) => ({
      name: p.name, ready: p.ready, online: p.online,
      location: p.location || '', years: p.years, ai: p.aiScore, teamId: p.teamId,
    })),
    teams: state.teams.map((t) => ({
      id: t.id, name: t.name, color: t.color, score: t.score, lastGain: t.lastGain,
      members: t.members.map((tk) => {
        const p = players.get(tk);
        return { name: p.name, ai: p.aiScore, location: p.location, years: p.years };
      }),
    })),
    question: state.phase === 'playing' ? questionView(null) : null,
  };
}

function sendPlayer(p) { if (p.socketId) io.to(p.socketId).emit('player:state', playerView(p)); }
function broadcastAdmin() { io.to('admins').emit('admin:state', adminView()); }
function broadcastAll() { players.forEach(sendPlayer); broadcastAdmin(); }

// ---- Conexiones ----
io.on('connection', (socket) => {
  const attach = (p) => { p.socketId = socket.id; p.online = true; socket.data.token = p.token; };

  // === Participantes ===
  socket.on('player:resume', (token, ack) => {
    const p = players.get(token);
    if (!p) return ack && ack({ ok: false });
    attach(p);
    ack && ack({ ok: true });
    sendPlayer(p);
    broadcastAdmin();
  });

  socket.on('player:register', (data, ack) => {
    if (state.phase !== 'lobby') return ack && ack({ ok: false, error: 'Las inscripciones ya están cerradas.' });
    const name = String((data && data.name) || '').trim().slice(0, 30);
    if (!name) return ack && ack({ ok: false, error: 'Escribe tu nombre.' });
    const token = crypto.randomBytes(12).toString('hex');
    const p = { token, name, ready: false, teamId: null, aiScore: 0, years: 0, location: '', locKey: '', socketId: null, online: true };
    players.set(token, p);
    attach(p);
    ack && ack({ ok: true, token });
    sendPlayer(p);
    broadcastAdmin();
  });

  socket.on('player:form', (data, ack) => {
    const p = players.get(socket.data.token);
    if (!p || state.phase !== 'lobby') return ack && ack({ ok: false, error: 'No es posible enviar el formulario ahora.' });
    const answers = data && data.answers;
    const location = String((data && data.location) || '').trim().slice(0, 40);
    const years = Number(data && data.years);
    const valid =
      Array.isArray(answers) && answers.length === AI_QUIZ.length &&
      answers.every((a, i) => Number.isInteger(a) && a >= 0 && a < AI_QUIZ[i].options.length);
    if (!valid || !location || !Number.isFinite(years) || years < 0 || years > 60)
      return ack && ack({ ok: false, error: 'Revisa que todas las respuestas estén completas.' });
    p.aiScore = answers.reduce((s, a, i) => s + AI_QUIZ[i].points[a], 0);
    p.location = location;
    p.locKey = normLoc(location);
    p.years = years;
    p.ready = true;
    ack && ack({ ok: true });
    sendPlayer(p);
    broadcastAdmin();
  });

  socket.on('player:answer', (data) => {
    const p = players.get(socket.data.token);
    if (!p || p.teamId === null || state.phase !== 'playing' || state.qStatus !== 'open') return;
    const q = QUESTIONS[state.qIndex];
    const choice = data && data.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
    if (state.teamAnswers[p.teamId] !== undefined) return; // la primera respuesta del equipo cuenta
    state.teamAnswers[p.teamId] = { choice, by: p.token, at: Date.now() };
    if (Object.keys(state.teamAnswers).length >= state.teams.length) reveal();
    else broadcastAll();
  });

  // === Administrador ===
  socket.on('admin:login', (pin, ack) => {
    if (pin !== ADMIN_PIN) return ack && ack({ ok: false });
    socket.data.isAdmin = true;
    socket.join('admins');
    ack && ack({ ok: true });
    socket.emit('admin:state', adminView());
  });

  const admin = (event, fn) =>
    socket.on(event, (data, ack) => {
      if (!socket.data.isAdmin) return;
      fn(data || {}, ack || (() => {}));
    });

  admin('admin:generate', (data, ack) => {
    if (!['lobby', 'grouped'].includes(state.phase)) return ack({ ok: false, error: 'Ahora no se pueden generar grupos.' });
    const ready = [...players.values()].filter((p) => p.ready).length;
    if (ready < 2) return ack({ ok: false, error: 'Hacen falta al menos 2 participantes con el cuestionario completo.' });
    const size = Math.min(8, Math.max(2, parseInt(data.size, 10) || 4));
    generateTeams(size);
    state.phase = 'grouped';
    const left = players.size - ready;
    ack({ ok: true, left });
    broadcastAll();
  });

  admin('admin:reopen', (data, ack) => {
    if (state.phase !== 'grouped') return ack({ ok: false, error: 'No se puede reabrir ahora.' });
    state.teams = [];
    players.forEach((p) => { p.teamId = null; });
    state.phase = 'lobby';
    ack({ ok: true });
    broadcastAll();
  });

  admin('admin:start', (data, ack) => {
    if (state.phase !== 'grouped') return ack({ ok: false, error: 'Primero genera los grupos.' });
    state.phase = 'playing';
    state.qIndex = 0;
    ack({ ok: true });
    openQuestion();
  });

  admin('admin:reveal', (data, ack) => { reveal(); ack({ ok: true }); });

  admin('admin:next', (data, ack) => {
    if (state.phase !== 'playing' || state.qStatus !== 'revealed') return ack({ ok: false, error: 'Muestra primero la respuesta.' });
    if (state.qIndex + 1 < QUESTIONS.length) {
      state.qIndex++;
      ack({ ok: true });
      openQuestion();
    } else {
      state.phase = 'finished';
      ack({ ok: true });
      broadcastAll();
    }
  });

  admin('admin:reset', (data, ack) => {
    clearTimeout(revealTimer);
    players.forEach((p) => { if (p.socketId) io.to(p.socketId).emit('player:reset'); });
    players.clear();
    state = freshState();
    ack({ ok: true });
    broadcastAll();
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.data.token);
    if (p && p.socketId === socket.id) {
      p.online = false;
      p.socketId = null;
      broadcastAdmin();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`DocentIA funcionando en el puerto ${PORT}`));
