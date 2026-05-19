// ═══════════════════════════════════════════════════════════════════════
// ABILL — GitHub Action: Send Push Notifications
// ───────────────────────────────────────────────────────────────────────
//
// CUÁNDO CORRE: cada hora en punto (UTC)
//
// REGLA PRINCIPAL: máximo 1 notificación activa a la vez.
//   Mientras el usuario no haya abierto la app desde la última notificación,
//   no se envía ninguna más. Cuando la abre, se desbloquea el siguiente envío.
//
// RESTRICCIONES ADICIONALES:
//   Fase 1–2 (intervalo < 48h): no enviar entre 22:00 y 07:00 hora Barcelona.
//   Fase 3   (intervalo > 48h): solo enviar a la hora diaria del usuario (por defecto 8:00).
//
// EXCEPCIÓN — RE-ENGAGEMENT (lunes a las 8:00 hora Barcelona):
//   Si el usuario no ha abierto la app en 5+ días → notificación especial.
//   Esta SÍ se envía aunque haya una notificación regular sin leer.
//
// ═══════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db        = admin.firestore();
const messaging = admin.messaging();

const QUIET_ZONE_MS   = 2  * 60 * 60 * 1000;  // 2h  — buffer mínimo fases 1–2
const PHASE3_SNOOZE   = 20 * 60 * 60 * 1000;  // 20h — buffer mínimo fase 3
const REENGAGEMENT_MS = 5  * 24 * 60 * 60 * 1000; // 5 días sin abrir

// ── UTILIDADES DE ZONA HORARIA (Europe/Madrid = Barcelona) ───────────

// Devuelve la hora local en Barcelona (0–23)
function getMadridHour(ts) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Madrid',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(ts)),
    10
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function run() {
  const now        = Date.now();
  const madridHour = getMadridHour(now);
  const isMonday   = new Date(now).getUTCDay() === 1;

  const devicesSnapshot = await db.collection('devices').get();

  // Un mismo token puede aparecer en varios documentos (p.ej. si el localStorage
  // se limpió y se generó un nuevo DEVICE_ID, el documento anterior queda huérfano
  // con el mismo token). Enviamos solo una vez por token para evitar duplicados.
  const sentTokens = new Set();

  for (const deviceDoc of devicesSnapshot.docs) {
    const device       = deviceDoc.data();
    const { fcmToken } = device;
    if (!fcmToken) continue;
    if (sentTokens.has(fcmToken)) {
      console.log(`[SKIP] Token duplicado en ${deviceDoc.id}, ya procesado`);
      continue;
    }
    sentTokens.add(fcmToken);

    // ── Notificación regular ───────────────────────────────────────
    await sendRegularIfDue(deviceDoc, device, fcmToken, now, madridHour);

    // ── Re-engagement: solo lunes a las 8:00 hora Barcelona ─────────
    if (isMonday && madridHour === 8) {
      await sendReengagementIfInactive(deviceDoc, device, fcmToken, now);
    }
  }

  console.log('[DONE] Ciclo completado.');
}

// ── NOTIFICACIÓN REGULAR ──────────────────────────────────────────────
async function sendRegularIfDue(deviceDoc, device, fcmToken, now, madridHour) {
  const pendingRef = deviceDoc.ref.collection('notifications').doc('pending');
  const pendingDoc = await pendingRef.get();
  if (!pendingDoc.exists) return;

  const pending = pendingDoc.data();

  // ¿Aún no toca según el algoritmo?
  if (pending.nextReview > now) return;

  // ── REGLA PRINCIPAL: no enviar si hay una notificación sin leer ──
  // "Sin leer" = el usuario no ha abierto la app desde que enviamos la última.
  // Analogía: como no llamar a alguien dos veces antes de que te conteste.
  const lastNotifiedAt = pending.lastNotifiedAt || 0;
  const lastOpenedAt   = device.lastOpenedAt   || 0;

  if (lastNotifiedAt > 0 && lastOpenedAt <= lastNotifiedAt) {
    console.log(`[SKIP] ${deviceDoc.id} — notificación anterior sin leer`);
    return;
  }

  // ── Restricciones por fase ────────────────────────────────────────
  const notifPhase     = pending.notifPhase || 3;
  const dailyNotifHour = device.dailyNotifHour ?? 8;

  if (notifPhase >= 3) {
    // Fase 3: solo a la hora exacta configurada por el usuario
    if (madridHour !== dailyNotifHour) {
      console.log(`[SKIP] ${deviceDoc.id} — fase 3, hora ${madridHour}h ≠ hora diaria ${dailyNotifHour}h`);
      return;
    }
  } else {
    // Fases 1–2: no enviar en horario nocturno (22:00–07:00)
    if (madridHour < 7 || madridHour >= 22) {
      console.log(`[SKIP] ${deviceDoc.id} — horario nocturno (${madridHour}h)`);
      return;
    }
  }

  // ── Bloqueo atómico: transacción que lee y reserva fired en un solo paso ──
  // El read-then-write previo no era atómico: si dos ejecuciones del workflow
  // arrancaban simultáneamente, ambas leían fired:false y ambas enviaban.
  // Con la transacción, solo una escritura gana; la otra ve fired:true y aborta.
  let claimed = false;
  try {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(pendingRef);
      if (!fresh.exists || fresh.data().fired === true) return;
      tx.update(pendingRef, { fired: true, updatedAt: now });
      claimed = true;
    });
  } catch (err) {
    console.error(`[TXN ERROR] ${deviceDoc.id}: ${err.message}`);
    return;
  }

  if (!claimed) {
    console.log(`[SKIP] ${deviceDoc.id} — ya reclamado por otra ejecución concurrente`);
    return;
  }

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
        fcmOptions:   { link: 'https://abill-bb5a6.web.app' },
      },
    });

    console.log(`[OK] Fase ${notifPhase} → ${deviceDoc.id} (${count} tarjeta/s)`);

    // Buffer mínimo: aunque el usuario abra la app sin repasar,
    // esperamos un tiempo antes de poder renotificar.
    // Fase 1–2: 2h / Fase 3: 20h (para no adelantarse al día siguiente)
    const snoozeMs = notifPhase >= 3 ? PHASE3_SNOOZE : QUIET_ZONE_MS;

    await pendingRef.update({
      fired:          false,
      nextReview:     now + snoozeMs,
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

// ── RE-ENGAGEMENT ─────────────────────────────────────────────────────
async function sendReengagementIfInactive(deviceDoc, device, fcmToken, now) {
  const lastOpened    = device.lastOpenedAt || 0;
  const inactiveSince = now - lastOpened;

  if (inactiveSince < REENGAGEMENT_MS) return;

  try {
    await messaging.send({
      token: fcmToken,
      notification: {
        title: '👋 Abill te echa de menos',
        body:  'Estás a 5 min de seguir el camino del éxito.',
      },
      webpush: {
        notification: { icon: '/icons/icon-192.png', tag: 'abill-reengagement', renotify: true },
        fcmOptions:   { link: 'https://abill-bb5a6.web.app' },
      },
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
