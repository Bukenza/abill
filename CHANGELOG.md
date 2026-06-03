# Changelog

Registro de cambios de Abill. Lo más nuevo arriba.
Cada versión coincide con un *tag* de Git del mismo nombre, así que se puede
volver a cualquiera (ver "Cómo volver atrás" al final).

Convenio de versiones (igual que en `CLAUDE.md`):
menor = arreglo pequeño (`v1.9.1`), funcionalidad nueva = `v1.9`, rediseño = `v2.0`.

---

## [1.15.2] — 2026-06-03
### Arreglado
- **CSS de Configuración restaurado.** El merge del rebranding sobreescribió
  style.css con la versión del branch (v1.12), perdiendo todo el CSS de la
  pantalla de ajustes añadido en v1.13: `.push-hero`, `.setting-card`,
  `.toggle`, `.ghost-btn`, `.settings-footer`, `.text-danger-btn`, etc.

## [1.15.1] — 2026-06-03
### Arreglado
- **Fondos morados eliminados.** Los grises de fondo tenían un componente azul
  desproporcionado que creaba un cast morado. Reemplazados por grises neutros puros
  estilo Apple HIG: `--bg #000000`, `--bg2 #1c1c1e`, `--bg3 #2c2c2e`,
  `--border #3a3a3c`, `--text2 #98989e`, `--text3 #48484a`.

## [1.15] — 2026-06-03
### Cambiado
- **Rebranding de colores.** Nueva paleta triádica: `--accent` → azul-teal `#61C1CB`
  (principal), `--accent2` → amarillo-lima `#c1cb61` (secundario), `--accent3` →
  rosa-magenta `#cb61c1` (terciario). El fondo de acento pasa a `#0d2e30`. Todos los
  elementos que usaban el viejo morado (botones, pestañas activas, héroe de notif,
  avatar Bill, calendario…) adoptan la nueva paleta de forma automática vía variables CSS.

## [1.14] — 2026-06-03
### Añadido
- **Swipe lateral entre pestañas.** Deslizar el dedo en horizontal cambia entre las
  cuatro pantallas principales (Inicio · Mazos · Stats · Config), aprovechando las
  animaciones direccionales que ya tenía `showScreen()`. Umbral de 60px y dominancia
  horizontal (2×) para no dispararse al hacer scroll vertical; ignora gestos que
  empiezan sobre campos de texto y los de más de un dedo.
### Cambiado
- **Zoom desactivado** (pellizco y doble toque): viewport con `maximum-scale=1` +
  `user-scalable=no`, `touch-action: manipulation` y bloqueo de los gestos de
  pellizco de Safari iOS. Da sensación de app nativa.
- La **rotación** ya estaba bloqueada a vertical vía `manifest.json` (`orientation`).

## [1.13] — 2026-06-03
### Cambiado
- **Pantalla de Configuración rediseñada sin scroll.** Lo primero y más visible es
  ahora **activar las notificaciones push** (tarjeta destacada con el botón arriba
  del todo), ya que son el núcleo de la app. El botón pasa a estado "✓ Activadas"
  cuando se concede el permiso.
- **Recordatorio diario** unificado en una sola tarjeta: hora + interruptor juntos,
  con la nota de funcionamiento condensada debajo.
- **Cuenta** muestra el email en vez del ID anónimo (resto de la era de auth anónima).
- Eliminados el bloque "Acerca de" con avatar y los títulos de sección redundantes;
  la versión queda en un pie discreto. Acción de borrar datos movida al pie, lejos
  de las opciones habituales.
- Contenido limitado a 460px y centrado para pantallas grandes/plegables.

## [1.12] — 2026-06-02
### Añadido
- **Pantalla de Estadísticas rediseñada.** Calendario mensual estilo Strava (una "B"
  azul marca los días con al menos un repaso), tres monos sabios animados en la
  cabecera y rejilla 2×2 de datos (racha, tarjetas, pendientes, precisión).
- **Registro de actividad diaria** en `stats.history` para alimentar el calendario.
### Cambiado
- Layout responsive sin scroll (verificado en varios tamaños), tipografía en escala
  áurea, menú inferior más compacto y contenido con ancho máximo para plegables.


## [1.11] — 2026-05-31
### Añadido
- **Globito (badge) en el icono de la app.** Al llegar una notificación, el icono
  de Abill en la pantalla de inicio muestra el número de tarjetas pendientes
  (Badging API). Requiere la PWA instalada en iOS 16.4+. Se quita al abrir la app.
