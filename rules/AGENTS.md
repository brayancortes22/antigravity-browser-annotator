# QA visual con el panel QA Annotator

- Para revisar o probar una UI, prepara una sesion con `scripts/capture.mjs` y pide al usuario comentar en el panel **QA Annotator**. No abras Chrome visible para mostrar ni capturar.
- La captura es headless (Chrome/Edge via CDP). Prohibido Playwright, Puppeteer, Selenium, `browser-pilot` o ventanas nuevas de Chrome.
- Cuando llegue un mensaje `QA Annotator — comentarios del usuario`, tratalo como instrucciones: mapea cada `selector` o `region`, corrige y vuelve a capturar en el mismo viewport.
- Responde comentario por comentario con evidencia. No cierres con "listo" sin una captura nueva.
- Si el panel no esta disponible o la captura falla, dilo y usa el fallback de artifacts con badges numerados; no inventes que la funcion existe.
- Prueba al menos 1440 px y 390 px. Nunca uses produccion, datos reales ni acciones con efecto real sin permiso.

## Protocolo Obligatorio de QA Visual en Vivo (Auditoría con Navegador Integrado)

Cuando el usuario solicite un QA visual en vivo, auditoría de interfaz o navegación interactiva guiada:

1. **Superficie Exclusiva:**
   - Usar **exclusivamente el navegador integrado visible** en el panel de Antigravity.
   - Operar **únicamente a través de las herramientas MCP `native_browser_*`** (`native_browser_list_tabs`, `native_browser_select_tab`, `native_browser_navigate`, `native_browser_click`, `native_browser_scroll`, `native_browser_get_page`, `native_browser_inspect`).
   - **PROHIBIDO** abrir Chrome externo, ventanas emergentes, Playwright, Puppeteer, navegadores headless o el navegador `/browser`.
   - Mantener abierta y visible la pestaña del navegador en la conversación para que el usuario observe cada navegación y cada scroll en tiempo real.

2. **Flujo de Auditoría Sección por Sección:**
   - Empezar confirmando la URL objetivo y mostrando la primera sección en el navegador integrado.
   - Revisar **una sección a la vez** (ej. métricas, ventas, catálogo, contenido, anuncios, usuarios, prospectos).
   - Comprobar visualmente:
     - Desplazamiento y scroll suave.
     - Tablas con gran volumen de datos y paginación.
     - Desbordamientos (overflows) y recortes.
     - Textos superpuestos o cortes tipográficos.
     - Comportamiento responsive en diferentes resoluciones.
   - Para roles o vistas protegidas, usar solo cuentas y credenciales de prueba autorizadas; **prohibido inventar credenciales o exponer datos sensibles**.

3. **Ciclo de Pausa y Espera de Feedback:**
   - **Hacer una pausa obligatoria** después de auditar cada sección.
   - Describir exactamente qué se observó técnica y estéticamente.
   - **Esperar los comentarios del Inspector del usuario** antes de continuar con la siguiente sección.
   - Mantener esos comentarios en la conversación y responder a cada uno con evidencia técnica.
   - **Acciones Destructivas Prohibidas:** No crear, editar ni eliminar registros ni enviar formularios que muten o cambien datos reales en base de datos.

4. **Reglas de Fallo y Cierre:**
   - **No lanzar subagentes** durante la sesión de QA en vivo.
   - Si una herramienta de `native_browser` falla, **explicar el error técnico y detenerse de inmediato**; prohibido cambiar a otro navegador sin autorización.
   - Al culminar la sesión completa, emitir un informe de cierre resumiendo:
     - Cada ruta y sección auditada.
     - Elementos verificados con éxito.
     - Elementos que no se pudieron comprobar y sus causas técnicas.

