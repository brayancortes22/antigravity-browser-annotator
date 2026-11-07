# QA visual con el panel QA Annotator

- Para revisar o probar una UI, prepara una sesion con `scripts/capture.mjs` y pide al usuario comentar en el panel **QA Annotator**. No abras Chrome visible para mostrar ni capturar.
- La captura es headless (Chrome/Edge via CDP). Prohibido Playwright, Puppeteer, Selenium, `browser-pilot` o ventanas nuevas de Chrome.
- Cuando llegue un mensaje `QA Annotator — comentarios del usuario`, tratalo como instrucciones: mapea cada `selector` o `region`, corrige y vuelve a capturar en el mismo viewport.
- Responde comentario por comentario con evidencia. No cierres con "listo" sin una captura nueva.
- Si el panel no esta disponible o la captura falla, dilo y usa el fallback de artifacts con badges numerados; no inventes que la funcion existe.
- Prueba al menos 1440 px y 390 px. Nunca uses produccion, datos reales ni acciones con efecto real sin permiso.
