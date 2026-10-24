// Agent mode: hands a spoken task to the local Claude Code CLI (`claude -p`), which acts on the computer.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SYSTEM_PROMPT = `Você é o agente de voz do DronsioFlow. O usuário falou uma tarefa (transcrita por reconhecimento de voz, então pode haver pequenos erros de transcrição) e você deve executá-la no computador e no navegador dele, usando o Chrome (ferramentas do Claude in Chrome) e o terminal quando precisar.

O DronsioFlow mostra ao usuário cada ação que altera algo (comandos no terminal, criação ou edição de arquivos, cliques, digitação e scripts no navegador) e só deixa executar o que ele confirmar. Se uma ação for recusada, não tente fazê-la de outro jeito: termine dizendo o que não foi feito.

Além disso, antes de uma ação com efeito externo ou irreversível no mundo — enviar mensagem ou e-mail, publicar ou comentar, comprar ou pagar — prepare tudo antes (abrir a conversa, escrever o rascunho), pare logo antes do passo final e responda somente com uma única linha no formato:
CONFIRMAR: <descrição exata da ação, ex.: enviar "Oi Amanda, como você está?" para Amanda no WhatsApp>
Não execute a ação nessa resposta. Só prossiga quando o usuário responder "Confirmado". Se depois surgir outra ação desse tipo, peça confirmação de novo. Para criar, alterar ou apagar arquivos e rodar comandos, não precisa desta linha: use a ferramenta e o app pede a confirmação.

Ao terminar, responda em português do Brasil, de forma curta (uma ou duas frases): o que foi feito ou o que você encontrou. Se não conseguir, diga o motivo em uma frase.`;

// Headless runs can't answer permission prompts: `-p` denies whatever is not pre-approved. So:
// - a PreToolUse hook (native/agent_hook.js) sees EVERY tool call and asks the app (toolPolicy):
//   reading passes, sensitive files are refused, and anything else, unknown tools included, waits
//   for the user, who sees the real call. If the hook fails, only the read-only tools in
//   --allowedTools can run; everything else stays denied;
// - --disallowedTools removes, as a second layer, tools that act outside this computer or this task
//   (messages to other sessions, remote triggers, schedules, worktrees, skills, the claude.ai account
//   connectors) and reading sensitive files;
// - --setting-sources "" ignores ~/.claude/settings.json and project settings, so the user's own
//   permissions.allow or defaultMode can't widen this. Login lives in ~/.claude.json and the
//   credentials file, not in settings, so the account keeps working;
// - never --dangerously-skip-permissions.
const CHROME = "mcp__claude-in-chrome__";
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch"];
// the agent's own bookkeeping; subagents (Task/Agent) go through the same hook for each of their calls
const AGENT_TOOLS = ["Task", "Agent", "ToolSearch", "TodoWrite", "TaskStop"];
const READ_ONLY_CHROME = [
  "read_page", "get_page_text", "find", "navigate", "tabs_context_mcp", "tabs_create_mcp", "list_connected_browsers",
  "select_browser", "switch_browser", "read_console_messages", "read_network_requests", "shortcuts_list", "resize_window",
];
// `computer` both looks (screenshot, zoom) and acts (click, type, key…): only looking skips the confirmation.
const READ_ONLY_COMPUTER = ["screenshot", "zoom"];
const DISALLOWED_TOOLS = [
  "SendMessage", "ListAgents", "RemoteTrigger", "PushNotification", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "EnterWorktree", "ExitWorktree", "DesignSync", "Monitor", "Skill", "mcp__claude_ai_Claude_Docs",
];
// Never read, not even with confirmation: keys, tokens, browser profiles, the app's and Claude's own data.
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".claude", ".config", ".local/share/keyrings", ".mozilla"];
const SENSITIVE_FILES = [".claude.json"];
const SENSITIVE_NAME = /^(\.env.*|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.claude\.json.*)$/;
const DISALLOWED_READS = [
  ...SENSITIVE_DIRS.map((d) => `Read(~/${d}/**)`),
  ...SENSITIVE_FILES.map((f) => `Read(~/${f})`),
  "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/id_ed25519*)",
];
const HOOK_MATCHER = "*"; // every tool
const HOOK_SCRIPT = path.join(__dirname, "..", "native", "agent_hook.js");
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000; // the user's answer to one confirmation
const HOOK_TIMEOUT_S = CONFIRM_TIMEOUT_MS / 1000 + 60; // longer, so the dialog's timeout always wins

const PERMISSION_ARGS = [
  "--permission-mode", "default",
  "--setting-sources", "",
  "--allowedTools", [...READ_ONLY_TOOLS, ...READ_ONLY_CHROME.map((t) => CHROME + t)].join(","),
  "--disallowedTools", [...DISALLOWED_TOOLS, ...DISALLOWED_READS].join(","),
];

/** Absolute path with ~ expanded and symlinks resolved as far as the path exists. */
function realPath(p, cwd) {
  let abs = path.resolve(cwd, String(p).replace(/^~(?=$|\/)/, os.homedir()));
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(abs), ...rest.reverse());
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.join(abs, ...rest.reverse());
      rest.push(path.basename(abs));
      abs = parent;
    }
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** "deny" for a sensitive file or anything inside a sensitive folder, "contains" when one is below p. */
function sensitivity(p, cwd) {
  const home = os.homedir();
  const lexical = path.resolve(cwd, String(p).replace(/^~(?=$|\/)/, home));
  const dirs = SENSITIVE_DIRS.map((d) => path.join(home, d));
  const files = SENSITIVE_FILES.map((f) => path.join(home, f));
  const targets = [...dirs, ...files];
  for (const t of [...targets]) targets.push(realPath(t, cwd)); // ~/.config may itself be a link
  for (const candidate of new Set([lexical, realPath(p, cwd)])) {
    if (SENSITIVE_NAME.test(path.basename(candidate))) return "deny";
    if (targets.some((t) => inside(candidate, t))) return "deny";
    if (targets.some((t) => inside(t, candidate))) return "contains";
  }
  return null;
}

