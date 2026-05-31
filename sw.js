// ═══════════════════════════════════════════════════════
// ABILL — Service Worker v2
// Firebase Cloud Messaging + Offline Cache
// ═══════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const CACHE = 'abill-v1.10';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

// ── FIREBASE INIT ─────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyBPAbDOyiBwP2_NNQBKiYClpdZ3_FIQ_n8",
  authDomain: "abill-bb5a6.web.app",
  projectId: "abill-bb5a6",
  storageBucket: "abill-bb5a6.firebasestorage.app",
  messagingSenderId: "618659366875",
  appId: "1:618659366875:web:2acfafe17ebd37087449fe"
});

const messaging = firebase.messaging();

// Identidad única de las notificaciones de Abill. Un solo `tag` garantiza que
// nunca se muestre más de una a la vez: una nueva reemplaza a la anterior.
const NOTIF_TAG = 'abill';
const APP_URL   = 'https://abill-bb5a6.web.app';

// ── BACKGROUND PUSH MESSAGES (app cerrada) ────────────
// El backend envía SOLO datos (sin bloque `notification`) para que el SDK de
// FCM no pinte una notificación ADEMÁS de esta — antes salían DUPLICADAS (una
// del SDK, otra de aquí, con tags distintos, por eso no se fusionaban).
// Construimos la notificación desde payload.data y usamos siempre el mismo tag.
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || '🧠 Abill', {
    body:  d.body || 'Tienes tarjetas para repasar.',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag:   NOTIF_TAG,
    renotify: true,
    data: { url: d.url || APP_URL },
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
  const url = (e.notification.data && e.notification.data.url) || APP_URL;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