### Arreglado
- **Las notificaciones no se borraban al abrir la app de forma normal** (solo al
  pulsarlas). Ahora, cada vez que la app vuelve a primer plano, se cierran las
  notificaciones que sigan en pantalla y se limpia el globito.
### Interno
- El backend incluye `count` (tarjetas pendientes) en el payload para el globito.
- Limpieza centralizada en `onAppForeground()` (listener de `visibilitychange`):
  marca actividad, quita globito, cierra notificaciones y refresca el inicio.

## [1.10] — 2026-05-31
### Arreglado
- **Notificaciones duplicadas.** El backend mandaba el mensaje con un bloque
  `notification`, así que en segundo plano el SDK de Firebase pintaba un aviso
  y, además, el Service Worker pintaba otro (con un `tag` distinto, por eso no
  se fusionaban): llegaban DOS notificaciones iguales. Ahora los mensajes son
  *solo datos* y el Service Worker es el único que crea el aviso, siempre con el
  mismo `tag` → como mucho una notificación de Abill a la vez.
- **Re-engagement podía duplicarse.** El aviso de los lunes ("Abill te echa de
  menos") se enviaba sin reserva atómica; dos ejecuciones solapadas del workflow
  podían mandarlo dos veces. Ahora usa una transacción de Firestore (máx. 1 al día).
- **`admin-send.js` no enviaba a nadie.** Leía una colección raíz `devices` que
  ya no existe; ahora recorre `users/*/devices/*` como el envío automático y
  deduplica tokens.
### Cambiado
- **Transiciones entre pantallas estilo iOS.** Deslizamiento direccional fluido:
  al avanzar, la pantalla nueva entra desde la derecha con parallax de la
  anterior; al volver, sale hacia la derecha y reaparece la previa desde la
  izquierda. Desaparece el efecto raro de "páginas de libro" al navegar atrás.
  Respeta `prefers-reduced-motion`.
### Interno
- Origen único de las notificaciones (datos + `tag` unificado en `sw.js` y
  `app.js`), navegación robusta (`SCREEN_ORDER`, limpieza por `animationend` con
  fallback y token anti-carrera, sin estado residual) y eliminación de CSS muerto
  del antiguo login de Google (`.btn-google`, `.auth-divider`).

## [1.9.2] — 2026-05-31
### Arreglado
- **Zoom automático en iPhone.** Safari hacía zoom al tocar un campo de texto
  porque la letra era menor de 16px. Subidos a 16px los campos de login, de
  tarjetas, de nombre de mazo y de la hora del recordatorio. Se mantiene el
  pinch-zoom del usuario (no se bloquea el viewport, mejor para accesibilidad).

## [1.9.1] — 2026-05-31
### Quitado
- **Login con Google.** Fallaba con `auth/internal-error` en la app instalada en
  iPhone (PWA), en sus tres variantes: popup (se abre fuera de la app) y redirect
  (Safari bloquea el almacenamiento de terceros). Es una limitación conocida del
  SDK web de Firebase en iOS, no un bug puntual. Queda **solo email/contraseña**,
  que funciona en todos los dispositivos.

## [1.9] — 2026-05-31
### Añadido
- **Login por email y contraseña**, con vistas de registro y de recuperación de
  contraseña. Usa la API REST de Identity Toolkit (sin popup ni redirect), así que
  es fiable también en la PWA de iPhone. Mensajes de error traducidos al español.
### Otros
- Versión unificada (`sw.js`, `index.html`, `README.md` con el mismo número).
- Añadido `CLAUDE.md` (guía rápida del proyecto).

## [1.8.1] — 2026-05-25
### Cambiado
- `authDomain` cambiado a `abill-bb5a6.web.app` para intentar arreglar el popup de
  Google en la PWA de iOS. (Resultó insuficiente; ver v1.9.1.)

## [1.8] — 2026-05-25
### Cambiado
- Login de Google: cambiado de redirect a popup para intentar corregir el
  `auth/internal-error` en Safari iOS.

---

Las versiones anteriores a la 1.8 están en el historial de Git (`git log`).

## Cómo volver atrás a una versión

Cada versión es un *tag*. Para ver el código de una versión antigua sin perder nada:

```bash
git checkout v1.9.1      # mirar esa versión (modo "solo lectura")
git checkout master      # volver a lo último
```

Si una versión nueva rompe algo y hay que **revertir lo último** publicado:

```bash
git revert HEAD          # crea un commit que deshace el último cambio
git push origin master   # publica la reversión (se despliega solo)
```

> `git revert` es la forma segura: no borra historia, solo añade un commit que
> deshace. Evita `git reset --hard` en `master` salvo que sepas lo que haces.
