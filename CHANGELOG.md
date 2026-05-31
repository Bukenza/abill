# Changelog

Registro de cambios de Abill. Lo más nuevo arriba.
Cada versión coincide con un *tag* de Git del mismo nombre, así que se puede
volver a cualquiera (ver "Cómo volver atrás" al final).

Convenio de versiones (igual que en `CLAUDE.md`):
menor = arreglo pequeño (`v1.9.1`), funcionalidad nueva = `v1.9`, rediseño = `v2.0`.

---

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
