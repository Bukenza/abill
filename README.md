# Abill — Aprende con Bill 🧠

PWA de tarjetas de memoria con repetición espaciada (algoritmo SM-2).  
Instalable en iPhone y Android. Funciona offline. Notificaciones push inteligentes.

## Características

- 📚 Mazos de tarjetas organizados por tema
- 🧠 Algoritmo SM-2 de repetición espaciada adaptativo
- 🔔 Notificaciones push con respeto máximo al usuario
- 📵 Funciona offline (caché completo)
- 🌙 Dark mode
- 📱 Instalable en iPhone y Android (PWA)
- 🔒 Sin cuenta, sin registro — datos en local

## Sistema de notificaciones

Las notificaciones funcionan mediante **Firebase Cloud Messaging (FCM)** + **GitHub Actions** como scheduler.

### Regla principal
> Máximo 1 notificación activa a la vez. Mientras el usuario no haya abierto la app desde la última notificación, no se envía ninguna más.

### Fases según el algoritmo SM-2

| Fase | Intervalo de la tarjeta | Comportamiento |
|------|------------------------|----------------|
| **1** | < 12h (tarjeta nueva) | Envía cuando toca SM-2 · No envía entre 22:00–07:00 |
| **2** | 12h – 48h (segundo día) | Igual que fase 1 |
| **3** | > 48h (día 3 en adelante) | Solo a la hora diaria configurada por el usuario (por defecto 8:00) |

### Re-engagement
Los **lunes a las 8:00** se envía una notificación especial si el usuario lleva 5+ días sin abrir la app. Esta es la única notificación que puede llegar aunque haya una sin leer.

### Intervalos SM-2

| Repaso | Intervalo |
|--------|-----------|
| 1º | +10 minutos |
| 2º | +3 horas |
| 3º | +6 horas |
| 4º | +1 día |
| 5º en adelante | SM-2 adaptativo (crece con cada acierto) |

## Instalación en iPhone

1. Abre `https://abill-bb5a6.web.app` en **Safari**
2. Toca el botón compartir **□↑**
3. Selecciona **"Añadir a pantalla de inicio"**
4. Abre Abill desde tu pantalla de inicio
5. Ve a Configuración → activa las notificaciones push

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML · CSS · JavaScript (vanilla) |
| Hosting | Firebase Hosting |
| Push notifications | Firebase Cloud Messaging (FCM) |
| Scheduler | GitHub Actions (cron cada hora) |
| Base de datos | Firebase Firestore (tokens FCM + actividad) |
| Offline | Service Worker + Cache API |
| Algoritmo | SM-2 (Spaced Repetition) |

## Estructura de archivos

```
abill/
├── index.html                  # App principal
├── style.css                   # Estilos dark mode
├── app.js                      # Lógica SM-2 + Firebase + navegación
├── sw.js                       # Service Worker (offline + FCM background)
├── manifest.json               # Configuración PWA
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── .github/
    ├── workflows/
    │   ├── send-notifications.yml   # Cron cada hora → notificaciones automáticas
    │   └── admin-notification.yml  # Dispatch manual → notificaciones del admin
    └── scripts/
        ├── send-notifications.js   # Lógica de envío automático
        ├── admin-send.js           # Lógica de envío manual
        └── package.json
```

## Notificaciones admin

El administrador puede enviar mensajes personalizados a todos los usuarios desde **GitHub → Actions → "📣 Admin — Enviar notificación personalizada"** sin necesidad de tocar el código ni que los usuarios actualicen la app.

## Configuración requerida

Para desplegar en un proyecto propio necesitas:

1. Proyecto en [Firebase](https://firebase.google.com) con Hosting, Firestore y Cloud Messaging activados
2. Secret `FIREBASE_SERVICE_ACCOUNT` en GitHub con la clave de servicio de Firebase
3. VAPID key de FCM en `app.js`

---

Hecho con [Claude Code](https://claude.ai/claude-code) · v1.12.5
