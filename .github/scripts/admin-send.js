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

async function run() {
  console.log(`\n📣 Enviando notificación admin a todos los usuarios`);
  console.log(`   Título:  ${title}`);
  console.log(`   Mensaje: ${message}\n`);

  const devicesSnapshot = await db.collection('devices').get();

  if (devicesSnapshot.empty) {
    console.log('[INFO] No hay dispositivos registrados.');
    return;
  }

  let enviadas = 0;
  let errores  = 0;

  for (const deviceDoc of devicesSnapshot.docs) {
    const { fcmToken } = deviceDoc.data();
    if (!fcmToken) continue;

    try {
      await messaging.send({
        token: fcmToken,
        notification: { title, body: message },
        webpush: {
          notification: {
            icon:     '/icons/icon-192.png',
            tag:      'abill-admin',
            renotify: true,
          },
          fcmOptions: { link: 'https://abill-bb5a6.web.app' },
        },
      });

      console.log(`[OK] Enviado → ${deviceDoc.id}`);
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

  console.log(`\n✅ Resultado: ${enviadas} enviada/s, ${errores} error/es.`);
}

run().catch(console.error);
