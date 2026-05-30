# CLAUDE.md

Este archivo guía a Claude Code (claude.ai/code) al trabajar en este repositorio.
Está en español a propósito: el código, los comentarios y el usuario lo están.

## Qué es

Abill ("Aprende con Bill") es una PWA de tarjetas de memoria con repetición espaciada
(algoritmo SM-2) para iPhone/Android. HTML/CSS/JS puro — **sin framework, sin build,
sin bundler, sin tests, sin package manager en la raíz.** Lo que se commitea es
exactamente lo que se sirve.

- Producción: https://abill-bb5a6.web.app
- Proyecto Firebase: `abill-bb5a6`
- Repo: https://github.com/Bukenza/abill

## Desplegar y ejecutar

- **El deploy es automático:** hacer push a `master` dispara `.github/workflows/deploy.yml`,
  que publica la raíz del repo en Firebase Hosting (`firebase.json` → `"public": "."`).
  No hay paso de compilación.
- **Desarrollo local:** servir la raíz por HTTP (el Service Worker y Firebase Auth no
  funcionan desde `file://`). Ej: `npx serve .` o `python -m http.server`. El login de
  Google puede no funcionar en localhost por las restricciones de dominio de Firebase.
- **El único `package.json` está en `.github/scripts/`** (el backend de notificaciones).
  No forma parte de la web; solo se instala dentro de GitHub Actions.

## CRÍTICO: subir la versión de caché del Service Worker en cada deploy

Al cambiar `app.js`, `index.html`, `style.css`, `manifest.json` o `sw.js`, **hay que**
subir `const CACHE = 'abill-vN'` en `sw.js` antes de hacer push. El SW es offline-first
(cache-first), así que sin un nombre de caché nuevo los usuarios que vuelven siguen
recibiendo los archivos viejos indefinidamente. Al activarse, borrar las cachés viejas
dispara un postMessage `SW_UPDATED` que recarga las pestañas abiertas (`sw.js`, `app.js`).

Convenio de versiones acordado con el usuario:
- Menor (bugs / ajustes pequeños): `v1.8.1`, `v1.8.2`, …
- Funcionalidad nueva: `v1.8`, `v1.9`, …
- Mayor (rediseño / arquitectura nueva): `v2.0`, …

**UNA sola versión, igual en todos los sitios** (norma del usuario). Al subir versión,
el mismo número va en LOS TRES:
1. `sw.js` → `const CACHE = 'abill-vX.Y.Z'` (ej. `abill-v1.9`)
2. `index.html` → línea `about-desc` (ej. `Aprende con Bill · v1.9`)
3. `README.md` → footer (ej. `… · v1.9`)

NO sincronizar `.github/scripts/package.json` (`"version"`): es un componente
independiente (el backend de notificaciones), con su propio versionado.

## Arquitectura

### Cliente (`app.js`) — un solo archivo, sin módulos
Todo son funciones globales conectadas a `onclick=` en `index.html`. La navegación es
`showScreen(id)`, que alterna la clase CSS `.active` sobre los divs `screen-*`; cada
pantalla tiene su `render*()` llamada desde `showScreen`.

**Modelo de datos:** `localStorage` (`abill_cards`, `abill_decks`, `abill_settings`,
`abill_stats`) es la fuente de verdad de la UI. `setData()` escribe en localStorage Y
llama a `syncUserData()`, que sube esas cuatro claves a Firestore. Cada tarjeta lleva su
estado SM-2 inline: `{ phase, interval (minutos), easeFactor, repetitions, nextReview
(ms epoch), lastReviewed }`.

**SM-2:** en `getNextInterval()` / `scheduleNextReview()`. Fases 0–2 usan intervalos fijos
(10min → 3h → 6h → 1 día); desde la fase 3 manda la fórmula del ease-factor.
`applyZoneRestriction()` empuja los recordatorios de tarjetas nuevas fuera de la franja
de silencio 22:00–07:00.

### Autenticación y sincronización (Firebase, cargado de forma diferida con `loadScript`)
- La app está **bloqueada tras login**. `onAuthStateChanged` es el verdadero punto de
  entrada: con usuario → `loadUserData()` y pantalla home; sin usuario → pantalla login.
- **Dos métodos de login** (pantalla `screen-login`, tres vistas conmutadas con
  `toggleAuthView`: `login` / `register` / `reset`):
  - **Email/contraseña** (`signInWithEmail`, `registerWithEmail`, `resetPassword`): usa la
    API REST de Identity Toolkit; no depende de popup ni de `authDomain`. Es el camino
    fiable, también en la PWA instalada en iPhone. Requiere activar el proveedor
    "Correo/contraseña" en Firebase Console.
  - **Google** (`signInWithGoogle` → `signInWithPopup`): ver "Problema conocido" abajo.
  - Errores traducidos en el mapa `AUTH_ERRORS`; se muestran con `showAuthMessage`.
