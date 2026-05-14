# Abill — Aprende con Bill 🧠

PWA de tarjetas de memoria con repetición espaciada (algoritmo SM-2).

## Características

- 📚 Mazos de tarjetas organizados por tema
- 🧠 Algoritmo SM-2 de repetición espaciada
- 🔔 Notificaciones push (10min → 3h → 6h → SM-2)
- 📵 Funciona offline
- 🌙 Dark mode
- 📱 Instalable en iPhone y Android

## Intervalos para tarjetas nuevas

| Repaso | Intervalo desde respuesta anterior |
|--------|-----------------------------------|
| 1º → 2º | +10 minutos |
| 2º → 3º | +3 horas |
| 3º → 4º | +6 horas |
| 4º en adelante | SM-2 adaptativo |

Zona prohibida de notificaciones automáticas: 22:00 — 07:00
(La hora configurada por el usuario siempre se respeta)

## Instalación en iPhone

1. Abre la URL en **Safari**
2. Toca el botón compartir (□↑)
3. Selecciona **"Añadir a pantalla de inicio"**
4. Abre Abill desde tu pantalla de inicio
5. Ve a Configuración → Activar notificaciones push

## Subir a Vercel

1. Sube esta carpeta a un repositorio de GitHub
2. Ve a [vercel.com](https://vercel.com) y conecta tu GitHub
3. Importa el repositorio → Deploy automático
4. Abre la URL en Safari de tu iPhone

## Estructura de archivos

```
abill/
├── index.html      # App principal
├── style.css       # Estilos dark mode
├── app.js          # Lógica SM-2 + navegación
├── sw.js           # Service Worker (offline + notificaciones)
├── manifest.json   # Configuración PWA
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

## Iconos

Necesitas añadir dos iconos en la carpeta `icons/`:
- `icon-192.png` — 192×192 px
- `icon-512.png` — 512×512 px

Puedes generarlos en [favicon.io](https://favicon.io) o [realfavicongenerator.net](https://realfavicongenerator.net)

---

Hecho con Claude · v1.0
