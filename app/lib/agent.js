// Agent mode: hands a spoken task to the local Claude Code CLI (`claude -p`), which acts on the computer.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SYSTEM_PROMPT = `Você é o agente de voz do DronsioFlow. O usuário falou uma tarefa (transcrita por reconhecimento de voz, então pode haver pequenos erros de transcrição) e você deve executá-la no computador e no navegador dele, usando o Chrome (ferramentas do Claude in Chrome) e o terminal quando precisar.

Regra de confirmação, obrigatória: ANTES de qualquer ação com efeito externo ou irreversível — enviar mensagem ou e-mail, publicar ou comentar, comprar ou pagar, criar, alterar, mover ou apagar arquivos, rodar comandos que alteram o sistema (instalar, remover, mudar configurações) — pare e responda somente com uma única linha no formato:
CONFIRMAR: <descrição exata da ação, ex.: enviar "Oi Amanda, como você está?" para Amanda no WhatsApp>
Não execute a ação nessa resposta. Prepare tudo antes (abrir a conversa, escrever o rascunho) e pare logo antes do passo final. Só prossiga quando o usuário responder "Confirmado". Se depois surgir outra ação desse tipo, peça confirmação de novo.

Ações só de leitura (abrir sites, pesquisar, ler páginas ou arquivos) não precisam de confirmação. Na dúvida, peça confirmação.
Ao terminar, responda em português do Brasil, de forma curta (uma ou duas frases): o que foi feito ou o que você encontrou. Se não conseguir, diga o motivo em uma frase.`;

// Headless runs can't answer permission prompts, and `-p` denies anything that would prompt. So:
// - acceptEdits: file edits go through without asking;
// - allowedTools: the browser (every Claude in Chrome tool), the shell and file/web tools are
//   pre-approved, so the agent can work without stalling;
// - never --dangerously-skip-permissions: tools outside this list stay denied.
// Sensitive actions are gated by the CONFIRMAR rule in the system prompt, checked by the app.
const PERMISSION_ARGS = [
  "--permission-mode", "acceptEdits",
  "--allowedTools", "mcp__claude-in-chrome,Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch",
];

const CONFIRMED_PROMPT = "Confirmado, pode executar.";

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Path of the claude binary: the configured one, else `claude` on PATH, else ~/.local/bin/claude. */
function findClaude(configured) {
  if (configured) return isExecutable(configured) ? configured : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, "claude"))) return path.join(dir, "claude");
  }
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  return isExecutable(local) ? local : null;
}

/** Arguments for a new task, or for resuming `sessionId` after the user confirmed. */
function buildArgs({ prompt, sessionId }) {
  const args = ["-p", "--chrome", "--output-format", "stream-json", "--verbose", "--append-system-prompt", SYSTEM_PROMPT, ...PERMISSION_ARGS];
  if (sessionId) args.push("--resume", sessionId);
  // "--" so the instruction is never read as an option, whatever the user said
  args.push("--", sessionId ? CONFIRMED_PROMPT : prompt);
  return args;
}

/** Splits stdout into JSON events; non-JSON lines are ignored. */
function streamParser(onEvent) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      onEvent(event);
    }
  };
}

/** The action to confirm when the agent stopped with a "CONFIRMAR: …" line, else null. */
function confirmationRequest(answer) {
  const m = /^[ \t*_>`]*CONFIRMAR[ \t*_]*:[ \t*_]*(.+)$/im.exec(answer || "");
  return m ? m[1].replace(/[*_`]+$/, "").trim() || null : null;
}

/**
 * Runs one `claude -p` turn. Resolves with { sessionId, result, isError } from the stream's
 * "result" event; rejects on spawn failure, timeout, cancel or exit without a result.
 * Returns { promise, cancel }.
 */
function run({ bin, prompt, sessionId, timeoutMs, cwd = os.homedir(), onEvent }) {
  const child = spawn(bin, buildArgs({ prompt, sessionId }), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let cancelled = false;
  let timedOut = false;
  const out = { sessionId: sessionId || null, result: null, isError: false };
  let stderr = "";
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on(
      "data",
      streamParser((event) => {
        if (event.session_id) out.sessionId = event.session_id;
        if (event.type === "result") {
          out.result = typeof event.result === "string" ? event.result : "";
          out.isError = Boolean(event.is_error);
        }
        onEvent?.(event);
      }),
    );
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) return reject(Object.assign(new Error("cancelado"), { cancelled: true }));
      if (timedOut) return reject(new Error(`tempo esgotado (${Math.round(timeoutMs / 60000)} min)`));
      if (out.result === null) return reject(new Error(stderr.trim().split("\n").pop() || `claude saiu com código ${code}`));
      resolve(out);
    });
  });
  const cancel = () => {
    if (child.exitCode !== null || cancelled) return;
    cancelled = true;
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000);
  };
  return { promise, cancel };
}

module.exports = { SYSTEM_PROMPT, CONFIRMED_PROMPT, findClaude, buildArgs, streamParser, confirmationRequest, run };