- `loadUserData()` baja el doc de Firestore y sobrescribe el estado local; si no existe
  (primer login) sube el localStorage actual.
- Layout Firestore: `users/{uid}` guarda `{ cards, decks, settings, stats }`. Los datos por
  dispositivo viven en la subcolección `users/{uid}/devices/{deviceId}` — token FCM,
  `lastOpenedAt`, `lastReviewedAt`, `dailyNotifHour`, y un único doc `notifications/pending`
  con el próximo recordatorio.
- `deviceId` es un id aleatorio en `localStorage` (`abill_device_id`), distinto del `uid`.
  Un usuario puede tener varios dispositivos.
- `firestore.rules` solo da acceso a `users/{uid}/**` al usuario autenticado correspondiente.

### Backend de notificaciones (`.github/scripts/`, corre en GitHub Actions con Admin SDK)
Las push NO se programan en el navegador. Flujo:
1. El cliente calcula el recordatorio más urgente y escribe
   `users/{uid}/devices/{deviceId}/notifications/pending` con `updatePendingNotif()`.
2. `send-notifications.yml` corre **cada hora** (`cron: '0 * * * *'`) y ejecuta
   `send-notifications.js`, que recorre todos los `users/*/devices/*` y, para cada `pending`
   que toca, envía un mensaje FCM vía Admin SDK.
3. `sw.js` `onBackgroundMessage` pinta la notificación cuando la app está cerrada.

Reglas clave del backend (`send-notifications.js`):
- **Máximo una notificación sin leer a la vez:** si `lastNotifiedAt > 0 && lastOpenedAt
  <= lastNotifiedAt`, se salta (el usuario no ha abierto desde el último aviso).
- **Fases:** `notifPhase` 1–2 (intervalo <48h) se silencia 22:00–07:00 hora Barcelona;
  fase 3 (>48h) solo dispara a la `dailyNotifHour` del usuario. Zona horaria con
  `Intl.DateTimeFormat('Europe/Madrid')`.
- **Reserva atómica:** una transacción de Firestore pone `fired:true` para que dos
  ejecuciones solapadas del workflow no envíen doble.
- **Re-engagement:** lunes a las 08:00 Barcelona, usuarios inactivos 5+ días reciben un
  aviso especial que salta la regla de "sin leer".
- Tokens inválidos (`messaging/registration-token-not-registered`) borran el doc del
  dispositivo.

`admin-send.js` (lanzado a mano desde `admin-notification.yml`, "📣 Admin — Enviar
notificación personalizada") manda un título/cuerpo a medida a todos los dispositivos.

`FIREBASE_SERVICE_ACCOUNT` (secret de GitHub) es la credencial del Admin SDK; la usan tanto
el workflow de deploy como los de notificaciones.

## Problemas conocidos (leer antes de tocar el login)

1. **Login de Google roto con `auth/internal-error`.** `app.js` fuerza
   `authDomain: "abill-bb5a6.web.app"`, pero el `authDomain` canónico del proyecto es
   `abill-bb5a6.firebaseapp.com` (confirmado en `https://abill-bb5a6.web.app/__/firebase/init.json`).
   Con `signInWithPopup` + `web.app` el handshake del popup falla en todas las plataformas.
   Opciones: (a) volver `authDomain` a `firebaseapp.com` (el popup funciona en escritorio,
   pero el popup no vuelve a la PWA instalada en iOS); (b) para iOS, usar
   `signInWithRedirect` con `authDomain` del mismo origen y autorizar
   `https://abill-bb5a6.web.app/__/auth/handler` en el cliente OAuth de Google Cloud.
   El login de **email/contraseña no tiene este problema** y es la vía recomendada hoy.

2. **`admin-send.js` lee la colección equivocada.** Hace `db.collection('devices')`
   (nivel raíz), pero el modelo actual guarda los dispositivos en `users/{uid}/devices/...`.
   El script es anterior a la migración a auth/por-usuario y no encontrará dispositivos.
   Hay que iterar `users/*/devices/*` como hace `send-notifications.js`.

## Seguridad ya aplicada (conservar)

- Renderizado con `createElement`/`textContent` en vez de `innerHTML` para contenido del
  usuario (`renderDecksList`/`renderDecksExpandable`) — no reintroducir `innerHTML` con
  texto de tarjetas/mazos (XSS).
- CSP en `index.html` (línea 6). Cualquier origen externo nuevo (script, connect, font)
  hay que añadirlo ahí o se bloquea.
- Límites de longitud: pregunta ≤500, respuesta ≤1000, nombre de mazo ≤100.
- La API key web de Firebase está a propósito en el cliente (no es secreta en Firebase),
  restringida a `abill-bb5a6.web.app` en Google Cloud Console; el secreto real es
  `FIREBASE_SERVICE_ACCOUNT`.
