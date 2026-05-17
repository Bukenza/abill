// ═══════════════════════════════════════════════════════════════════════
// ABILL — GitHub Action: Send Push Notifications
// ───────────────────────────────────────────────────────────────────────
//
// CUÁNDO CORRE: cada hora en punto (UTC)
//
// SISTEMA DE 3 FASES:
//
//   Fase 1 — intervalo < 12h (tarjeta nueva o reaprendiendo)
//     → Máx. 2 notificaciones al día
//     → Llegan cuando SM-2 dice que toca, respetando zona de silencio (2h)
//
//   Fase 2 — intervalo 12h–48h (segundo día de la tarjeta)
//     → Máx. 2 notificaciones al día
//     → Igual que fase 1
//
//   Fase 3 — intervalo > 48h (día 3 en adelante)
//     → Exactamente 1 notificación al día
//     → Solo a la hora configurada por el usuario (por defecto 8:00)
//     → Nunca se repite ese día aunque la tarjeta siga sin repasar
//
// RESETEO DIARIO:
//   Cada vez que el script detecta un nuevo día (hora española), resetea
//   el contador de notificaciones del día y desbloquea el envío.
//
// RE-ENGAGEMENT (lunes a las 8:00 hora española):
//   Si el usuario no ha abierto la app en 5+ días → notificación especial.
//   Puede solaparse con la notificación regular.
//
// ═══════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db        = admin.firestore();
const messaging = admin.messaging();

const QUIET_ZONE_MS   = 2 * 60 * 60 * 1000;           // 2 horas
const REENGAGEMENT_MS = 5 * 24 * 60 * 60 * 1000;      // 5 días

// ── UTILIDADES DE ZONA HORARIA (Europe/Madrid) ────────────────────────

// Devuelve la hora local en Madrid (0-23)
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

// Devuelve la fecha en Madrid como "YYYY-MM-DD"
function getMadridDateStr(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
  }).format(new Date(ts));
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function run() {
  const now          = Date.now();
  const madridHour   = getMadridHour(now);
  const isMonday     = new Date(now).getUTCDay() === 1;
  const isMorning8   = madridHour === 8;

  const devicesSnapshot = await db.collection('devices').get();

  for (const deviceDoc of devicesSnapshot.docs) {
    const device       = deviceDoc.data();
    const { fcmToken } = device;
    if (!fcmToken) continue;

    // ── Notificación regular ───────────────────────────────────────
    await sendRegularIfDue(deviceDoc, device, fcmToken, now);

    // ── Re-engagement: solo lunes a las 8:00 hora española ─────────
    if (isMonday && isMorning8) {
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

  // ── Reseteo diario ───────────────────────────────────────────────
  // Cada vez que cambia el día en hora española, reiniciamos el contador
  // y desbloqueamos el envío. Analogía: como resetear el despertador cada mañana.
  const todayStr      = getMadridDateStr(now);
  let notifCountToday = pending.notifCountToday || 0;
  let fired           = pending.fired === true;

  if (pending.todayDate !== todayStr) {
    notifCountToday = 0;
    fired           = false;
    await pendingRef.update({
      notifCountToday: 0,
      fired:           false,
      todayDate:       todayStr,
      updatedAt:       now,
    });
  }

  // ── Guardias de salida rápida ────────────────────────────────────
  if (fired) return;
  if (pending.nextReview > now) return;

  // ── Lógica por fase ──────────────────────────────────────────────
  const notifPhase     = pending.notifPhase || 3; // si falta, asumimos fase 3 (más restrictivo)
  const dailyNotifHour = device.dailyNotifHour ?? 8;
  const madridHour     = getMadridHour(now);

  if (notifPhase >= 3) {
    // ── FASE 3: 1 notificación al día, a la hora exacta del usuario ──
    if (notifCountToday >= 1) {
      console.log(`[SKIP] ${deviceDoc.id} — ya notificado hoy (fase 3)`);
      return;
    }
    if (madridHour !== dailyNotifHour) {
      console.log(`[SKIP] ${deviceDoc.id} — hora actual ${madridHour}h ≠ hora diaria ${dailyNotifHour}h`);
      return;
    }
  } else {
    // ── FASES 1–2: máx. 2 al día, con zona de silencio ──────────────
    if (notifCountToday >= 2) {
      console.log(`[SKIP] ${deviceDoc.id} — ya 2 notificaciones hoy (fase ${notifPhase})`);
      return;
    }
    // Restricción nocturna: no enviar entre 22:00 y 07:00 hora Barcelona
    if (madridHour < 7 || madridHour >= 22) {
      console.log(`[SKIP] ${deviceDoc.id} — horario nocturno (${madridHour}h)`);
      return;
    }
    // Zona de silencio: no notificar si el usuario repasó hace < 2h
    if (device.lastReviewedAt && (now - device.lastReviewedAt) < QUIET_ZONE_MS) {
      console.log(`[SKIP] ${deviceDoc.id} — repasó hace menos de 2h`);
      return;
    }
    // Zona de silencio: no notificar si ya se envió una notificación hace < 2h
    if (pending.lastNotifiedAt && (now - pending.lastNotifiedAt) < QUIET_ZONE_MS) {
      console.log(`[SKIP] ${deviceDoc.id} — notificación reciente (< 2h)`);
      return;
    }
  }

  // ── Bloqueo optimista: marcar fired ANTES de enviar ─────────────
  // Así, si el script corre dos veces a la vez (raro pero posible), el segundo lo ve y para.
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
        fcmOptions:   { link: 'https://abill-bb5a6.web.app' },
      },
    });

    const newCount = notifCountToday + 1;
    console.log(`[OK] Fase ${notifPhase} → ${deviceDoc.id} (notif ${newCount} hoy, ${count} tarjeta/s)`);

    if (notifPhase >= 3) {
      // Fase 3: fired se queda true. El reseteo del día siguiente lo desbloqueará.
      await pendingRef.update({
        notifCountToday: newCount,
        todayDate:       todayStr,
        lastNotifiedAt:  now,
        updatedAt:       now,
      });
    } else {
      // Fases 1–2: snooze 2h. Si no repasa, la próxima pasada del script lo renotificará.
      await pendingRef.update({
        fired:           false,
        nextReview:      now + QUIET_ZONE_MS,
        lastNotifiedAt:  now,
        notifCountToday: newCount,
        todayDate:       todayStr,
        updatedAt:       now,
      });
    }

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
