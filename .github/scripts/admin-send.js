// ═══════════════════════════════════════════════════════════════════════
// ABILL — Admin: Enviar notificación personalizada a todos los usuarios
// ───────────────────────────────────────────────────────────────────────
//
// Se activa manualmente desde GitHub → Actions → "Admin — Enviar notificación"
// El título y el mensaje se introducen en el formulario de GitHub antes de lanzarlo.
//
// ═══════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db        = admin.firestore();
const messaging = admin.messaging();

const title   = process.env.NOTIF_TITLE   || '🧠 Abill';
const message = process.env.NOTIF_MESSAGE || 'Tienes novedades en Abill.';
const APP_URL = 'https://abill-bb5a6.web.app';

async function run() {
  console.log(`\n📣 Enviando notificación admin a todos los usuarios`);
  console.log(`   Título:  ${title}`);
  console.log(`   Mensaje: ${message}\n`);

  // Los dispositivos viven en users/{uid}/devices/{deviceId} (modelo por
  // usuario), NO en una colección raíz `devices` (que ya no existe). Hay que
  // recorrer cada usuario, igual que send-notifications.js.
  const usersSnapshot = await db.collection('users').get();
  if (usersSnapshot.empty) {
    console.log('[INFO] No hay usuarios registrados.');
    return;
  }

  let enviadas = 0;
  let errores  = 0;
  const sentTokens = new Set();

  for (const userDoc of usersSnapshot.docs) {
    const devicesSnapshot = await userDoc.ref.collection('devices').get();

    for (const deviceDoc of devicesSnapshot.docs) {
      const { fcmToken } = deviceDoc.data();
      if (!fcmToken) continue;
      if (sentTokens.has(fcmToken)) continue; // mismo token en varios dispositivos
      sentTokens.add(fcmToken);

      try {
        // Solo datos (sin bloque `notification`): sw.js pinta el aviso, así no
        // sale duplicado (igual que el envío automático).
        await messaging.send({
          token: fcmToken,
          data: { title, body: message, url: APP_URL },
          webpush: { fcmOptions: { link: APP_URL } },
        });

        console.log(`[OK] Enviado → ${userDoc.id}/${deviceDoc.id}`);
        enviadas++;

      } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
          await deviceDoc.ref.delete();
          console.log(`[CLEANED] Token inválido, dispositivo eliminado: ${deviceDoc.id}`);
        } else {
          console.error(`[ERROR] ${deviceDoc.id}: ${err.message}`);
          errores++;
        }
      }
    }
  }

  console.log(`\n✅ Resultado: ${enviadas} enviada/s, ${errores} error/es.`);
}

run().catch(console.error);
