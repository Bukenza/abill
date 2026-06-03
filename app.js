// ═══════════════════════════════════════════════════════
// ABILL — Aprende con Bill
// SM-2 Spaced Repetition + Firebase Push Notifications
// ═══════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyBPAbDOyiBwP2_NNQBKiYClpdZ3_FIQ_n8",
  authDomain: "abill-bb5a6.web.app",
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
  if (['abill_cards', 'abill_decks', 'abill_settings', 'abill_stats'].includes(key)) {
    syncUserData();
  }
}

// ── STATE ─────────────────────────────────────────────
let decks = getData('abill_decks', []);
let cards = getData('abill_cards', []);
let settings = getData('abill_settings', { notifEnabled: false, notifTime: '08:00' });
let stats = getData('abill_stats', { totalReviewed: 0, totalCorrect: 0, streak: 0, lastReviewDate: null, history: {} });

let reviewQueue = [], reviewIndex = 0, currentCard = null;
let reviewAnswered = false;
let sessionResults = { good: 0, meh: 0, fail: 0 };
let selectedDeckId = null, selectedEmoji = '📈', selectedDif = 'easy', deckOrigin = 'home';
let messagingInstance = null;
let expandedDecks = new Set();
let currentUser = null;

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

// ── AUTH ──────────────────────────────────────────────
const AUTH_ERRORS = {
  'auth/invalid-email':           'El email no es válido.',
  'auth/missing-email':           'Escribe tu email.',
  'auth/missing-password':        'Escribe una contraseña.',
  'auth/user-not-found':          'No hay ninguna cuenta con ese email.',
  'auth/wrong-password':          'Email o contraseña incorrectos.',
  'auth/invalid-credential':      'Email o contraseña incorrectos.',
  'auth/invalid-login-credentials': 'Email o contraseña incorrectos.',
  'auth/email-already-in-use':    'Ya existe una cuenta con ese email.',
  'auth/weak-password':           'La contraseña debe tener al menos 6 caracteres.',
  'auth/too-many-requests':       'Demasiados intentos. Espera unos minutos.',
  'auth/network-request-failed':  'Sin conexión. Revisa tu internet.',
  'auth/operation-not-allowed':   'Este método de login no está habilitado.',
  'auth/popup-blocked':           'El navegador ha bloqueado la ventana emergente.',
};

function showAuthMessage(type, msg) {
  const errEl = document.getElementById('login-error');
  const okEl  = document.getElementById('login-success');
  errEl.style.display = 'none';
  okEl.style.display  = 'none';
  if (!msg) return;
  const target = type === 'error' ? errEl : okEl;
  target.textContent = msg;
  target.style.display = 'block';
}

function showLoginError(msg) { showAuthMessage('error', msg); }

function handleAuthError(e) {
  console.error('Auth error:', e);
  showLoginError(AUTH_ERRORS[e.code] || e.message || 'Ha ocurrido un error.');
}

function toggleAuthView(view) {
  ['login', 'register', 'reset'].forEach(v => {
    const el = document.getElementById('auth-view-' + v);
    if (el) el.style.display = (v === view) ? '' : 'none';
  });
  showAuthMessage(null, '');
  ['login-email', 'login-password', 'register-email', 'register-password', 'reset-email']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const sub = document.getElementById('auth-sub');
  if (sub) sub.textContent =
    view === 'register' ? 'Crea tu cuenta' :
    view === 'reset'    ? 'Recupera tu acceso' :
                          'Aprende con repetición espaciada';
}

async function initAuth() {
  await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
  await loadScript('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js');
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
}

async function signInWithEmail() {
  showAuthMessage(null, '');
  const email = document.getElementById('login-email').value.trim();
  const pwd   = document.getElementById('login-password').value;
  if (!email || !pwd) { showLoginError('Rellena email y contraseña.'); return; }
  try {
    await firebase.auth().signInWithEmailAndPassword(email, pwd);
  } catch (e) { handleAuthError(e); }
}

