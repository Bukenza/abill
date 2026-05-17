// ═══════════════════════════════════════════════════════
// ABILL — Aprende con Bill
// SM-2 Spaced Repetition + Firebase Push Notifications
// ═══════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyBPAbDOyiBwP2_NNQBKiYClpdZ3_FIQ_n8",
  authDomain: "abill-bb5a6.firebaseapp.com",
  projectId: "abill-bb5a6",
  storageBucket: "abill-bb5a6.firebasestorage.app",
  messagingSenderId: "618659366875",
  appId: "1:618659366875:web:2acfafe17ebd37087449fe"
};

const VAPID_KEY = "BF6ynhbiB0FnwSrNMek5nVJiVZN2eThxggXh2iAmRHwkO3uiMBYvHHB_Cr_ehLZfaM34aMtuy_N7LFj_1oYxeaQ";

// ── STORAGE ──────────────────────────────────────────
function getData(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function setData(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── STATE ─────────────────────────────────────────────
let decks = getData('abill_decks', []);
let cards = getData('abill_cards', []);
let settings = getData('abill_settings', { notifEnabled: false, notifTime: '08:00' });
let stats = getData('abill_stats', { totalReviewed: 0, totalCorrect: 0, streak: 0, lastReviewDate: null });

let reviewQueue = [], reviewIndex = 0, currentCard = null;
let reviewAnswered = false;
let sessionResults = { good: 0, meh: 0, fail: 0 };
let selectedDeckId = null, selectedEmoji = '📈', selectedDif = 'easy', deckOrigin = 'home';
let messagingInstance = null;

// ── SM-2 ALGORITHM ────────────────────────────────────
function getNextInterval(card, quality) {
  const q = quality === 'good' ? 5 : quality === 'meh' ? 3 : 0;
  let { phase = 0, interval = 10, easeFactor = 2.5, repetitions = 0 } = card;

  if (q < 3) return { phase: 0, interval: 10, easeFactor: Math.max(1.3, easeFactor - 0.2), repetitions: 0 };
  if (phase === 0) return { phase: 1, interval: 180, easeFactor, repetitions: 1 };
  if (phase === 1) return { phase: 2, interval: 360, easeFactor, repetitions: 2 };
  if (phase === 2) return { phase: 3, interval: 1440, easeFactor, repetitions: 3 };

  const newEF = Math.max(1.3, easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  let newInterval = repetitions <= 1 ? 1440 : repetitions === 2 ? 6 * 1440 : Math.round(interval * newEF);
  return { phase: phase + 1, interval: newInterval, easeFactor: newEF, repetitions: repetitions + 1 };
}

function applyZoneRestriction(ts, isNewCard) {
  if (!isNewCard) return ts;
  const d = new Date(ts), h = d.getHours();
  if (h >= 22 || h < 7) {
    const next = new Date(ts);
    if (h >= 22) next.setDate(next.getDate() + 1);
    next.setHours(7, 0, 0, 0);
    return next.getTime();
  }
  return ts;
}

function scheduleNextReview(card, quality) {
  const now = Date.now();
  const result = getNextInterval(card, quality);
  let nextTs = now + result.interval * 60 * 1000;
  nextTs = applyZoneRestriction(nextTs, result.phase <= 2);
  return { ...card, ...result, nextReview: nextTs, lastReviewed: now };
}

function getDueCards() {
  const now = Date.now();
  return cards.filter(c => !c.nextReview || c.nextReview <= now);
}
function getDueCount() { return getDueCards().length; }

// ── FIREBASE ──────────────────────────────────────────
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function getDeviceId() {
  let id = localStorage.getItem('abill_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem('abill_device_id', id);
  }
  return id;
}

const DEVICE_ID = getDeviceId();
let firestoreDb = null;

async function initFirestore() {
  if (firestoreDb) return firestoreDb;
  await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
  await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js');
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  firestoreDb = firebase.firestore();
  return firestoreDb;
}

async function saveFcmToken(token) {
  try {
    const db = await initFirestore();
    await db.collection('devices').doc(DEVICE_ID).set({ fcmToken: token, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('Firestore token error:', e); }
}

// Registra cuándo el usuario abre la app o repasa tarjetas
// lastOpenedAt → para re-engagement (5 días sin abrir)
// lastReviewedAt → para zona de silencio (no notificar si repasó hace <2h)
async function updateDeviceActivity(type) {
  try {
    const db = await initFirestore();
    const update = { updatedAt: Date.now() };
    if (type === 'open')   update.lastOpenedAt   = Date.now();
    if (type === 'review') update.lastReviewedAt = Date.now();
    await db.collection('devices').doc(DEVICE_ID).set(update, { merge: true });
  } catch (e) { console.error('Firestore activity error:', e); }
}

// Escribe el documento de notificación pendiente por dispositivo.
// Usa merge:true para NO sobreescribir notifCountToday/todayDate que gestiona el script.
async function savePendingToFirestore(nextReview, pendingCount, notifPhase, dailyNotifHour) {
  try {
    const db = await initFirestore();
    // Guardar la hora preferida del usuario en el documento del dispositivo
    await db.collection('devices').doc(DEVICE_ID)
      .set({ dailyNotifHour, updatedAt: Date.now() }, { merge: true });
    // Guardar la notificación pendiente (merge conserva notifCountToday y todayDate)
    await db.collection('devices').doc(DEVICE_ID)
      .collection('notifications').doc('pending')
      .set({ nextReview, pendingCount, notifPhase, fired: false, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('Firestore pending notif error:', e); }
}

// Guarda la preferencia de hora en Firestore aunque no haya tarjetas pendientes
async function saveDevicePrefs() {
  try {
    const db = await initFirestore();
    const dailyNotifHour = parseInt((settings.notifTime || '08:00').split(':')[0], 10);
    await db.collection('devices').doc(DEVICE_ID)
      .set({ dailyNotifHour, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('Firestore prefs error:', e); }
}

// Recalcula y actualiza el documento pending con la tarjeta más urgente
async function updatePendingNotif() {
  if (!settings.notifEnabled) return;
  const now = Date.now();

  const overdue  = cards.filter(c => !c.nextReview || c.nextReview <= now);
  const upcoming = cards.filter(c => c.nextReview && c.nextReview > now)
    .sort((a, b) => a.nextReview - b.nextReview)[0];

  if (overdue.length === 0 && !upcoming) return;

  // Determinar la fase de notificación según el intervalo mínimo de las tarjetas relevantes
  // Analogía: si tienes tarjetas de varios niveles, mandamos las notificaciones según la más urgente.
  const relevant    = overdue.length > 0 ? overdue : [upcoming];
  const minInterval = Math.min(...relevant.map(c => c.interval || 10)); // interval en minutos

  // notifPhase 1: intervalo < 12h  → tarjeta nueva o reaprendiendo
  // notifPhase 2: intervalo 12–48h → segundo día
  // notifPhase 3: intervalo > 48h  → tercer día en adelante
  const notifPhase = minInterval < 720 ? 1 : minInterval < 2880 ? 2 : 3;

  // Hora diaria del usuario (e.g. "08:00" → 8)
  const dailyNotifHour = parseInt((settings.notifTime || '08:00').split(':')[0], 10);

  const nextReview   = overdue.length > 0 ? now : upcoming.nextReview;
  const pendingCount = overdue.length > 0 ? overdue.length : 1;

  await savePendingToFirestore(nextReview, pendingCount, notifPhase, dailyNotifHour);
}

async function initFirebase() {
  try {
    await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    messagingInstance = firebase.messaging();

    const swReg = await navigator.serviceWorker.ready;
    const token = await messagingInstance.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token) await saveFcmToken(token);

    messagingInstance.onMessage(payload => {
      const { title, body } = payload.notification || {};
      if (title && Notification.permission === 'granted') new Notification(title, { body, icon: '/icons/icon-192.png' });
    });

    return token;
  } catch (e) {
    console.error('Firebase error:', e);
    return null;
  }
}

// Mantiene la firma original para no cambiar las llamadas en saveCard() y evaluateCard()
function scheduleNotif(_cardId, _nextReview, _question, _deckName) {
  updatePendingNotif();
}

// Deprecated — redirige a updatePendingNotif()
function scheduleDailyReminder() {
  updatePendingNotif();
}

async function requestNotifPermission() {
  if (!('Notification' in window)) { alert('Tu navegador no soporta notificaciones.'); return; }
  const perm = await Notification.requestPermission();
  updateNotifStatus();
  if (perm === 'granted') {
    settings.notifEnabled = true;
    document.getElementById('notif-enabled').checked = true;
    setData('abill_settings', settings);
    await initFirebase();
    scheduleDailyReminder();
    document.getElementById('notif-status').textContent = '✅ Notificaciones activadas correctamente';
  }
}

// ── SCREEN NAVIGATION ─────────────────────────────────
let currentScreen = 'screen-home';

function showScreen(id) {
  const prev = document.getElementById(currentScreen);
  const next = document.getElementById(id);
  if (!next) return;
  if (prev && prev !== next) {
    prev.classList.remove('active');
    prev.classList.add('prev');
    setTimeout(() => prev.classList.remove('prev'), 300);
  }
  next.classList.add('active');
  currentScreen = id;
  if (id === 'screen-home') renderHome();
  if (id === 'screen-decks') renderDecks();
  if (id === 'screen-new-card') renderNewCardForm();
  if (id === 'screen-stats') renderStats();
  if (id === 'screen-settings') renderSettings();
}

// ── HOME ──────────────────────────────────────────────
function renderHome() {
  const h = new Date().getHours();
  document.getElementById('greeting-text').textContent = h < 12 ? 'Buenos días 👋' : h < 20 ? 'Buenas tardes 👋' : 'Buenas noches 👋';
  const due = getDueCount();
  document.getElementById('today-title').textContent = due === 0 ? '¡Todo al día! 🎉' : due === 1 ? 'Tienes 1 tarjeta hoy' : `Tienes ${due} tarjetas hoy`;
  document.getElementById('stat-due').textContent = due;
  document.getElementById('stat-streak').textContent = stats.streak + '🔥';
  renderDecksList('decks-list', true);
}

function renderDecksList(containerId, withBadge) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const now = Date.now();
  if (decks.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>Aún no tienes mazos.<br>Crea uno para empezar.</p><button class="btn-primary" onclick="showScreen('screen-new-deck')">Crear primer mazo</button></div>`;
    return;
  }
  container.innerHTML = '';
  decks.forEach(deck => {
    const dc = cards.filter(c => c.deckId === deck.id);
    const due = dc.filter(c => !c.nextReview || c.nextReview <= now).length;

    const card = document.createElement('div');
    card.className = 'deck-card';
    card.addEventListener('click', () => startDeckReview(deck.id));

    const emojiEl = document.createElement('div');
    emojiEl.className = 'deck-emoji';
    emojiEl.textContent = deck.emoji;

    const info = document.createElement('div');
    info.className = 'deck-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'deck-name';
    nameEl.textContent = deck.name;

    const meta = document.createElement('div');
    meta.className = 'deck-meta';
    meta.textContent = `${dc.length} tarjeta${dc.length !== 1 ? 's' : ''}`;

    info.appendChild(nameEl);
    info.appendChild(meta);
    card.appendChild(emojiEl);
    card.appendChild(info);

    if (withBadge) {
      const badge = document.createElement('span');
      badge.className = due > 0 ? 'deck-badge' : 'deck-badge done';
      badge.textContent = due > 0 ? `${due} hoy` : 'Al día ✓';
      card.appendChild(badge);
    }

    container.appendChild(card);
  });
}

function renderDecks() { renderDecksList('decks-list-full', true); }

// ── NEW CARD ──────────────────────────────────────────
function renderNewCardForm() {
  const container = document.getElementById('mazo-pills-new');
  if (!container) return;
  if (decks.length === 0) {
    container.innerHTML = `<button class="mazo-pill" onclick="deckOrigin='new-card';showScreen('screen-new-deck')">+ Crear mazo</button>`;
    selectedDeckId = null; return;
  }
  if (!selectedDeckId || !decks.find(d => d.id === selectedDeckId)) selectedDeckId = decks[0].id;
  container.innerHTML = '';
  decks.forEach(d => {
    const btn = document.createElement('button');
    btn.className = `mazo-pill${d.id === selectedDeckId ? ' selected' : ''}`;
    btn.textContent = `${d.emoji} ${d.name}`;
    btn.addEventListener('click', () => selectDeck(d.id));
    container.appendChild(btn);
  });
  const newBtn = document.createElement('button');
  newBtn.className = 'mazo-pill';
  newBtn.textContent = '+ Nuevo';
  newBtn.addEventListener('click', () => { deckOrigin = 'new-card'; showScreen('screen-new-deck'); });
  container.appendChild(newBtn);
}

function selectDeck(id) { selectedDeckId = id; renderNewCardForm(); }

function selectDif(btn) {
  document.querySelectorAll('.dif-btn').forEach(b => b.classList.remove('active-dif'));
  btn.classList.add('active-dif');
  selectedDif = btn.dataset.dif;
}

function saveCard() {
  const q = document.getElementById('card-question').value.trim();
  const a = document.getElementById('card-answer').value.trim();
  if (!q || !a) { alert('Escribe la pregunta y la respuesta.'); return; }
  if (q.length > 500) { alert('La pregunta no puede superar los 500 caracteres.'); return; }
  if (a.length > 1000) { alert('La respuesta no puede superar los 1000 caracteres.'); return; }
  if (!selectedDeckId) { alert('Selecciona un mazo primero.'); return; }

  const now = Date.now();
  const card = {
    id: 'c' + now, deckId: selectedDeckId, question: q, answer: a, created: now,
    phase: 0, interval: 10, easeFactor: selectedDif === 'easy' ? 2.8 : selectedDif === 'normal' ? 2.5 : 2.0,
    repetitions: 0, nextReview: now + 10 * 60 * 1000, lastReviewed: null,
  };
  cards.push(card);
  setData('abill_cards', cards);

  const deck = decks.find(d => d.id === selectedDeckId);
  scheduleNotif(card.id, card.nextReview, card.question, deck?.name || '');

  document.getElementById('card-question').value = '';
  document.getElementById('card-answer').value = '';
  selectedDif = 'easy';
  document.querySelectorAll('.dif-btn').forEach(b => b.classList.remove('active-dif'));
  document.querySelector('.dif-btn.easy').classList.add('active-dif');
  showScreen('screen-home');
}

// ── NEW DECK ──────────────────────────────────────────
function selectEmoji(btn) {
  document.querySelectorAll('.emoji-opt').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedEmoji = btn.dataset.emoji;
  document.querySelector('.deck-preview-icon').textContent = selectedEmoji;
}

document.getElementById('deck-name').addEventListener('input', function () {
  document.getElementById('deck-preview-name').textContent = this.value || 'Mi mazo';
});

function goBackFromDeck() {
  showScreen(deckOrigin === 'new-card' ? 'screen-new-card' : 'screen-home');
  deckOrigin = 'home';
}

function saveDeck() {
  const name = document.getElementById('deck-name').value.trim();
  if (!name) { alert('Escribe un nombre para el mazo.'); return; }
  if (name.length > 100) { alert('El nombre no puede superar los 100 caracteres.'); return; }
  const deck = { id: 'd' + Date.now(), name, emoji: selectedEmoji };
  decks.push(deck);
  setData('abill_decks', decks);
  selectedDeckId = deck.id;
  document.getElementById('deck-name').value = '';
  document.querySelector('.deck-preview-name').textContent = 'Mi mazo';
  if (deckOrigin === 'new-card') { deckOrigin = 'home'; showScreen('screen-new-card'); }
  else showScreen('screen-home');
}

// ── REVIEW ────────────────────────────────────────────
function startDeckReview(deckId) {
  const now = Date.now();
  reviewQueue = cards.filter(c => c.deckId === deckId && (!c.nextReview || c.nextReview <= now)).sort(() => Math.random() - 0.5);
  if (!reviewQueue.length) { alert('¡No tienes tarjetas pendientes en este mazo!'); return; }
  reviewIndex = 0;
  sessionResults = { good: 0, meh: 0, fail: 0 };
  showScreen('screen-review');
  showCard();
}

function showCard() {
  currentCard = reviewQueue[reviewIndex];
  reviewAnswered = false;
  const deck = decks.find(d => d.id === currentCard.deckId);
  document.getElementById('card-deck-label').textContent = deck ? deck.name.toUpperCase() : 'TARJETA';
  document.getElementById('card-question-text').textContent = currentCard.question;
  document.getElementById('card-answer-text').textContent = currentCard.answer;
  document.getElementById('card-answer-wrap').classList.remove('visible');
  document.getElementById('tap-hint').classList.remove('hidden');
  document.getElementById('review-card').classList.remove('revealed');
  document.getElementById('eval-buttons').classList.remove('visible');
  document.getElementById('btn-next').style.display = 'none';
  document.getElementById('review-progress').style.width = (reviewIndex / reviewQueue.length * 100) + '%';
  document.getElementById('review-counter').textContent = `${reviewIndex + 1}/${reviewQueue.length}`;
}

function revealAnswer() {
  if (reviewAnswered) return;
  document.getElementById('card-answer-wrap').classList.add('visible');
  document.getElementById('tap-hint').classList.add('hidden');
  document.getElementById('review-card').classList.add('revealed');
  document.getElementById('eval-buttons').classList.add('visible');
  reviewAnswered = true;
}

function evaluateCard(quality) {
  if (!reviewAnswered) return;
  sessionResults[quality]++;
  const updated = scheduleNextReview(currentCard, quality);
  const idx = cards.findIndex(c => c.id === currentCard.id);
  if (idx !== -1) { cards[idx] = updated; setData('abill_cards', cards); }
  const deck = decks.find(d => d.id === updated.deckId);
  scheduleNotif(updated.id, updated.nextReview, updated.question, deck?.name || '');
  updateDeviceActivity('review');
  document.getElementById('eval-buttons').classList.remove('visible');
  document.getElementById('btn-next').style.display = 'block';
  if (reviewIndex >= reviewQueue.length - 1) document.getElementById('btn-next').textContent = 'Ver resultados →';
}

function nextCard() {
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) finishReview();
  else showCard();
}

function finishReview() {
  const total = sessionResults.good + sessionResults.meh + sessionResults.fail;
  updateStreak();
  stats.totalReviewed += total;
  stats.totalCorrect += sessionResults.good;
  setData('abill_stats', stats);
  document.getElementById('done-sub').textContent = `Has repasado ${total} tarjeta${total !== 1 ? 's' : ''}.`;
  document.getElementById('done-stats').innerHTML = `
    <div class="done-stat"><div class="done-stat-val" style="color:var(--good)">${sessionResults.good}</div><div class="done-stat-lbl">Sabía</div></div>
    <div class="done-stat"><div class="done-stat-val" style="color:var(--meh)">${sessionResults.meh}</div><div class="done-stat-lbl">Regular</div></div>
    <div class="done-stat"><div class="done-stat-val" style="color:var(--fail)">${sessionResults.fail}</div><div class="done-stat-lbl">Fallé</div></div>`;
  showScreen('screen-done');
}

function exitReview() { showScreen('screen-home'); }

function updateStreak() {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (stats.lastReviewDate === today) return;
  stats.streak = stats.lastReviewDate === yesterday ? stats.streak + 1 : 1;
  stats.lastReviewDate = today;
  setData('abill_stats', stats);
}

// ── STATS ─────────────────────────────────────────────
function renderStats() {
  const accuracy = stats.totalReviewed > 0 ? Math.round((stats.totalCorrect / stats.totalReviewed) * 100) : 0;
  document.getElementById('stats-grid').innerHTML = `
    <div class="stats-big-card"><div class="stats-big-title">Racha actual</div><div class="stats-big-val" style="color:var(--meh)">${stats.streak}🔥</div><div class="stats-big-sub">días consecutivos</div></div>
    <div class="stats-row-2">
      <div class="stats-big-card"><div class="stats-big-title">Tarjetas</div><div class="stats-big-val">${cards.length}</div><div class="stats-big-sub">en total</div></div>
      <div class="stats-big-card"><div class="stats-big-title">Pendientes</div><div class="stats-big-val" style="color:var(--accent2)">${getDueCount()}</div><div class="stats-big-sub">para hoy</div></div>
    </div>
    <div class="stats-row-2">
      <div class="stats-big-card"><div class="stats-big-title">Repasos</div><div class="stats-big-val">${stats.totalReviewed}</div><div class="stats-big-sub">totales</div></div>
      <div class="stats-big-card"><div class="stats-big-title">Precisión</div><div class="stats-big-val" style="color:var(--good)">${accuracy}%</div><div class="stats-big-sub">correctas</div></div>
    </div>`;
}

// ── SETTINGS ──────────────────────────────────────────
function renderSettings() {
  document.getElementById('notif-enabled').checked = settings.notifEnabled;
  document.getElementById('notif-time').value = settings.notifTime || '08:00';
  updateNotifStatus();
}

function saveSettings() {
  settings.notifEnabled = document.getElementById('notif-enabled').checked;
  settings.notifTime = document.getElementById('notif-time').value;
  setData('abill_settings', settings);
  if (settings.notifEnabled) {
    scheduleDailyReminder(); // recalcula pending si hay tarjetas
    saveDevicePrefs();       // guarda la hora aunque no haya tarjetas pendientes
  }
}

function updateNotifStatus() {
  const el = document.getElementById('notif-status');
  if (!('Notification' in window)) { el.textContent = 'Notificaciones no disponibles en este navegador.'; return; }
  if (Notification.permission === 'granted') el.textContent = '✅ Notificaciones activadas';
  else if (Notification.permission === 'denied') el.textContent = '❌ Permiso denegado. Actívalo en Ajustes → Safari.';
  else el.textContent = 'Pulsa el botón para activar las notificaciones.';
}

function confirmReset() {
  if (confirm('¿Seguro? Esta acción borrará todos tus datos y no se puede deshacer.')) {
    localStorage.clear();
    decks = []; cards = [];
    stats = { totalReviewed: 0, totalCorrect: 0, streak: 0, lastReviewDate: null };
    settings = { notifEnabled: false, notifTime: '08:00' };
    showScreen('screen-home');
  }
}

// ── INIT ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js');
      if (Notification.permission === 'granted' && settings.notifEnabled) {
        await initFirebase();
        updatePendingNotif();
      }
    } catch (e) { console.error('SW error:', e); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderHome();
  showScreen('screen-home');
  updateDeviceActivity('open');
  setInterval(() => { if (currentScreen === 'screen-home') renderHome(); }, 60000);
});
