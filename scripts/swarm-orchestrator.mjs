import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REGISTRY_PATH = join(homedir(), '.swarm-qa-browser', 'bus.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return null;
  try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return null; }
}

async function busRpc(reg, action, params = {}) {
  const res = await fetch(`http://${reg.host}:${reg.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-swarm-token': reg.token },
    body: JSON.stringify({ action, params })
  });
  return res.json();
}

async function tabCmd(reg, tabId, command, agentId = null) {
  return busRpc(reg, 'tab.command', { tabId, command, ...(agentId ? { agentId } : {}) });
}

export const SWARM_ROLES = [
  { id: 'layout', name: 'Layout Inspector', role: 'layout', color: '#38BDF8', status: 'Iniciando sesión' },
  { id: 'a11y', name: 'Forms & A11y', role: 'forms-a11y', color: '#34D399', status: 'Iniciando sesión' },
  { id: 'responsive', name: 'Responsive QA', role: 'responsive', color: '#A78BFA', status: 'Iniciando sesión' },
  { id: 'interactive', name: 'Interactive QA', role: 'interactive', color: '#F472B6', status: 'Coordinador listo' }
];

export async function runSwarmAudit({ tabId: reqTabId, checks = ['overflow', 'a11y', 'media'] } = {}) {
  const reg = loadRegistry();
  if (!reg) throw new Error(`Swarm bus no encontrado en ${REGISTRY_PATH}. Asegúrate de iniciar el daemon.`);

  const status = await busRpc(reg, 'session.status');
  const targetTab = reqTabId ? status.result?.tabs?.find((t) => t.tabId === reqTabId) : status.result?.tabs?.[0];
  if (!targetTab) throw new Error('No hay pestañas activas conectadas al bus de Swarm QA.');

  const tabId = targetTab.tabId;
  console.log(`[QA Annotator Swarm] Conectado a pestaña ${tabId} (${targetTab.url})`);

  // 1. Spawning the 4 agents
  await tabCmd(reg, tabId, { action: 'spawn_cursors', cursors: SWARM_ROLES });
  await tabCmd(reg, tabId, { action: 'update_summary', summary: { agents: 4, open: 0, awaiting: 0, verified: 0 } });
  await sleep(800);

  // 2. Ejecutar auditoría DOM profunda
  const auditRes = await tabCmd(reg, tabId, { action: 'run_audit', checks });
  const findings = auditRes.result?.findings || [];
  console.log(`[QA Annotator Swarm] ${findings.length} hallazgos detectados.`);

  // 3. Mapear hallazgos a tickets con selectores reales
  const tickets = findings.map((f, i) => ({
    id: `SWARM-${i + 1}`,
    ruleId: f.ruleId,
    severity: f.severity || 'warn',
    title: f.description || `Hallazgo ${f.ruleId}`,
    status: 'open',
    selector: f.selector,
    rect: f.rect
  }));

  // 4. Cada agente vuela hacia los hallazgos según su especialidad
  for (const ticket of tickets) {
    const agentId = ticket.ruleId.includes('a11y') ? 'a11y'
      : ticket.ruleId.includes('overflow') ? 'layout'
      : ticket.ruleId.includes('tap') ? 'responsive' : 'interactive';

    await tabCmd(reg, tabId, {
      action: 'move_cursor',
      cursor: { id: agentId, selector: ticket.selector, status: `Analizando ${ticket.ruleId}` }
    });
    await sleep(1000);
  }

  // 5. Fijar pines interactivos en la vista
  await tabCmd(reg, tabId, { action: 'set_tickets', tickets });
  await tabCmd(reg, tabId, { action: 'update_summary', summary: { agents: 4, open: tickets.length, awaiting: 0, verified: 0 } });

  // 6. Guardar resultados estructurados
  mkdirSync('.qa', { recursive: true });
  const reportPath = '.qa/latest.json';
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    tabId, url: targetTab.url,
    totalFindings: tickets.length,
    tickets
  }, null, 2));

  console.log(`[QA Annotator Swarm] Reporte guardado en ${reportPath}`);
  return { ok: true, tabId, url: targetTab.url, ticketsCount: tickets.length, tickets };
}

if (process.argv[1] && process.argv[1].endsWith('swarm-orchestrator.mjs')) {
  runSwarmAudit().catch((err) => {
    console.error('Error en swarm-orchestrator:', err?.message || err);
    process.exit(1);
  });
}