async function registerWithEmail() {
  showAuthMessage(null, '');
  const email = document.getElementById('register-email').value.trim();
  const pwd   = document.getElementById('register-password').value;
  if (!email || !pwd) { showLoginError('Rellena email y contraseña.'); return; }
  if (pwd.length < 6) { showLoginError('La contraseña debe tener al menos 6 caracteres.'); return; }
  try {
    await firebase.auth().createUserWithEmailAndPassword(email, pwd);
  } catch (e) { handleAuthError(e); }
}

async function resetPassword() {
  showAuthMessage(null, '');
  const email = document.getElementById('reset-email').value.trim();
  if (!email) { showLoginError('Escribe tu email.'); return; }
  try {
    await firebase.auth().sendPasswordResetEmail(email);
    showAuthMessage('success', '✉️ Te hemos enviado un enlace a ' + email + '. Revisa tu bandeja.');
  } catch (e) { handleAuthError(e); }
}

// Login con Google retirado en v1.9.1: en la PWA instalada en iOS, tanto el popup
// (se abre fuera de la app) como el redirect (Safari bloquea el almacenamiento de
// terceros, ITP) fallan con auth/internal-error. El login por email/contraseña es
// la única vía fiable en iOS. Ver memoria "social-login-ios-pwa" para la próxima app.

async function signOut() {
  if (confirm('¿Cerrar sesión?')) {
    await firebase.auth().signOut();
    window.location.reload();
  }
}

async function loadUserData() {
  if (!currentUser) return;
  const db = await initFirestore();
  const doc = await db.collection('users').doc(currentUser.uid).get();
  if (doc.exists) {
    const d = doc.data();
    if (d.cards)    { cards    = d.cards;                              localStorage.setItem('abill_cards',    JSON.stringify(cards)); }
    if (d.decks)    { decks    = d.decks;                              localStorage.setItem('abill_decks',    JSON.stringify(decks)); }
    if (d.settings) { settings = { ...settings, ...d.settings };      localStorage.setItem('abill_settings', JSON.stringify(settings)); }
    if (d.stats)    { stats    = { ...stats,    ...d.stats };          localStorage.setItem('abill_stats',    JSON.stringify(stats)); }
  } else {
    // Primera vez: migrar datos existentes de localStorage a Firestore
    await syncUserData();
  }
}