/** Folder a Glob/Grep searches: its path, else the fixed start of an absolute pattern, else cwd. */
function searchRoot(name, input) {
  if (input?.path) return input.path;
  const pattern = name === "Glob" ? input?.pattern : input?.glob;
  if (typeof pattern === "string" && /^[/~]/.test(pattern)) {
    const fixed = pattern.split("/").findIndex((part) => /[*?[{]/.test(part));
    return fixed < 0 ? pattern : pattern.split("/").slice(0, fixed).join("/") || "/";
  }
  return null;
}

/**
 * The app's answer to a tool call: "allow" (reads, the agent's own bookkeeping), "deny" (reading
 * sensitive files: refused without asking) or "confirm" (everything else, unknown tools included).
 */
function toolPolicy(name, input, { cwd = os.homedir() } = {}) {
  if (name === "Read") {
    if (typeof input?.file_path !== "string") return "confirm";
    return sensitivity(input.file_path, cwd) === "deny" ? "deny" : "allow";
  }
  if (name === "Glob" || name === "Grep") {
    const s = sensitivity(searchRoot(name, input) ?? cwd, cwd);
    // a search over a folder that holds sensitive ones (e.g. the whole home) is shown first
    return s === "deny" ? "deny" : s === "contains" ? "confirm" : "allow";
  }
  if (READ_ONLY_TOOLS.includes(name) || AGENT_TOOLS.includes(name)) return "allow";
  if (name.startsWith(CHROME)) {
    const tool = name.slice(CHROME.length);
    if (READ_ONLY_CHROME.includes(tool)) return "allow";
    if (tool === "computer" && READ_ONLY_COMPUTER.includes(input?.action)) return "allow";
  }
  return "confirm";
}

const clip = (s, max) => {
  s = String(s ?? "");
  return s.length > max ? `${s.slice(0, max)}\n… (mais ${s.length - max} caracteres)` : s;
};
const fields = (input, skip = []) =>
  Object.entries(input || {})
    .filter(([k, v]) => !skip.includes(k) && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");

const COMPUTER_ACTIONS = {
  left_click: "Clicar no Chrome", right_click: "Clicar com o botão direito no Chrome", double_click: "Dar duplo clique no Chrome",
  triple_click: "Dar triplo clique no Chrome", type: "Digitar no Chrome", key: "Pressionar teclas no Chrome",
  scroll: "Rolar a página no Chrome", scroll_to: "Rolar a página no Chrome", left_click_drag: "Arrastar no Chrome", hover: "Passar o mouse no Chrome",
};

/** What the confirmation dialog shows: the call itself (command, path and content, click target, typed text). */
function describeToolCall(name, input = {}) {
  const tool = name.startsWith(CHROME) ? name.slice(CHROME.length) : name;
  switch (name.startsWith(CHROME) ? `chrome:${tool}` : tool) {
    case "Bash":
      return { title: "Executar um comando no terminal", detail: clip(input.command, 4000) };
    case "Write":
      return { title: "Criar ou substituir um arquivo", detail: `${input.file_path}\n\n${clip(input.content, 1500)}` };
    case "Edit":
      return {
        title: "Editar um arquivo",
        detail: `${input.file_path}${input.replace_all ? " (todas as ocorrências)" : ""}\n\nTrocar:\n${clip(input.old_string, 700)}\n\nPor:\n${clip(input.new_string, 700)}`,
      };
    case "MultiEdit":
      return {
        title: "Editar um arquivo",
        detail: `${input.file_path}\n\n${clip((input.edits || []).map((e) => `Trocar:\n${e.old_string}\nPor:\n${e.new_string}`).join("\n\n"), 1500)}`,
      };
    case "WebFetch":
      return { title: "Buscar uma página da web", detail: `${input.url}\n\nPara: ${clip(input.prompt, 1000)}` };
    case "NotebookEdit":
      return { title: "Editar um notebook", detail: `${input.notebook_path} (${input.edit_mode || "replace"})\n\n${clip(input.new_source, 1500)}` };
    case "chrome:computer":
      return { title: COMPUTER_ACTIONS[input.action] || `Ação no Chrome: ${input.action}`, detail: clip(fields(input, ["tabId"]), 2000) };
    case "chrome:form_input":
      return { title: "Preencher um campo no Chrome", detail: clip(fields(input, ["tabId"]), 2000) };
    case "chrome:javascript_tool":
      return { title: "Rodar JavaScript na página do Chrome", detail: clip(input.text ?? fields(input, ["tabId"]), 3000) };
    default:
      return { title: `Usar a ferramenta ${name.startsWith(CHROME) ? `${tool} do Chrome` : tool}`, detail: clip(fields(input, ["tabId"]), 2000) };
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * `--settings` with the PreToolUse hook. Claude Code runs hook commands through a shell, so every
 * part is quoted; the app's own runtime runs the helper (Electron as Node, or Node in the tests).
 */
function hookSettings(socketPath) {
  const command = `ELECTRON_RUN_AS_NODE=1 ${[process.execPath, HOOK_SCRIPT, socketPath].map(shellQuote).join(" ")}`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] } });
}

const TMP_PREFIX = "dronsio-agent-";

/** Removes this user's socket folders older than a day, left behind if the app was killed. */
function cleanStaleDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));
  } catch {}
  for (const name of names) {
    const dir = path.join(os.tmpdir(), name);
    try {
      const st = fs.lstatSync(dir);
      if (st.isDirectory() && st.uid === process.getuid() && Date.now() - st.mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Unix socket the hook asks, in a private temporary directory (0700, socket 0600).
 * onRequest({ tool_name, tool_input }, closed) resolves true to allow; `closed` settles when the hook
 * hung up (Claude Code killed it), so a pending dialog can be dropped. Returns { socketPath, close }.
 */
async function permissionServer(onRequest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const socketPath = path.join(dir, "hook.sock");
  const server = net.createServer((conn) => {
    let buf = "";
    let asked = false;
    const closed = new Promise((resolve) => conn.on("close", resolve));
    conn.on("error", () => {});
    conn.on("data", async (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (asked || i < 0) return;
      asked = true;
      let allow = false;
      try {
        const call = JSON.parse(buf.slice(0, i));
        allow = typeof call.tool_name === "string" && (await onRequest(call, closed)) === true;
      } catch {}
      if (!conn.destroyed) conn.end(JSON.stringify({ allow }) + "\n");
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const close = () => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { socketPath, close };
}

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
function buildArgs({ prompt, sessionId, hookSocket }) {
  const args = ["-p", "--chrome", "--output-format", "stream-json", "--verbose", "--append-system-prompt", SYSTEM_PROMPT, ...PERMISSION_ARGS];
  // without the hook, the tools that change something just stay denied
  if (hookSocket) args.push("--settings", hookSettings(hookSocket));
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
 * claude runs in its own process group, so a cancel or timeout also stops the commands it started.
 * Returns { promise, cancel(force), hold }: hold() pauses the timeout (while the user is deciding a
 * confirmation) until the function it returns is called.
 */
function run({ bin, prompt, sessionId, hookSocket, timeoutMs, cwd = os.homedir(), onEvent }) {
  const child = spawn(bin, buildArgs({ prompt, sessionId, hookSocket }), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let cancelled = false;
  let timedOut = false;
  let exited = false;
  const out = { sessionId: sessionId || null, result: null, isError: false };
  let stderr = "";
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  // SIGTERM lets claude stop cleanly; whatever is left of the group gets SIGKILL
  const stop = () => {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 3000).unref();
  };
  let timer = null;
  let remaining = timeoutMs;
  let armedAt = 0;
  let holds = 0;
  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, remaining);
  };
  const promise = new Promise((resolve, reject) => {
    arm();
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
      exited = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timer);
      if (cancelled) return reject(Object.assign(new Error("cancelado"), { cancelled: true }));
      if (timedOut) return reject(new Error(`tempo esgotado (${Math.round(timeoutMs / 60000)} min)`));
      if (out.result === null) return reject(new Error(stderr.trim().split("\n").pop() || `claude saiu com código ${code}`));
      resolve(out);
    });
  });
  // force: the app is quitting, so there is no time for a clean SIGTERM
  const cancel = (force = false) => {
    if (exited || cancelled || !child.pid) return;
    cancelled = true;
    if (force) killGroup("SIGKILL");
    else stop();
  };
  const hold = () => {
    if (holds++ === 0) {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - armedAt));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--holds === 0 && !exited) arm();
    };
  };
  return { promise, cancel, hold };
}

module.exports = {
  SYSTEM_PROMPT,
  CONFIRMED_PROMPT,
  CONFIRM_TIMEOUT_MS,
  HOOK_TIMEOUT_S,
  findClaude,
  buildArgs,
  streamParser,
  confirmationRequest,
  toolPolicy,
  describeToolCall,
  cleanStaleDirs,
  permissionServer,
  run,
};
