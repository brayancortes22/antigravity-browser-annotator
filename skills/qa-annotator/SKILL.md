---
name: qa-annotator
description: Usa el Navegador Web integrado de Antigravity para navegar en Chromium, interactuar con páginas, auditar con el enjambre multiagente autónomo y recoger comentarios QA dentro de la interfaz.
metadata:
  version: "3.3.0"
  reviewed: "2026-11-17"
---

# Navegador Web & QA Annotator 3.3

El sidecar `qa-annotator/annotator` muestra un navegador controlable dentro del panel auxiliar de Antigravity. Los sitios externos usan Chromium/CDP; las páginas de desarrollo local pueden usar iframe.

Para actuar como agente, sigue `browser-hands`: envía una orden con ID único a `.qa/agent_action.json`, espera la respuesta correspondiente en `.qa/agent_result.json` y vuelve a pedir un snapshot tras cada cambio.

Acciones CDP: `navigate`, `snapshot`, `click`, `fill`, `scroll` y `press_key`. `snapshot` devuelve URL, título, texto visible y controles interactivos acotados sin incluir valores de campos. Mantén los sitios externos en Chromium si rechazan iframe.

---

## 👥 Modo de Enjambre Multiagente Autónomo (Swarm QA)

Cuando el usuario solicite una auditoría integral, revisión en vivo o prueba profunda de la web:

1. **Despliegue de los 4 Subagentes Especializados:**
   - **`🎨 Layout Inspector`** (`#38BDF8`): Audita geometría, desbordamientos horizontales (`scrollWidth <= clientWidth`), alineación de tarjetas y colisiones.
   - **`♿ Forms & A11y`** (`#34D399`): Audita nombres accesibles (`aria-label`), campos de formulario, atributos `alt` y contraste WCAG 2.2 AA.
   - **`📱 Responsive QA`** (`#A78BFA`): Emula resoluciones (390px móvil, 1440px desktop), comprueba tamaños táctiles ($\ge 44\text{px}$) y carga visual.
   - **`⚡ Interactive QA`** (`#F472B6`): Coordina mutaciones con candado exclusivo (`LockManager`), ejecuta clics reales (CDP), scroll de página y cambios de ruta.

2. **Cinemática Visible y Cero Coordenadas Quemadas:**
   - Cada subagente se posiciona dinámicamente mediante **selectores semánticos reales del DOM** (`getBoundingClientRect()`).
   - Los cursores planean suavemente (`cubic-bezier`), muestran ondas de clic (`swarm-cursor-ripple`) y abrazan los elementos con cajas elásticas que pulsan mientras miden.
   - La barra flotante inferior (HUD) actualiza los contadores en vivo (`role="status"`, `aria-live="polite"`).

3. **Orquestación y Delegación:**
   - Para ejecutar la coreografía completa, invocar `node scripts/swarm-orchestrator.mjs` o despachar subagentes con `invoke_subagent` según la complejidad del proyecto.
   - Los hallazgos se guardan estructurados en `.qa/latest.json` y se anclan con pines interactivos sobre la vista.

---

## 🔍 Modo de QA Visual en Vivo con Navegador Integrado (`native_browser`)

Cuando se audite una aplicación paso a paso con el usuario:
- Emplea exclusivamente las herramientas MCP `native_browser_*` para seleccionar y controlar la pestaña visible en el panel.
- Mantén la pestaña visible en la conversación para que el usuario supervise cada navegación, clic y scroll.
- Audita una sección a la vez (métricas, tablas, catálogo, responsive, overflows) y haz una pausa obligatoria tras cada sección.
- Reporta las observaciones técnicas y espera los comentarios del Inspector del usuario antes de pasar a la siguiente ruta.
- No realices mutaciones ni envíos de formularios destructivos con datos reales.