async function syncUserData() {
  if (!currentUser) return;
  try {
    const db = await initFirestore();
    await db.collection('users').doc(currentUser.uid)
      .set({ cards, decks, settings, stats, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('Firestore sync error:', e); }
}

async function saveFcmToken(token) {
  if (!currentUser) return;
  try {
    const db = await initFirestore();
    await db.collection('users').doc(currentUser.uid)
      .collection('devices').doc(DEVICE_ID)
      .set({ fcmToken: token, updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('Firestore token error:', e); }
}

// Registra cuándo el usuario abre la app o repasa tarjetas
// lastOpenedAt → para re-engagement (5 días sin abrir)
// lastReviewedAt → para zona de silencio (no notificar si repasó hace <2h)
async function updateDeviceActivity(type) {
  if (!currentUser) return;
  try {
    const db = await initFirestore();
    const update = { updatedAt: Date.now() };
    if (type === 'open')   update.lastOpenedAt   = Date.now();
    if (type === 'review') update.lastReviewedAt = Date.now();
    await db.collection('users').doc(currentUser.uid)
      .collection('devices').doc(DEVICE_ID)
      .set(update, { merge: true });
  } catch (e) { console.error('Firestore activity error:', e); }
}

// Escribe el documento de notificación pendiente por dispositivo.
// Usa merge:true para NO sobreescribir notifCountToday/todayDate que gestiona el script.
async function savePendingToFirestore(nextReview, pendingCount, notifPhase, dailyNotifHour) {
  if (!currentUser) return;
  try {
    const db = await initFirestore();
    const deviceRef = db.collection('users').doc(currentUser.uid)
      .collection('devices').doc(DEVICE_ID);

    await deviceRef.set({ dailyNotifHour, updatedAt: Date.now() }, { merge: true });

    const pendingRef = deviceRef.collection('notifications').doc('pending');

    // Nunca acortar el nextReview existente: si el backend estableció un snooze
    // (p.ej. nextReview = now+2h) y el usuario evalúa tarjetas dentro de la app,
    // no reseteamos ese snooze a "now" o podríamos enviar notificaciones duplicadas.
    const existing = await pendingRef.get();
    const existingNextReview = existing.exists ? (existing.data().nextReview || 0) : 0;
    const effectiveNextReview = Math.max(nextReview, existingNextReview);

    await pendingRef.set(
      { nextReview: effectiveNextReview, pendingCount, notifPhase, fired: false, updatedAt: Date.now() },
      { merge: true }
    );
  } catch (e) { console.error('Firestore pending notif error:', e); }
}

// Guarda la preferencia de hora en Firestore aunque no haya tarjetas pendientes
async function saveDevicePrefs() {
  if (!currentUser) return;
  try {
    const db = await initFirestore();
    const dailyNotifHour = parseInt((settings.notifTime || '08:00').split(':')[0], 10);
    await db.collection('users').doc(currentUser.uid)
      .collection('devices').doc(DEVICE_ID)
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

    // App en primer plano: el backend manda SOLO datos (sin bloque `notification`),
    // así que leemos de payload.data. Mostramos a través del Service Worker —
    // un único origen de notificaciones (sin duplicados) y, además, `new
    // Notification()` no existe dentro de la página en la PWA de iOS.
    messagingInstance.onMessage(payload => {
      const d = payload.data || payload.notification || {};
      if (d.title && Notification.permission === 'granted') {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(d.title, {
          body: d.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
          tag: 'abill', renotify: true, data: { url: d.url || '/' },
        })).catch(() => {});
      }
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

// ── GLOBITO (BADGE) Y LIMPIEZA DE NOTIFICACIONES ──────
// Solo en la PWA instalada en iOS 16.4+ (Badging API). El globito rojo con el
// número lo pone el Service Worker al llegar una push (ver sw.js). Aquí lo
// quitamos y cerramos las notificaciones que sigan en pantalla al entrar.
function clearAppBadge() {
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
}

async function dismissNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.getNotifications) {
      const list = await reg.getNotifications();
      list.forEach(n => n.close());
    }
  } catch (e) { /* no soportado en este navegador: se ignora */ }
}

// Cada vez que la app vuelve a primer plano: marca actividad (desbloquea el
// siguiente aviso en el backend), quita el globito, cierra las notificaciones
// que sigan en pantalla y refresca el inicio.
function onAppForeground() {
  if (!currentUser) return;
  updateDeviceActivity('open');
  clearAppBadge();
  dismissNotifications();
  if (currentScreen === 'screen-home') renderHome();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onAppForeground();
});

// ── SCREEN NAVIGATION ─────────────────────────────────
// Orden lógico de las pantallas (izquierda→derecha en la barra inferior y,
// después, las pantallas "profundas" que se abren desde otras). La POSICIÓN en
// esta lista decide la dirección del deslizamiento: ir a un índice mayor =
// avanzar (la nueva entra desde la derecha); menor = volver (entra desde la
// izquierda). Las pantallas que NO están en la lista (login, loading) entran
// con un fundido, sin deslizamiento.
const SCREEN_ORDER = [
  'screen-home', 'screen-decks', 'screen-new-card',
  'screen-stats', 'screen-settings', 'screen-new-deck',
  'screen-review', 'screen-done',
];
const SCREEN_ANIM_CLASSES = ['push-in', 'push-out', 'pop-in', 'pop-out', 'fade-in'];
const SCREEN_ANIM_MS = 420; // > duración CSS (0.34s); margen para el fallback

let currentScreen = 'screen-loading';
let navSeq = 0;

// Cada pantalla pinta su contenido justo antes de mostrarse
function renderScreen(id) {
  if (id === 'screen-home')      renderHome();
  else if (id === 'screen-decks')    renderDecks();
  else if (id === 'screen-new-card') renderNewCardForm();
  else if (id === 'screen-stats')    renderStats();
  else if (id === 'screen-settings') renderSettings();
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Deja una única pantalla activa y sin clases de animación. Corta en seco
// cualquier transición a medias (taps rápidos) para no acumular estado.
function settleScreens() {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove(...SCREEN_ANIM_CLASSES);
    if (s.id !== currentScreen) s.classList.remove('active');
  });
}

// Quita las clases de animación al terminar (animationend), con un fallback por
// si no dispara (reduce-motion, pestaña en segundo plano…). El token evita que
// un timer viejo borre las clases de una transición posterior sobre la misma
// pantalla.
function clearAfterAnim(el, token, alsoDeactivate) {
  const done = () => {
    if (el.dataset.navToken !== String(token)) return;
    el.classList.remove(...SCREEN_ANIM_CLASSES);
    if (alsoDeactivate) el.classList.remove('active');
  };
  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, SCREEN_ANIM_MS);
}

function showScreen(id) {
  const next = document.getElementById(id);
  if (!next) return;
  if (id === currentScreen) { renderScreen(id); return; }

  settleScreens();
  const prev = document.getElementById(currentScreen);
  renderScreen(id);

  const fromIdx = SCREEN_ORDER.indexOf(currentScreen);
  const toIdx   = SCREEN_ORDER.indexOf(id);
  const slide   = fromIdx !== -1 && toIdx !== -1 && !prefersReducedMotion();
  const forward = toIdx >= fromIdx;
  const token   = ++navSeq;

  next.dataset.navToken = String(token);
  next.classList.add('active');
  next.classList.add(slide ? (forward ? 'push-in' : 'pop-in') : 'fade-in');
  clearAfterAnim(next, token, false);

  if (prev && prev !== next) {
    if (slide) {
      prev.dataset.navToken = String(token);
      prev.classList.add(forward ? 'push-out' : 'pop-out');
      clearAfterAnim(prev, token, true);
    } else {
      prev.classList.remove('active');
    }
  }

  currentScreen = id;
}

// ── SWIPE LATERAL ENTRE PESTAÑAS ──────────────────────
// Deslizar el dedo en horizontal cambia entre las 4 pantallas principales de
// la barra inferior. Las pantallas "profundas" (nueva tarjeta, repaso, etc.)
// quedan fuera a propósito: se entra y se sale de ellas con botones.
const TAB_SCREENS = ['screen-home', 'screen-decks', 'screen-stats', 'screen-settings'];

let swipeX = 0, swipeY = 0, swipeValid = false;

document.addEventListener('touchstart', e => {
  // Solo gestos de un dedo y que NO empiecen sobre un campo editable
  if (e.touches.length !== 1 || e.target.closest('input, textarea, select')) {
    swipeValid = false;
    return;
  }
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
  swipeValid = true;
}, { passive: true });

document.addEventListener('touchend', e => {
  if (!swipeValid) return;
  swipeValid = false;
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  // Horizontal claro: recorrido > 60px y al menos el doble que el vertical
  // (así no se dispara al hacer scroll vertical).
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
  const i = TAB_SCREENS.indexOf(currentScreen);
  if (i === -1) return; // solo en las pestañas principales
  const next = dx < 0 ? i + 1 : i - 1; // arrastrar a la izquierda = avanzar
  if (next >= 0 && next < TAB_SCREENS.length) showScreen(TAB_SCREENS[next]);
}, { passive: true });

// ── DESACTIVAR ZOOM (pellizco) ────────────────────────
// Refuerza el viewport (maximum-scale=1, user-scalable=no): Safari iOS a veces
// ignora el meta, así que bloqueamos también sus gestos de pellizco.
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
  document.addEventListener(ev, e => e.preventDefault())
);

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

