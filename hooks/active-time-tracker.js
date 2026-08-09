#!/usr/bin/env node
'use strict';
// Active session time tracker.
// UserPromptSubmit → records turnStart. Stop → adds (now - turnStart) to totalMs.
// First run on a session bootstraps from transcript by replaying user→assistant pairs.
// Persistence: <claudeDir>/cache/active-time-<transcriptBasename>.json
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_TURN_MS = 6 * 3600000; // cap anti-crash por turno (sync com io.js readActiveTime)
// Teto por intervalo entre eventos consecutivos do transcript, usado só no bootstrap.
// Intervalo acima disto é pausa (humano fora, sessão aberta à noite), não trabalho: uma
// sessão real media 23h53m de relógio contra 53m48s de trabalho, e o maior intervalo dela
// tinha 22,5h. 300s cobre com folga o passo legítimo mais longo observado (suíte de 75s).
const MAX_GAP_MS = 300000;

// Só como hook: `require` deste arquivo pelo teste não pode prender o stdin (o listener
// de 'data' resume o stream e o processo nunca terminaria).
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => input += c);
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => { try { run(JSON.parse(input)); } catch { process.exit(0); } });
  setTimeout(() => process.exit(0), 4000).unref();
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

// Resultado de tool também é mensagem `user`: o content é array e carrega um bloco
// `tool_result` (o harness ainda anexa `toolUseResult`). Ler isso como prompt humano
// fatia um turno em micro-trechos e descarta TODO o tempo de execução das tools —
// medido num transcript real: 123 de 123 linhas `user` passavam como "prompt humano",
// contra 5 prompts de verdade, e o bootstrap devolvia 28m onde havia 53m de trabalho.
// Turno de subagente (isSidechain) não abre turno do humano.
function isHumanPrompt(msg) {
  if (msg.type !== 'user' || msg.isSidechain) return false;
  if (msg.toolUseResult) return false;
  const c = msg.message?.content;
  if (typeof c === 'string') return !c.startsWith('<');
  if (!Array.isArray(c)) return false;
  return !c.some(part => part && part.type === 'tool_result');
}

// Trabalho = soma dos intervalos entre eventos consecutivos, tirando o intervalo que
// TERMINA num prompt humano (aí quem pensava era o humano) e o que passa do teto de
// ociosidade. Definição de intervalo, e não de span do turno: o span user→último
// assistant engole a espera dentro do turno (AskUserQuestion, humano ausente), que numa
// sessão real chegou a 22,5h num único turno.
function bootstrapFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  const events = [];
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.timestamp) continue;
      const ts = new Date(msg.timestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      events.push({ ts, human: isHumanPrompt(msg) });
    }
  } catch { return 0; }
  events.sort((a, b) => a.ts - b.ts);
  let total = 0;
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].ts - events[i - 1].ts;
    if (gap > MAX_GAP_MS || events[i].human) continue;
    total += gap;
  }
  return total;
}

function run(payload) {
  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || '';
  const event = payload.hook_event_name || process.env.CLAUDE_HOOK_EVENT_NAME || '';
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const key = transcriptPath ? path.basename(transcriptPath, '.jsonl') : sessionId;
  if (!key) return;
  const file = path.join(claudeDir, 'cache', `active-time-${key}.json`);
  let state = { totalMs: 0, turnStart: 0, bootstrapped: false };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (!state.bootstrapped) {
    state.totalMs = bootstrapFromTranscript(transcriptPath);
    state.bootstrapped = true;
  }
  const now = Date.now();
  if (event === 'UserPromptSubmit') {
    // Prompt que chega no MEIO do turno (enfileirado, ou enviado enquanto o agente
    // trabalha) dispara este evento de novo. Sobrescrever o turnStart jogaria fora tudo
    // que o turno já gastou, então fecha o trecho aberto antes de reabrir.
    if (state.turnStart && now > state.turnStart) {
      const delta = now - state.turnStart;
      if (delta <= MAX_TURN_MS) state.totalMs += delta;
    }
    state.turnStart = now;
  } else if (event === 'Stop') {
    if (state.turnStart && now > state.turnStart) {
      // ponytail: cap por turno. Um Stop perdido (crash) deixaria turnStart antigo
      // e somaria um delta absurdo. 6h cobre turnos longos de agente legítimos.
      // Mantenha em sync com o cap em io.js readActiveTime.
      const delta = now - state.turnStart;
      if (delta <= MAX_TURN_MS) state.totalMs += delta;
    }
    state.turnStart = 0;
  }
  atomicWrite(file, JSON.stringify(state));
}

module.exports = { bootstrapFromTranscript, isHumanPrompt, run, MAX_TURN_MS, MAX_GAP_MS };
