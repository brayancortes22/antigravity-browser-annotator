---
name: qa-annotator
description: Navegador web integrado en el panel lateral con buscador web, navegación libre, inspector visual en vivo estilo OpenCode y comentarios directos al agente.
metadata:
  version: "2.0.0"
  reviewed: "2026-11-07"
---

# Navegador Web & QA Annotator (Modo OpenCode)

Sidecar que proporciona un navegador interactivo completo en el panel auxiliar derecho de Antigravity (`sidecar://qa-annotator/annotator`) con capacidad de:
1. **Navegación libre en internet:** Motor de búsqueda integrado (DuckDuckGo), bypass transparente de `X-Frame-Options` vía proxy en `main.mjs`.
2. **Inspección en vivo estilo OpenCode:** Hover sobre elementos para ver dimensiones, clases de Tailwind, padding y accesibilidad.
3. **Anotaciones con 1 Clic:** Clic sobre el elemento para fijarlo, desplegar el cuadro flotante con su selector y enviar la orden directamente a este hilo de chat.

## Acceso Rápido
- **Enlace de activación:** [Abrir Navegador Web](sidecar://qa-annotator/annotator)
- **Barra de direcciones (Omnibox):**
  - Escribir texto libre -> Busca en la web.
  - Escribir `localhost:5173` o `127.0.0.1:3000` -> Carga el entorno de desarrollo local.
  - Escribir `sena.edu.co` o `https://...` -> Carga el portal web.
- **Botón Inspector (🎯):**
  - Al encenderlo: el cursor resalta componentes y permite dejar comentarios con selector exacto.
  - Al apagarlo: navegación estándar sin interferencias de clics.