function renderDecks() { renderDecksExpandable('decks-list-full'); }

function renderDecksExpandable(containerId) {
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
    const isOpen = expandedDecks.has(deck.id);

    const wrapper = document.createElement('div');
    wrapper.className = 'deck-expandable';

    // ── Cabecera clicable ──
    const header = document.createElement('div');
    header.className = 'deck-expand-toggle' + (isOpen ? ' open' : '');

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

    const badge = document.createElement('span');
    badge.className = due > 0 ? 'deck-badge' : 'deck-badge done';
    badge.textContent = due > 0 ? `${due} hoy` : 'Al día ✓';

    const chevron = document.createElement('span');
    chevron.className = 'deck-chevron';
    chevron.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    header.appendChild(emojiEl);
    header.appendChild(info);
    header.appendChild(badge);
    header.appendChild(chevron);

    header.addEventListener('click', () => {
      if (expandedDecks.has(deck.id)) expandedDecks.delete(deck.id);
      else expandedDecks.add(deck.id);
      renderDecks();
    });

    // ── Lista de tarjetas ──
    const itemsList = document.createElement('div');
    itemsList.className = 'deck-items-list' + (isOpen ? '' : ' hidden');

    if (dc.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'deck-items-empty';
      empty.textContent = 'Este mazo no tiene tarjetas aún.';
      itemsList.appendChild(empty);
    } else {
      dc.forEach(card => {
        const row = document.createElement('div');
        row.className = 'deck-item-row';

        const questionEl = document.createElement('span');
        questionEl.className = 'deck-item-question';
        questionEl.textContent = card.question;

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-card-delete';
        delBtn.title = 'Borrar tarjeta';
        delBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          deleteCard(card.id);
        });

        row.appendChild(questionEl);
        row.appendChild(delBtn);
        itemsList.appendChild(row);
      });
    }

    wrapper.appendChild(header);
    wrapper.appendChild(itemsList);
    container.appendChild(wrapper);
  });
}

