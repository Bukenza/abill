const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

async function run() {
  const now = Date.now();
  const devicesSnapshot = await db.collection('devices').get();

  for (const deviceDoc of devicesSnapshot.docs) {
    const { fcmToken } = deviceDoc.data();
    if (!fcmToken) continue;

    const notifsSnapshot = await db
      .collection('devices').doc(deviceDoc.id)
      .collection('notifications')
      .where('fired', '==', false)
      .get();

    for (const notifDoc of notifsSnapshot.docs) {
      const notif = notifDoc.data();
      if (notif.nextReview > now) continue;

      try {
        if (notif.type === 'daily') {
          await messaging.send({
            token: fcmToken,
            notification: { title: '⏰ Abill — hora de repasar', body: 'Abre la app para ver tus tarjetas del día.' },
            webpush: {
              notification: { icon: '/icons/icon-192.png', tag: 'abill-daily', renotify: true },
              fcmOptions: { link: 'https://abill-bb5a6.web.app' }
            }
          });
          const next = new Date(notif.nextReview);
          next.setDate(next.getDate() + 1);
          await notifDoc.ref.update({ nextReview: next.getTime(), fired: false });
          console.log(`Daily sent to ${deviceDoc.id}`);

        } else {
          const body = notif.question
            ? `${notif.deckName ? '[' + notif.deckName + '] ' : ''}${notif.question.substring(0, 80)}${notif.question.length > 80 ? '...' : ''}`
            : 'Tienes una tarjeta para repasar.';
          await messaging.send({
            token: fcmToken,
            notification: { title: '🧠 Abill — toca repasar', body },
            webpush: {
              notification: { icon: '/icons/icon-192.png', tag: `abill-${notifDoc.id}`, renotify: true },
              fcmOptions: { link: 'https://abill-bb5a6.web.app' }
            }
          });
          await notifDoc.ref.update({ fired: true });
          console.log(`Card notif sent: ${notifDoc.id} to ${deviceDoc.id}`);
        }
      } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
          await deviceDoc.ref.delete();
          console.log(`Removed invalid device ${deviceDoc.id}`);
        } else {
          console.error(`Error: ${err.message}`);
        }
      }
    }
  }
  console.log('Done.');
}

run().catch(console.error);
