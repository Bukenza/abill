// ═══════════════════════════════════════════════════════
// ABILL — Service Worker v2
// Firebase Cloud Messaging + Offline Cache
// ═══════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const CACHE = 'abill-v7';
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
    caches.keys().then(keys => {
      const oldCaches = keys.filter(k => k !== CACHE);
      const isUpdate  = oldCaches.length > 0; // true solo si había versión anterior
      return Promise.all(oldCaches.map(k => caches.delete(k)))
        .then(() => self.clients.claim())
        .then(() => {
          // Si es una actualización (no primera instalación), avisar a la app para recargar
          if (isUpdate) {
            return self.clients.matchAll({ type: 'window' })
              .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })));
          }
        });
    })
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

// Notificaciones gestionadas por GitHub Actions + Firestore.
// El SW solo recibe pushes FCM via onBackgroundMessage (arriba).

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