function deleteCard(cardId) {
  cards = cards.filter(c => c.id !== cardId);
  setData('abill_cards', cards);
  updatePendingNotif();
  renderDecks();
}

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
  if (!stats.history) stats.history = {};
  const todayKey = new Date().toISOString().split('T')[0];
  stats.history[todayKey] = (stats.history[todayKey] || 0) + total;
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
function renderCalendar() {
  const el = document.getElementById('stats-cal-section');
  if (!el) return;
  const history  = stats.history || {};
  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const year     = today.getFullYear();
  const month    = today.getMonth();
  const MNAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DLBLS  = ['L','M','X','J','V','S','D'];
  const firstDay    = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;
  let html = `<div class="cal-mv-title">${MNAMES[month]} <span class="cal-mv-year">${year}</span></div>`;
  html += '<div class="cal-mv-weekdays">';
  DLBLS.forEach(d => { html += `<div class="cal-mv-wlbl">${d}</div>`; });
  html += '</div><div class="cal-mv-grid">';
  for (let i = 0; i < startDow; i++) html += '<div class="cal-mv-cell cal-mv-empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const mm  = String(month + 1).padStart(2, '0');
    const dd  = String(day).padStart(2, '0');
    const key = `${year}-${mm}-${dd}`;
    const done    = (history[key] || 0) > 0;
    const isToday = key === todayStr;
    const future  = key > todayStr;
    const cls = ['cal-mv-cell', done && !future ? 'cal-mv-done' : '', isToday ? 'cal-mv-today' : '', future ? 'cal-mv-future' : ''].filter(Boolean).join(' ');
    const inner = done && !future ? '<span class="cal-mv-ltr">B</span>' : `<span class="cal-mv-num">${day}</span>`;
    html += `<div class="${cls}"><div class="cal-mv-circle">${inner}</div></div>`;
  }
  const totalCells = startDow + daysInMonth;
  const remainder  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let d = 1; d <= remainder; d++) {
    html += `<div class="cal-mv-cell cal-mv-overflow"><div class="cal-mv-circle"><span class="cal-mv-num">${d}</span></div></div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

function getBillBannerContent() {
  const due = getDueCount();
  if (cards.length === 0)  return 'Crea tu primera tarjeta 👋';
  if (due === 0)           return 'Todo al día — sin pendientes hoy 🎉';
  if (stats.streak >= 7)  return `${stats.streak} días de racha — ¡imparable! 🔥`;
  if (stats.streak >= 3)  return `${stats.streak} días de racha — ¡sigue así! 🔥`;
  if (stats.streak === 1) return 'Primer día completado ⭐';
  return `${due} tarjeta${due !== 1 ? 's' : ''} pendiente${due !== 1 ? 's' : ''} hoy`;
}

function renderStats() {
  const subEl = document.getElementById('bill-banner-sub');
  if (subEl) subEl.textContent = getBillBannerContent();
  renderCalendar();
  const accuracy = stats.totalReviewed > 0 ? Math.round((stats.totalCorrect / stats.totalReviewed) * 100) : 0;
  document.getElementById('stats-grid').innerHTML = `
    <div class="stats-row-2">
      <div class="stats-big-card"><div class="stats-big-title">Racha</div><div class="stats-big-val" style="color:var(--meh)">${stats.streak}🔥</div><div class="stats-big-sub">días seguidos</div></div>
      <div class="stats-big-card"><div class="stats-big-title">Tarjetas</div><div class="stats-big-val">${cards.length}</div><div class="stats-big-sub">en total</div></div>
    </div>
    <div class="stats-row-2">
      <div class="stats-big-card"><div class="stats-big-title">Pendientes</div><div class="stats-big-val" style="color:var(--accent2)">${getDueCount()}</div><div class="stats-big-sub">para hoy</div></div>
      <div class="stats-big-card"><div class="stats-big-title">Precisión</div><div class="stats-big-val" style="color:var(--good)">${accuracy}%</div><div class="stats-big-sub">correctas</div></div>
    </div>`;
}

// ── SETTINGS ──────────────────────────────────────────
function renderSettings() {
  document.getElementById('notif-enabled').checked = settings.notifEnabled;
  document.getElementById('notif-time').value = settings.notifTime || '08:00';
  updateNotifStatus();
  const el = document.getElementById('user-email-display');
  if (el && currentUser) el.textContent = currentUser.email || 'Sesión iniciada';
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
  const btn = document.getElementById('notif-btn');
  const setBtn = (text, activated) => {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = activated;
    btn.classList.toggle('btn-activated', activated);
  };
  if (!('Notification' in window)) {
    if (el) el.textContent = 'No disponible en este navegador.';
    setBtn('Activar notificaciones push', false);
    return;
  }
  if (Notification.permission === 'granted') {
    if (el) el.textContent = 'Activadas ✓ — recibirás tus recordatorios';
    setBtn('✓ Notificaciones activadas', true);
  } else if (Notification.permission === 'denied') {
    if (el) el.textContent = 'Permiso denegado. Actívalo en Ajustes → Safari.';
    setBtn('Activar notificaciones push', false);
  } else {
    if (el) el.textContent = 'Pulsa para recibir recordatorios de repaso';
    setBtn('Activar notificaciones push', false);
  }
}

function confirmReset() {
  if (confirm('¿Seguro? Esta acción borrará todos tus datos y no se puede deshacer.')) {
    decks = []; cards = [];
    stats = { totalReviewed: 0, totalCorrect: 0, streak: 0, lastReviewDate: null };
    settings = { notifEnabled: false, notifTime: '08:00' };
    localStorage.clear();
    if (currentUser) {
      initFirestore().then(db =>
        db.collection('users').doc(currentUser.uid)
          .set({ cards: [], decks: [], settings, stats, updatedAt: Date.now() })
      ).catch(() => {});
    }
    showScreen('screen-home');
  }
}

// ── CONSENTIMIENTO GDPR ───────────────────────────────
function checkConsent() {
  const accepted = localStorage.getItem('abill_consent');
  if (!accepted) {
    document.getElementById('consent-overlay').style.display = 'flex';
  }
}

function acceptConsent() {
  localStorage.setItem('abill_consent', '1');
  const overlay = document.getElementById('consent-overlay');
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 0.3s ease';
  setTimeout(() => overlay.style.display = 'none', 300);
}

// ── INIT ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js');
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'SW_UPDATED') window.location.reload();
      });
    } catch (e) { console.error('SW error:', e); }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await initAuth();

  let homeReady = false;
  firebase.auth().onAuthStateChanged(async (user) => {
    currentUser = user;
    if (user) {
      try { await loadUserData(); } catch (e) { console.error('Error cargando datos:', e); }
      checkConsent();
      renderHome();
      showScreen('screen-home');
      updateDeviceActivity('open');
      clearAppBadge();
      dismissNotifications();
      if (Notification.permission === 'granted' && settings.notifEnabled) {
        initFirebase().then(() => updatePendingNotif());
      }
      if (!homeReady) {
        homeReady = true;
        setInterval(() => { if (currentScreen === 'screen-home') renderHome(); }, 60000);
      }
    } else {
      showScreen('screen-login');
    }
  });
});
