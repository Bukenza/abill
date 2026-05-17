// ═══════════════════════════════════════════════════════════════════════
// ABILL — GitHub Action: Send Push Notifications
// ───────────────────────────────────────────────────────────────────────
//
// CUÁNDO CORRE: 3 veces al día (8:00 / 13:00 / 20:00 hora española)
//
// LÓGICA DE NOTIFICACIONES REGULARES:
//   Antes de enviar, comprueba:
//   1. ¿Hay tarjetas pendientes? (nextReview <= ahora)
//   2. ¿El usuario repasó hace menos de 2 horas? → no enviar (zona silencio)
//   3. ¿Ya se envió una notificación hace menos de 2 horas? → no enviar
//   Si todo OK → envía 1 notificación y programa snooze 2h
//
// LÓGICA RE-ENGAGEMENT (los lunes a las 8:00):
//   Si el usuario no ha abierto la app en 5+ días → notificación de recuperación
//   Esta notificación SÍ puede solaparse con las regulares
//
// ═══════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db        = admin.firestore();
const messaging = admin.messaging();

const QUIET_ZONE_MS       = 2 * 60 * 60 * 1000;  // 2 horas
const REENGAGEMENT_DAYS   = 5;
const REENGAGEMENT_MS     = REENGAGEMENT_DAYS * 24 * 60 * 60 * 1000;

async function run() {
  const now     = Date.now();
  const nowDate = new Date();
  const isMonday        = nowDate.getUTCDay() === 1;
  const isMorningWindow = nowDate.getUTCHours() === 6; // 8:00 España

  const devicesSnapshot = await db.collection('devices').get();

  for (const deviceDoc of devicesSnapshot.docs) {
    const device = deviceDoc.data();
    const { fcmToken } = device;
    if (!fcmToken) continue;

    // ── NOTIFICACIÓN REGULAR ────────────────────────────────────────
    await sendRegularIfDue(deviceDoc, device, fcmToken, now);

    // ── NOTIFICACIÓN RE-ENGAGEMENT (solo lunes a las 8:00) ──────────
    if (isMonday && isMorningWindow) {
      await sendReengagementIfInactive(deviceDoc, device, fcmToken, now);
    }
  }

  console.log('[DONE] Ciclo completado.');
}

// ── NOTIFICACIÓN REGULAR ──────────────────────────────────────────────
async function sendRegularIfDue(deviceDoc, device, fcmToken, now) {
  const pendingRef = deviceDoc.ref.collection('notifications').doc('pending');
  const pendingDoc = await pendingRef.get();

  if (!pendingDoc.exists) return;

  const pending = pendingDoc.data();

  // ¿Ya fue enviada?
  if (pending.fired === true) return;

  // ¿Aún no toca?
  if (pending.nextReview > now) return;

  // ¿El usuario repasó hace menos de 2 horas? (zona de silencio)
  if (device.lastReviewedAt && (now - device.lastReviewedAt) < QUIET_ZONE_MS) {
    console.log(`[SKIP] ${deviceDoc.id} — repasó hace menos de 2h`);
    return;
  }

  // ¿Ya se envió una notificación hace menos de 2 horas?
  if (pending.lastNotifiedAt && (now - pending.lastNotifiedAt) < QUIET_ZONE_MS) {
    console.log(`[SKIP] ${deviceDoc.id} — notificación reciente`);
    return;
  }

  // Bloqueo optimista: marcar fired:true ANTES de enviar
  await pendingRef.update({ fired: true, updatedAt: now });

  try {
    const count    = pending.pendingCount || 0;
    const bodyText = count > 1
      ? `Tienes ${count} tarjetas para repasar. ¡No pierdas tu racha! 🔥`
      : 'Tienes tarjetas para repasar. ¡No pierdas tu racha! 🔥';

    await messaging.send({
      token: fcmToken,
      notification: { title: '🧠 Abill — hora de repasar', body: bodyText },
      webpush: {
        notification: { icon: '/icons/icon-192.png', tag: 'abill-pending', renotify: true },
        fcmOptions: { link: 'https://abill-bb5a6.web.app' }
      }
    });

    console.log(`[OK] Regular → ${deviceDoc.id} (${count} tarjetas)`);

    // Snooze: si no abre la app, renotificar en la próxima ventana (2h)
    await pendingRef.update({
      fired:          false,
      nextReview:     now + QUIET_ZONE_MS,
      lastNotifiedAt: now,
      updatedAt:      now,
    });

  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      await deviceDoc.ref.delete();
      console.log(`[CLEANED] Token inválido, dispositivo eliminado: ${deviceDoc.id}`);
    } else {
      await pendingRef.update({ fired: false, updatedAt: now });
      console.error(`[ERROR] ${deviceDoc.id}: ${err.message}`);
    }
  }
}

// ── NOTIFICACIÓN RE-ENGAGEMENT ────────────────────────────────────────
async function sendReengagementIfInactive(deviceDoc, device, fcmToken, now) {
  const lastOpened = device.lastOpenedAt || 0;
  const inactiveSince = now - lastOpened;

  // Solo si lleva 5+ días sin abrir la app
  if (inactiveSince < REENGAGEMENT_MS) return;

  try {
    await messaging.send({
      token: fcmToken,
      notification: {
        title: '👋 Abill te echa de menos',
        body:  'Estás a 5 min de seguir el camino del éxito',
      },
      webpush: {
        notification: {
          icon:     '/icons/icon-192.png',
          tag:      'abill-reengagement',
          renotify: true,
        },
        fcmOptions: { link: 'https://abill-bb5a6.web.app' }
      }
    });

    console.log(`[RE-ENGAGEMENT] Enviado a ${deviceDoc.id} (inactivo ${Math.round(inactiveSince / 86400000)} días)`);

  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered') {
      await deviceDoc.ref.delete();
    } else {
      console.error(`[RE-ENGAGEMENT ERROR] ${deviceDoc.id}: ${err.message}`);
    }
  }
}

run().catch(console.error);
