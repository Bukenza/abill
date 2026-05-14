// ═══════════════════════════════════════════════════════
// ABILL — Service Worker v2
// Firebase Cloud Messaging + Offline Cache
// ═══════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const CACHE = 'abill-v2';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

// ── FIREBASE INIT ─────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyBPAbDOyiBwP2_NNQBKiYClpdZ3_FIQ_n8",
  authDomain: "abill-bb5a6.firebaseapp.com",
  projectId: "abill-bb5a6",
  storageBucket: "abill-bb5a6.firebasestorage.app",
  messagingSenderId: "618659366875",
  appId: "1:618659366875:web:2acfafe17ebd37087449fe"
});

const messaging = firebase.messaging();

// ── BACKGROUND PUSH MESSAGES (app cerrada) ────────────
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  return self.registration.showNotification(title || '🧠 Abill', {
    body: body || 'Tienes tarjetas para repasar.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'abill-review',
    renotify: true,
    data: { url: '/' },
  });
});

// ── INSTALL ───────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH (offline first) ─────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request))
      .catch(() => {
        if (e.request.destination === 'document') return caches.match('/index.html');
        return new Response('', { status: 503 });
      })
  );
});

// ── LOCAL NOTIFICATION SCHEDULING ────────────────────
// Stores scheduled notifications and fires them at the right time
// This handles the case when the app is in background (not fully closed)
let scheduled = [];

self.addEventListener('message', e => {
  if (!e.data || typeof e.data !== 'object') return;
  const { type } = e.data;

  if (type === 'SCHEDULE_NOTIFICATION') {
    const { cardId, nextReview, question, deckName } = e.data;
    if (typeof cardId !== 'string' || typeof nextReview !== 'number') return;
    scheduled = scheduled.filter(n => n.cardId !== cardId);
    scheduled.push({ cardId, nextReview, question: String(question || '').substring(0, 200), deckName: String(deckName || '').substring(0, 100), fired: false });
    scheduleCheck();
  }

  if (type === 'SCHEDULE_DAILY') {
    const { hour, minute } = e.data;
    if (typeof hour !== 'number' || typeof minute !== 'number') return;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    scheduled = scheduled.filter(n => n.type !== 'daily');
    scheduled.push({ type: 'daily', nextReview: next.getTime(), hour, minute, fired: false });
    scheduleCheck();
  }
});

function scheduleCheck() {
  const next = scheduled.filter(n => !n.fired).sort((a, b) => a.nextReview - b.nextReview)[0];
  if (!next) return;
  const delay = Math.max(0, next.nextReview - Date.now());
  setTimeout(() => fireScheduled(), delay + 1000);
}

async function fireScheduled() {
  const now = Date.now();
  for (const notif of scheduled) {
    if (!notif.fired && notif.nextReview <= now) {
      notif.fired = true;
      if (notif.type === 'daily') {
        await self.registration.showNotification('⏰ Abill — hora de repasar', {
          body: 'Abre la app para ver tus tarjetas del día.',
          icon: '/icons/icon-192.png',
          tag: 'abill-daily',
          renotify: true,
          data: { url: '/' },
        });
        // Reschedule for tomorrow
        const next = new Date(notif.nextReview);
        next.setDate(next.getDate() + 1);
        notif.nextReview = next.getTime();
        notif.fired = false;
      } else {
        const body = notif.question
          ? `${notif.deckName ? '[' + notif.deckName + '] ' : ''}${notif.question.substring(0, 80)}${notif.question.length > 80 ? '...' : ''}`
          : 'Tienes una tarjeta para repasar.';
        await self.registration.showNotification('🧠 Abill — toca repasar', {
          body,
          icon: '/icons/icon-192.png',
          tag: `abill-${notif.cardId}`,
          renotify: true,
          data: { url: '/' },
        });
      }
    }
  }
  scheduleCheck();
}

// ── NOTIFICATION CLICK ────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});
