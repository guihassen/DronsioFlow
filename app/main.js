// DronsioFlow — free, local voice dictation for Linux.
const { app, BrowserWindow, ipcMain, screen, clipboard, Tray, Menu, nativeImage, shell, Notification, nativeTheme } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const text = require("./lib/textproc");
const llm = require("./lib/llm");
const agent = require("./lib/agent");

app.setName("DronsioFlow");
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "dronsioflow");
const PYTHON = process.env.DRONSIO_PYTHON || path.join(DATA_DIR, "venv", "bin", "python");
const NATIVE = path.join(__dirname, "native");
const USER_DIR = app.getPath("userData");
const FILES = {
  settings: path.join(USER_DIR, "settings.json"),
  history: path.join(USER_DIR, "history.json"),
  notes: path.join(USER_DIR, "notes.json"),
  meetings: path.join(USER_DIR, "meetings.json"),
  log: path.join(USER_DIR, "dictation.log"),
};
const TMP_DIR = path.join(os.tmpdir(), `dronsioflow-${process.getuid()}`);
const SAMPLE_RATE = 16000;
const MIN_RECORDING_MS = 300;
const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_MEETING_MS = 4 * 60 * 60 * 1000;

// evdev key codes; right-hand modifiers are folded into the left ones.
const KEY = { ctrl: 29, shift: 42, alt: 56, super: 125, space: 57, esc: 1, z: 44, x: 45 };
const NORMALIZE = { 97: 29, 54: 42, 100: 56, 126: 125 };

// Shortcuts that record while held (or toggle, for handsFree) and the mode they record in.
const RECORDING_ACTIONS = { pushToTalk: "dictation", handsFree: "dictation", command: "command", note: "note", agent: "agent" };

const DEFAULT_SETTINGS = {
  shortcuts: {
    pushToTalk: [KEY.ctrl, KEY.super],
    handsFree: [KEY.ctrl, KEY.super, KEY.space],
    command: [KEY.ctrl, KEY.super, KEY.alt],
    note: [],
    agent: [KEY.ctrl, KEY.super, KEY.shift], // like command mode: add Shift to Ctrl+Super
    pasteLast: [KEY.shift, KEY.alt, KEY.z],
    copyLast: [KEY.shift, KEY.alt, KEY.x],
    cycleStyle: [], // switches to the next writing style
    "style:natural": [],
    "style:formal": [],
    "style:casual": [],
    "style:veryCasual": [],
    "style:technical": [],
  },
  model: "small",
  language: "pt",
  microphone: "auto", // "auto" | "bluetooth" (prefer a Bluetooth headset) | "" (system default) | a source name
  dictionary: [], // { term, heardAs }
  snippets: [], // { id, trigger, text }
  pasteKeys: "shift+insert",
  restoreClipboard: true,
  sounds: true,
  ai: {
    enabled: true, // Ollama features: command mode, transforms, meeting summaries
    formatDictation: false, // also rewrite every dictation (slow on CPU: ~8 s)
    model: "",
    style: "natural",
    removeFillers: true,
    selfCorrections: true,
    lists: true,
    translateTo: "",
  },
  agent: {
    enabled: null, // null: on when the claude binary is found
    bin: "", // empty: `claude` on PATH, else ~/.local/bin/claude
    timeoutMin: 10, // per claude run
  },
  polishPresets: llm.DEFAULT_POLISH_PRESETS,
  meetingSystemAudio: true,
  autostart: false,
  theme: "system", // system | light | dark
  showIdleBar: true,
  dismissed: [], // intro banners the user closed
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(file + ".tmp", file);
}

/** One line per pipeline step, so a dictation that didn't paste can be traced afterwards. */
function logStep(...parts) {
  try {
    if (fs.statSync(FILES.log, { throwIfNoEntry: false })?.size > 512 * 1024) fs.renameSync(FILES.log, FILES.log + ".old");
    fs.appendFileSync(FILES.log, `${new Date().toISOString()} ${parts.join(" ")}\n`);
  } catch {}
}

function mergeDefaults(saved) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(saved.shortcuts || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(saved.ai || {}) },
    agent: { ...DEFAULT_SETTINGS.agent, ...(saved.agent || {}) },
  };
  // v1 kept a free-form vocabulary box; turn it into dictionary terms
  if (saved.vocabulary && !saved.dictionary) {
    merged.dictionary = saved.vocabulary
      .split(/[,\n]/)
      .map((t) => ({ term: t.trim(), heardAs: "" }))
      .filter((e) => e.term);
  }
  delete merged.vocabulary;
  return merged;
}

let settings = mergeDefaults(readJson(FILES.settings, {}));
let history = readJson(FILES.history, []);
let notes = readJson(FILES.notes, []);
let meetings = readJson(FILES.meetings, []);

const saveSettings = () => writeJson(FILES.settings, settings);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// App state (pushed to the UI)
// ---------------------------------------------------------------------------

const state = {
  phase: "idle", // idle | recording | processing
  mode: null, // dictation | command | note | agent
  locked: false, // hands-free
  step: null, // transcribing | formatting | agent (claude working) | confirm (waiting for the user)
  model: { name: settings.model, state: "idle", progress: 0, error: null },
  input: { keyboards: 0, uinput: false, running: false },
  ollama: { available: false, models: [] },
  meeting: { recording: false, startedAt: 0, processing: false, progress: 0, step: null },
  mic: { device: "", label: "Padrão do sistema", bluetooth: false }, // mic recordings use right now
  agent: { bin: null, action: null }, // claude binary found; action waiting for confirmation
  capture: null, // shortcut name being recorded from the keyboard
  lastError: null,
  flash: null, // short message shown on the floating bar (e.g. the new writing style)
};

let mainWindow = null;
let overlayWindow = null;
let tray = null;

// First name from the account's full name (GECOS), falling back to the login name.
const USER_NAME = process.env.DRONSIO_USER_NAME ?? (() => {
  try {
    const line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.split(":")[2] === String(process.getuid()));
    const full = line?.split(":")[4]?.split(",")[0]?.trim();
    if (full) return full.split(/\s+/)[0];
  } catch {}
  const login = os.userInfo().username;
  return login.charAt(0).toUpperCase() + login.slice(1);
})();

function snapshot() {
  return { state, settings, history: history.slice(0, 150), notes, meetings, stats: stats(), userName: USER_NAME };
}

function broadcast() {
  const payload = snapshot();
  for (const w of [mainWindow, overlayWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send("state", payload);
  }
  updateOverlay();
}

function stats() {
  const today = new Date().toDateString();
  let words = 0;
  let wordsToday = 0;
  let speakingMs = 0;
  let spokenWords = 0;
  const days = new Set();
  for (const h of history) {
    const n = text.countWords(h.text);
    const d = new Date(h.at);
    words += n;
    days.add(d.toDateString());
    if (d.toDateString() === today) wordsToday += n;
    if (h.durationMs && h.raw) {
      speakingMs += h.durationMs;
      spokenWords += text.countWords(h.raw);
    }
  }
  let streak = 0;
  for (let d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++;
  const wpm = speakingMs > 0 ? Math.round(spokenWords / (speakingMs / 60000)) : 0;
  return { words, wordsToday, count: history.length, wpm, streak };
}

function setError(message) {
  state.lastError = message;
  broadcast();
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON, silent: true }).show();
}

// ---------------------------------------------------------------------------
// Child processes: input helper and transcription engine (JSON lines)
// ---------------------------------------------------------------------------

function spawnJsonProcess(name, script, onMessage, onExit) {
  const child = spawn(PYTHON, ["-I", path.join(NATIVE, script)], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        console.warn(`[${name}] bad line`, line);
      }
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  child.on("error", (e) => console.error(`[${name}]`, e.message));
  child.on("exit", (code) => onExit(code));
  child.send = (obj) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
  };
  return child;
}

let inputHelper = null;
let engine = null;
const pending = new Map(); // request id -> { resolve, reject, onProgress }

function request(child, cmd, { timeoutMs, onProgress } = {}) {
  const id = newId();
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          pending.delete(id);
          reject(new Error("tempo esgotado"));
        }, timeoutMs)
      : null;
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
      onProgress,
    });
    child.send({ ...cmd, id });
  });
}

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
}

function startInputHelper() {
  inputHelper = spawnJsonProcess("input", "input_helper.py", onInputMessage, () => {
    state.input = { keyboards: 0, uinput: false, running: false };
    broadcast();
    if (!quitting) setTimeout(startInputHelper, 2000);
  });
  state.input.running = true;
}

function startEngine() {
  engine = spawnJsonProcess("engine", "transcriber.py", onEngineMessage, () => {
    for (const [id, p] of pending) {
      p.reject(new Error("motor de transcrição reiniciou"));
      pending.delete(id);
    }
    state.model.state = "idle";
    broadcast();
    if (!quitting)
      setTimeout(() => {
        startEngine();
        loadModel();
      }, 2000);
  });
}

function loadModel() {
  state.model = { name: settings.model, state: "loading", progress: 0, error: null };
  broadcast();
  engine.send({ cmd: "load", model: settings.model });
}

function onEngineMessage(msg) {
  if (msg.t === "model") {
    state.model = {
      name: msg.model,
      state: msg.state,
      progress: msg.progress ?? (msg.state === "ready" ? 1 : state.model.progress),
      error: msg.error || null,
    };
    broadcast();
  } else if (msg.t === "progress") {
    pending.get(msg.id)?.onProgress?.(msg.progress);
  } else if (msg.t === "result") {
    settle(msg);
  }
}

function whisperPrompt() {
  const terms = text.dictionaryTerms(settings.dictionary);
  if (settings.ai.style === "technical") terms.push(...text.TECH_TERMS.filter((t) => !terms.includes(t)));
  return terms.join(", ");
}

function transcribe(files, { task = "transcribe", progress } = {}) {
  return request(
    engine,
    {
      cmd: "transcribe",
      paths: files,
      language: settings.language,
      task,
      prompt: whisperPrompt(),
      progress: Boolean(progress),
    },
    { onProgress: progress },
  );
}

function paste(content) {
  return request(
    inputHelper,
    { cmd: "paste", text: content, keys: settings.pasteKeys, restoreClipboard: settings.restoreClipboard },
    { timeoutMs: 6000 },
  ).catch(() => ({ ok: false, reason: "timeout" }));
}

function readSelection() {
  return request(inputHelper, { cmd: "selection" }, { timeoutMs: 2000 })
    .then((m) => m.text || "")
    .catch(() => "");
}

/**
 * `returnFocus`: the action started in another app. If our window took the focus since then (opened
 * to check on a long dictation), minimizing it hands the focus back to that app, so the paste lands there.
 */
async function pasteOrCopy(content, { returnFocus = false } = {}) {
  if (returnFocus && mainWindow?.isFocused()) {
    logStep("window focused during processing: minimizing to return focus");
    mainWindow.minimize();
    for (let i = 0; i < 20 && mainWindow.isFocused(); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100)); // let the other app settle its keyboard focus
  }
  // Our own window has focus (the action started here): Shift+Insert would land nowhere,
  // so leave the text on the clipboard instead.
  if (mainWindow?.isFocused()) {
    clipboard.writeText(content);
    logStep("paste skipped: DronsioFlow window focused");
    notify("Texto copiado", "A janela do DronsioFlow estava em foco; cole com Ctrl+V onde quiser.");
    return;
  }
  const result = process.env.DRONSIO_TEST_NO_PASTE ? { ok: true } : await paste(content);
  logStep(`paste ok=${result.ok}`, result.reason ? `reason=${result.reason}` : "", `chars=${content.length}`);
  if (!result.ok) {
    clipboard.writeText(content);
    setError("Não consegui colar automaticamente; o texto está na área de transferência.");
  }
}

// ---------------------------------------------------------------------------
// Ollama availability
// ---------------------------------------------------------------------------

// Best quality/speed/memory trade-off measured on a 16 GB laptop CPU (tools/bench_llm.mjs).
const PREFERRED_MODELS = ["gemma4:e2b", "gemma3:4b", "gemma3:1b"];

async function refreshOllama() {
  const models = await llm.listModels();
  state.ollama = { available: models !== null, models: models || [] };
  if (models?.length && !settings.ai.model) {
    settings.ai.model = models.find((m) => PREFERRED_MODELS.includes(m)) || models[0];
    saveSettings();
  }
  broadcast();
  return models;
}

const aiReady = () => settings.ai.enabled && state.ollama.available && Boolean(settings.ai.model);

// Dictations go through the LLM only when asked to: formatting, or a translation Whisper can't do.
const useLlmFormatting = () =>
  aiReady() && (settings.ai.formatDictation || (Boolean(settings.ai.translateTo) && settings.ai.translateTo !== "en"));

const formattingPrompt = (language) =>
  llm.formattingSystemPrompt({ ...settings.ai, language, terms: text.dictionaryTerms(settings.dictionary) });

// Language to warm the prompt cache with before we know what the user will say.
const expectedLanguage = () => (settings.language && settings.language !== "auto" ? settings.language : "pt");

/** Keeps the dictation formatting prompt in Ollama's cache. */
function warmFormatting() {
  if (useLlmFormatting()) llm.warm(settings.ai.model, formattingPrompt(expectedLanguage()));
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

const pressed = new Set();
let chord = 0; // increments every time all keys are released
let lockChord = 0;
let activeKeys = []; // keys of the shortcut that is currently recording
let captureKeys = new Set();
let selectionPromise = null;

const matches = (keys) => keys?.length > 0 && keys.length === pressed.size && keys.every((k) => pressed.has(k));

function allShortcuts() {
  const list = Object.entries(settings.shortcuts).map(([name, keys]) => ({ name, keys }));
  for (const p of settings.polishPresets) {
    if (p.shortcut?.length) list.push({ name: `polish:${p.id}`, keys: p.shortcut });
  }
  return list;
}

function onInputMessage(msg) {
  if (msg.t === "status") {
    state.input = { keyboards: msg.keyboards, uinput: msg.uinput, running: true };
    broadcast();
  } else if (msg.t === "pasted" || msg.t === "selection") {
    settle(msg);
  } else if (msg.t === "key") {
    const code = NORMALIZE[msg.code] ?? msg.code;
    if (msg.down) pressed.add(code);
    else pressed.delete(code);
    if (state.capture) onCaptureKey(code, msg.down);
    else if (msg.down) onKeyDown(code);
    else onKeyUp(code);
    if (pressed.size === 0) chord++;
  }
}

function onCaptureKey(code, down) {
  if (down) {
    captureKeys.add(code);
    return;
  }
  if (pressed.size > 0 || captureKeys.size === 0) return;
  const keys = [...captureKeys];
  const name = state.capture;
  captureKeys = new Set();
  state.capture = null;
  const owner = keys.length && shortcutOwner(keys, name);
  if (owner) {
    state.lastError = `Esse atalho já é usado em "${owner}". Escolha outra combinação.`;
  } else if (!(keys.length === 1 && keys[0] === KEY.esc)) {
    state.lastError = reachesFocusedApp(keys)
      ? "Atenção: o DronsioFlow não bloqueia as teclas, então o app em foco também recebe esse atalho (Ctrl+S salvaria, por exemplo). Prefira combinações com Alt ou Super."
      : null;
    if (name.startsWith("polish:")) {
      const preset = settings.polishPresets.find((p) => `polish:${p.id}` === name);
      if (preset) preset.shortcut = keys;
    } else {
      settings.shortcuts[name] = keys;
    }
    saveSettings();
  }
  broadcast();
}

function onKeyDown(code) {
  if (state.phase === "recording") {
    if (code === KEY.esc) return cancelRecording();
    const { shortcuts } = settings;
    // A style shortcut that starts with the dictation keys (e.g. Ctrl+Super+1) began a recording
    // by accident: drop it and switch the style instead.
    const styleHit = !state.locked && styleShortcuts().find((s) => matches(s.keys));
    if (styleHit) {
      cancelRecording();
      return applyStyleShortcut(styleHit.name);
    }
    if (!state.locked) {
      if (matches(shortcuts.handsFree)) {
        state.locked = true; // keep recording after the keys are released
        lockChord = chord;
        return broadcast();
      }
      for (const name of ["command", "note", "agent"]) {
        if (matches(shortcuts[name]) && state.mode !== RECORDING_ACTIONS[name]) return switchMode(RECORDING_ACTIONS[name], shortcuts[name]);
      }
    } else if (chord > lockChord && (matches(shortcuts.handsFree) || matches(shortcuts.pushToTalk))) {
      stopRecording();
    }
    return;
  }
  if (state.phase === "processing" && state.mode === "agent" && code === KEY.esc) return cancelAgent();
  if (state.phase !== "idle") return;
  const hit = allShortcuts().find((s) => matches(s.keys));
  if (!hit) return;
  if (hit.name in RECORDING_ACTIONS) {
    startRecording(RECORDING_ACTIONS[hit.name], hit.keys, hit.name === "handsFree");
  } else if (hit.name === "pasteLast") {
    if (history[0]) pasteOrCopy(history[0].text);
  } else if (hit.name === "copyLast") {
    if (history[0]) clipboard.writeText(history[0].text);
  } else if (hit.name.startsWith("polish:")) {
    runPolish(hit.name.slice(7));
  } else if (hit.name === "cycleStyle" || hit.name.startsWith("style:")) {
    applyStyleShortcut(hit.name);
  }
}

// ---------------------------------------------------------------------------
// Writing styles: switch with a shortcut, confirm on the floating bar
// ---------------------------------------------------------------------------

const STYLE_ORDER = ["natural", "formal", "casual", "veryCasual", "technical"];
const STYLE_NAMES = { natural: "Natural", formal: "Formal", casual: "Casual", veryCasual: "Muito casual", technical: "Técnico" };

const SHORTCUT_NAMES = {
  pushToTalk: "Segurar para falar",
  handsFree: "Mãos livres",
  command: "Modo comando",
  note: "Nota por voz",
  agent: "Modo agente",
  pasteLast: "Colar o último ditado",
  copyLast: "Copiar o último ditado",
  cycleStyle: "Alternar estilo",
  ...Object.fromEntries(STYLE_ORDER.map((id) => [`style:${id}`, `Estilo ${STYLE_NAMES[id]}`])),
};

const styleShortcuts = () => allShortcuts().filter((s) => s.name === "cycleStyle" || s.name.startsWith("style:"));

/** Name of the action already using exactly these keys, ignoring `except`. */
function shortcutOwner(keys, except) {
  const same = (a) => a?.length === keys.length && a.every((k) => keys.includes(k));
  const hit = allShortcuts().find((s) => s.name !== except && same(s.keys));
  if (!hit) return null;
  if (hit.name.startsWith("polish:")) return settings.polishPresets.find((p) => `polish:${p.id}` === hit.name)?.name || "Transformação";
  return SHORTCUT_NAMES[hit.name] || hit.name;
}

/** Ctrl (+Shift) + one key is what apps use for their own commands (Ctrl+S, Ctrl+F…). */
function reachesFocusedApp(keys) {
  const mods = keys.filter((k) => [KEY.ctrl, KEY.shift, KEY.alt, KEY.super].includes(k));
  return keys.includes(KEY.ctrl) && !keys.includes(KEY.alt) && !keys.includes(KEY.super) && keys.length - mods.length === 1;
}

let flashTimer = null;
function flash(message) {
  state.flash = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    state.flash = null;
    broadcast();
  }, 1800);
  broadcast();
}

function applyStyleShortcut(name) {
  const current = STYLE_ORDER.indexOf(settings.ai.style);
  const style = name === "cycleStyle" ? STYLE_ORDER[(current + 1) % STYLE_ORDER.length] : name.slice(6);
  if (!STYLE_ORDER.includes(style)) return;
  settings.ai = { ...settings.ai, style };
  saveSettings();
  warmFormatting(); // the formatting prompt depends on the style
  flash(useLlmFormatting() ? STYLE_NAMES[style] : `${STYLE_NAMES[style]} · IA desligada`);
}

function onKeyUp(code) {
  if (state.phase === "recording" && !state.locked && activeKeys.includes(code)) stopRecording();
}

function switchMode(mode, keys) {
  if (mode === "agent" && agentProblem()) {
    cancelRecording();
    return reportAgentProblem();
  }
  state.mode = mode;
  activeKeys = keys;
  if (mode === "command") selectionPromise = readSelection();
  broadcast();
}

// ---------------------------------------------------------------------------
// Recording (PipeWire/PulseAudio via parecord, raw PCM on stdout)
// ---------------------------------------------------------------------------

let primary = null; // capture from the chosen microphone
let backup = null; // parallel capture from a wired mic when the chosen one is Bluetooth
let usedBackupNotice = false;
let recordingStartedAt = 0;
let startedInOwnWindow = false; // our window had the focus when the recording started
let maxTimer = null;
let levelTimer = null;
let currentLevel = 0;

function playSound(name) {
  if (!settings.sounds) return;
  const file = path.join(__dirname, "assets", "sounds", `${name}.wav`);
  spawn("pw-play", [file], { stdio: "ignore" }).on("error", () =>
    spawn("paplay", [file], { stdio: "ignore" }).on("error", () => {}),
  );
}

function recordArgs(device, latencyMs = 20) {
  const args = ["--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", `--latency-msec=${latencyMs}`];
  if (device) args.push(`--device=${device}`);
  return args;
}

function startRecording(mode, keys, locked) {
  if (state.model.state !== "ready") {
    setError("O modelo de voz ainda não está pronto.");
    showMainWindow();
    return;
  }
  if (mode === "agent" && agentProblem()) return reportAgentProblem();
  currentLevel = 0;
  recordingStartedAt = Date.now();
  startedInOwnWindow = Boolean(mainWindow?.isFocused());
  const mic = chooseMicrophone();
  primary = spawnCapture(mic.device);
  const fallback = mic.bluetooth ? bestWired() : null;
  backup = fallback ? spawnCapture(fallback.name) : null;
  primary.proc.on("error", (e) => {
    setError(`Falha ao gravar: ${e.message}`);
    cancelRecording();
  });
  Object.assign(state, { phase: "recording", mode, locked, step: null, lastError: null });
  activeKeys = keys;
  lockChord = chord;
  selectionPromise = mode === "command" ? readSelection() : null;
  if (mode === "command") {
    if (aiReady()) llm.warm(settings.ai.model); // load the model for the command
  } else if (mode !== "agent") warmFormatting(); // evaluate the prompt while the user speaks
  playSound("start");
  maxTimer = setTimeout(stopRecording, MAX_RECORDING_MS);
  silenceTimer = setTimeout(checkMicrophoneDelivers, NO_AUDIO_TIMEOUT_MS);
  levelTimer = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send("level", currentLevel);
    currentLevel *= 0.7;
  }, 50);
  broadcast();
}

// A Bluetooth headset can stay "connected" while its voice link (SCO) is stalled: the stream
// opens but no audio arrives, and the level bars just sit flat. Tell the user instead.
const NO_AUDIO_TIMEOUT_MS = 1500;
let silenceTimer = null;

function checkMicrophoneDelivers() {
  if (state.phase !== "recording" || primary?.bytes > 0) return;
  if (backup?.bytes > 0) return flash("Usando o microfone do notebook");
  const message =
    "O microfone não está enviando áudio. Se for um fone Bluetooth, desconecte e conecte de novo, ou use " +
    "\"Automático\" em Configurações → Geral → Microfone para gravar pelo microfone do notebook.";
  setError(message);
  notify("Microfone sem áudio", message);
}

/** One parecord process; keeps its audio and a live level for the floating bar. */
function spawnCapture(device, latencyMs = 20) {
  const cap = { proc: null, chunks: [], bytes: 0, firstAt: 0 };
  cap.proc = spawn("parecord", recordArgs(device, latencyMs), { stdio: ["ignore", "pipe", "ignore"] });
  cap.proc.on("error", () => {});
  cap.proc.stdout.on("data", (d) => {
    if (!cap.bytes) cap.firstAt = Date.now();
    cap.chunks.push(d);
    cap.bytes += d.length;
    // the bar follows the chosen mic, or the backup while the chosen one is silent
    if (cap !== primary && primary?.bytes > 0) return;
    let peak = 0;
    for (let i = 0; i + 1 < d.length; i += 2) peak = Math.max(peak, Math.abs(d.readInt16LE(i)));
    currentLevel = Math.max(currentLevel * 0.6, Math.min(1, peak / 12000));
  });
  return cap;
}

function stopCapture(cap) {
  return new Promise((resolve) => {
    if (!cap || cap.proc.exitCode !== null) return resolve();
    cap.proc.on("exit", () => resolve());
    setTimeout(() => cap.proc.kill("SIGTERM"), 120); // let parecord flush the last buffer
  });
}

/** Stops both captures and returns the audio worth transcribing. */
async function endRecorder() {
  clearTimeout(maxTimer);
  clearTimeout(silenceTimer);
  clearInterval(levelTimer);
  const [p, b] = [primary, backup];
  primary = backup = null;
  await Promise.all([stopCapture(p), stopCapture(b)]);
  if (!p) return Buffer.alloc(0);
  // A Bluetooth mic that started late (mode switch) or delivered too little lost words: use the backup.
  const expected = ((Date.now() - recordingStartedAt) / 1000) * SAMPLE_RATE * 2;
  const primaryOk = p.bytes >= expected * 0.8 && p.firstAt - recordingStartedAt < 600;
  const startMs = (cap) => (cap?.firstAt ? cap.firstAt - recordingStartedAt : -1);
  console.log(
    `[mic] esperado=${Math.round(expected)}B principal=${p.bytes}B (início +${startMs(p)}ms)` +
      (b ? ` reserva=${b.bytes}B (início +${startMs(b)}ms)` : "") +
      ` → ${b && !primaryOk && b.bytes > p.bytes * 0.8 ? "reserva" : "principal"}`,
  );
  if (b && !primaryOk && b.bytes > p.bytes * 0.8) {
    if (!usedBackupNotice) {
      usedBackupNotice = true;
      notify("Microfone Bluetooth não respondeu", "Usei o microfone do notebook nesta gravação. Para evitar isso, escolha \"Automático\" em Configurações → Geral → Microfone.");
    }
    return Buffer.concat(b.chunks);
  }
  return Buffer.concat(p.chunks);
}

function resetToIdle() {
  Object.assign(state, { phase: "idle", mode: null, locked: false, step: null });
  activeKeys = [];
  broadcast();
}

async function cancelRecording() {
  await endRecorder();
  resetToIdle();
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function stopRecording() {
  if (state.phase !== "recording") return;
  // Releasing Ctrl and Super fires two key-ups; leave "recording" before awaiting, or both stop it
  // and the second, empty run resets the bar to idle while the real dictation is still processing.
  state.phase = "processing";
  const duration = Date.now() - recordingStartedAt;
  const mode = state.mode;
  // claimed before the first await, so Esc can cancel the task while it is still being transcribed
  const job = mode === "agent" ? (agentJob = { cancelled: false, cancel: null, decide: null }) : null;
  const recorded = await endRecorder();
  playSound("stop");
  if (duration < MIN_RECORDING_MS) return resetToIdle();
  Object.assign(state, { phase: "processing", step: "transcribing" });
  broadcast();
  logStep(`stop mode=${mode} locked=${state.locked} audio=${Math.round(duration / 1000)}s`, startedInOwnWindow ? "from=own-window" : "");
  // DRONSIO_TEST_WAV replaces the microphone audio (16 kHz mono WAV) for testing.
  const pcm = process.env.DRONSIO_TEST_WAV
    ? fs.readFileSync(process.env.DRONSIO_TEST_WAV).subarray(44)
    : recorded;
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(TMP_DIR, `rec-${Date.now()}.wav`);
  fs.writeFileSync(file, wavFromPcm(pcm), { mode: 0o600 });
  try {
    // Without the LLM, Whisper itself can translate to English.
    const task = mode === "dictation" && settings.ai.translateTo === "en" && !useLlmFormatting() ? "translate" : "transcribe";
    // DRONSIO_TEST_AGENT_TEXT replaces the transcription of an agent-mode recording, for testing.
    const testText = mode === "agent" && process.env.DRONSIO_TEST_AGENT_TEXT;
    const result = testText ? { text: testText, ms: 0 } : await transcribe([file], { task });
    const raw = result.text.trim();
    logStep(`transcribed ${raw.length} chars in ${((result.ms || 0) / 1000).toFixed(1)}s`);
    if (!raw) return;
    if (mode === "command") await handleCommand(raw, duration);
    else if (mode === "agent") await handleAgent(raw, duration, job);
    else await handleDictation(raw, duration, result.ms, mode === "note", result.language);
  } catch (e) {
    logStep(`failed: ${e.message}`);
    setError(`Falha na transcrição: ${e.message}`);
  } finally {
    fs.rm(file, { force: true }, () => {});
    if (job && agentJob === job) agentJob = null;
    resetToIdle();
  }
}

async function formatDictation(raw, whisperLanguage) {
  let fixed = text.applyDictionary(raw, settings.dictionary);
  if (settings.ai.removeFillers) fixed = text.removeFillers(fixed); // instant, works without the LLM
  const technical = settings.ai.style === "technical" && useLlmFormatting();
  if (technical) fixed = text.spokenPaths(fixed);
  const snippet = text.exactSnippet(fixed, settings.snippets);
  if (snippet !== null) return snippet;
  let out = fixed;
  if (useLlmFormatting()) {
    state.step = "formatting";
    broadcast();
    try {
      // What the user actually spoke: the words themselves when clear, else Whisper's detection.
      const spoken = text.guessLanguage(fixed) || whisperLanguage || expectedLanguage();
      const t = Date.now();
      const rewritten = await llm.generate(settings.ai.model, formattingPrompt(spoken), llm.formattingUserPrompt(fixed, spoken), { timeoutMs: 60000 });
      logStep(`formatted in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      const outLanguage = rewritten && text.guessLanguage(rewritten);
      if (!settings.ai.translateTo && outLanguage && outLanguage !== spoken && ["pt", "en"].includes(spoken)) {
        // Safety net: the model translated without being asked; keep the user's own words.
        logStep(`formatting discarded: IA respondeu em ${outLanguage} para um ditado em ${spoken}`);
      } else {
        out = rewritten || fixed;
      }
    } catch (e) {
      logStep(`formatting failed: ${e.message}`);
      setError(`IA indisponível, usei o texto sem formatação (${e.message}).`);
    }
  }
  if (technical) out = text.fileMentions(out); // done here, not by the LLM, so paths are never invented
  return text.expandSnippets(out, settings.snippets);
}

function addHistory(entry) {
  history.unshift({ at: new Date().toISOString(), ...entry });
  history = history.slice(0, 1000);
  writeJson(FILES.history, history);
}

async function handleDictation(raw, durationMs, processingMs, asNote, language) {
  const final = await formatDictation(raw, language);
  if (!final) return;
  if (asNote) {
    notes.unshift({ id: newId(), at: new Date().toISOString(), text: final });
    writeJson(FILES.notes, notes);
    notify("Nota salva", final.slice(0, 120));
  } else {
    await pasteOrCopy(final, { returnFocus: !startedInOwnWindow });
  }
  addHistory({ text: final, raw, durationMs, processingMs, kind: asNote ? "note" : "dictation" });
}

async function handleCommand(instruction, durationMs) {
  const selection = (await selectionPromise) || "";
  selectionPromise = null;
  if (!aiReady()) {
    setError("O modo comando precisa da IA (Ollama). Ative em Estilo e IA.");
    return;
  }
  state.step = "formatting";
  broadcast();
  try {
    const out = selection
      ? await llm.generate(settings.ai.model, llm.COMMAND_WITH_SELECTION, `INSTRUÇÃO: ${instruction}\n\nTEXTO SELECIONADO:\n${selection}`, { timeoutMs: 90000 })
      : await llm.generate(settings.ai.model, llm.COMMAND_WITHOUT_SELECTION, instruction, { timeoutMs: 90000 });
    if (!out) return;
    await pasteOrCopy(out, { returnFocus: !startedInOwnWindow });
    addHistory({ text: out, raw: instruction, durationMs, kind: "command", selection: selection.slice(0, 2000) });
  } catch (e) {
    setError(`Falha no modo comando: ${e.message}`);
  } finally {
    warmFormatting();
  }
}

// ---------------------------------------------------------------------------
// Agent mode: the spoken task goes to Claude Code (lib/agent.js), sensitive actions need a confirmation
// ---------------------------------------------------------------------------

let agentJob = null; // task in progress: { cancelled, cancel() of the running claude, decide(ok) while confirming }

function refreshAgentBin() {
  state.agent.bin = agent.findClaude(settings.agent.bin.trim());
}

function agentProblem() {
  refreshAgentBin();
  // enabled null (default): on whenever the binary is there, so a missing one is reported as such
  if (settings.agent.enabled === false) return "O modo agente está desligado. Ative em Configurações → IA.";
  if (state.agent.bin) return null;
  return settings.agent.bin.trim()
    ? `Não encontrei o Claude Code em ${settings.agent.bin.trim()}. Corrija o caminho em Configurações → IA.`
    : "O modo agente precisa do Claude Code instalado (claude.com/claude-code). Instale ou informe o caminho em Configurações → IA.";
}

function reportAgentProblem() {
  const problem = agentProblem();
  logStep(`agent unavailable: ${problem}`);
  setError(problem);
  notify("Modo agente indisponível", problem);
}

function cancelAgent() {
  if (!agentJob || agentJob.cancelled) return;
  logStep("agent cancel requested");
  agentJob.cancelled = true;
  agentJob.cancel?.();
  agentJob.decide?.(false);
}

/** Brings the window up with Confirmar/Cancelar; resolves true only if the user confirmed. */
function askConfirmation(job, action, timeoutMs) {
  return new Promise((resolve) => {
    const decide = (ok) => {
      clearTimeout(timer);
      job.decide = null;
      state.agent.action = null;
      resolve(ok);
    };
    const timer = setTimeout(() => decide(false), timeoutMs);
    job.decide = decide;
    state.step = "confirm";
    state.agent.action = action;
    broadcast();
    showMainWindow();
    notify("Agente: confirme a ação", action);
  });
}

async function handleAgent(instruction, durationMs, job) {
  if (job.cancelled) return;
  if (agentProblem()) return reportAgentProblem();
  const timeoutMs = Math.min(120, Math.max(1, Number(settings.agent.timeoutMin) || 10)) * 60000;
  const startedAt = Date.now();
  let sessionId = null;
  logStep(`agent start chars=${instruction.length} bin=${state.agent.bin}`);
  try {
    for (;;) {
      state.step = "agent";
      broadcast();
      const turn = agent.run({
        bin: state.agent.bin,
        prompt: instruction,
        sessionId,
        timeoutMs,
        onEvent: (e) => {
          if (e.type === "system" && e.subtype === "init") logStep(`agent session ${e.session_id}`);
          for (const c of e.type === "assistant" ? e.message?.content || [] : []) if (c.type === "tool_use") logStep(`agent tool ${c.name}`);
        },
      });
      job.cancel = turn.cancel;
      const out = await turn.promise;
      job.cancel = null;
      sessionId = out.sessionId;
      if (out.isError) throw new Error(out.result || "o Claude Code devolveu um erro");
      const action = agent.confirmationRequest(out.result);
      if (!action) {
        const answer = out.result.trim() || "Tarefa concluída.";
        logStep(`agent done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s chars=${answer.length}`);
        notify("Agente", answer.slice(0, 300));
        addHistory({ text: answer, raw: instruction, durationMs, processingMs: Date.now() - startedAt, kind: "agent" });
        return;
      }
      if (!sessionId) throw new Error("o Claude Code não informou a sessão para continuar");
      logStep("agent waiting for confirmation");
      if (!(await askConfirmation(job, action, timeoutMs))) {
        logStep("agent action declined");
        notify("Agente", `Cancelado, nada foi feito: ${action}`.slice(0, 300));
        return;
      }
      logStep("agent action confirmed");
    }
  } catch (e) {
    if (e.cancelled || job.cancelled) {
      logStep("agent cancelled");
      return flash("Agente cancelado");
    }
    logStep(`agent failed: ${e.message}`);
    setError(`Falha no modo agente: ${e.message}`);
    notify("Falha no modo agente", e.message);
  }
}

async function runPolish(presetId) {
  const preset = settings.polishPresets.find((p) => p.id === presetId);
  if (!preset) return;
  if (!aiReady()) return setError("O Polish precisa da IA (Ollama). Ative em Estilo e IA.");
  const fromOwnWindow = Boolean(mainWindow?.isFocused());
  const selection = await readSelection();
  if (!selection.trim()) {
    notify("Polish", "Selecione um texto antes de usar o atalho.");
    return;
  }
  Object.assign(state, { phase: "processing", mode: "command", step: "formatting" });
  broadcast();
  try {
    const system = `${preset.prompt}\nDevolva somente o texto reescrito, sem aspas e sem explicações.`;
    const out = await llm.generate(settings.ai.model, system, selection, { timeoutMs: 90000 });
    if (out) {
      await pasteOrCopy(out, { returnFocus: !fromOwnWindow });
      addHistory({ text: out, raw: selection.slice(0, 2000), kind: "polish", preset: preset.name });
    }
  } catch (e) {
    setError(`Falha no Polish: ${e.message}`);
  } finally {
    resetToIdle();
    warmFormatting();
  }
}

// ---------------------------------------------------------------------------
// Meeting recorder: microphone + system audio, transcript and summary
// ---------------------------------------------------------------------------

let meetingProcs = [];
let meetingFiles = [];
let meetingTimer = null;

function startMeeting() {
  if (state.meeting.recording || state.meeting.processing) return;
  if (state.model.state !== "ready") return setError("O modelo de voz ainda não está pronto.");
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  const devices = [chooseMicrophone().device || null];
  if (settings.meetingSystemAudio) devices.push("@DEFAULT_MONITOR@");
  meetingFiles = [];
  meetingProcs = devices.map((device, i) => {
    const file = path.join(TMP_DIR, `meeting-${stamp}-${i}.raw`);
    meetingFiles.push(file);
    const p = spawn("parecord", recordArgs(device, 100), { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.pipe(fs.createWriteStream(file, { mode: 0o600 }));
    p.on("error", (e) => setError(`Falha ao gravar a reunião: ${e.message}`));
    return p;
  });
  state.meeting = { recording: true, startedAt: stamp, processing: false, progress: 0, step: null };
  meetingTimer = setTimeout(stopMeeting, MAX_MEETING_MS);
  broadcast();
}

async function stopMeeting() {
  if (!state.meeting.recording) return;
  clearTimeout(meetingTimer);
  const startedAt = state.meeting.startedAt;
  await Promise.all(
    meetingProcs.map(
      (p) =>
        new Promise((resolve) => {
          if (p.exitCode !== null) return resolve();
          p.on("close", resolve);
          p.kill("SIGTERM");
        }),
    ),
  );
  meetingProcs = [];
  const files = meetingFiles.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
  state.meeting = { recording: false, startedAt, processing: true, progress: 0, step: "transcribing" };
  broadcast();
  const when = new Date(startedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const meeting = { id: newId(), at: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, title: `Reunião de ${when}`, transcript: "", summary: "" };
  try {
    if (!files.length) throw new Error("nenhum áudio gravado");
    const result = await transcribe(files, {
      progress: (p) => {
        state.meeting.progress = p;
        broadcast();
      },
    });
    meeting.transcript = result.text;
    if (meeting.transcript && aiReady()) {
      Object.assign(state.meeting, { progress: 1, step: "summary" });
      broadcast();
      meeting.summary = await llm
        .generate(settings.ai.model, llm.MEETING_SUMMARY, meeting.transcript.slice(0, 40000), { timeoutMs: 600000, numCtx: 16384 })
        .catch(() => "");
    }
    meetings.unshift(meeting);
    writeJson(FILES.meetings, meetings);
    notify("Reunião transcrita", meeting.title);
  } catch (e) {
    setError(`Falha ao transcrever a reunião: ${e.message}`);
  } finally {
    for (const f of meetingFiles) fs.rm(f, { force: true }, () => {});
    meetingFiles = [];
    state.meeting = { recording: false, startedAt: 0, processing: false, progress: 0, step: null };
    broadcast();
    warmFormatting();
  }
}

// ---------------------------------------------------------------------------
// System integration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Microphone choice
// ---------------------------------------------------------------------------
// Bluetooth headsets only have a mic in their low-quality "headset" mode, and every app that opens
// that mic (a WhatsApp call, the browser, DronsioFlow) makes Linux switch the headset between its
// music and headset modes. Those switches are where the voice link stalls. "auto" therefore prefers
// a wired mic (USB, then the laptop's), leaving the headset in music mode for everyone else.

const PACTL_ENV = { ...process.env, LC_ALL: "C" }; // stable, non-localized pactl output
let sources = []; // [{ name, label, bus, available }]
let defaultSource = "";
let micWatcher = null;

function pactl(args) {
  return new Promise((resolve) =>
    execFile("pactl", args, { timeout: 4000, env: PACTL_ENV }, (err, stdout) => resolve(err ? null : stdout)),
  );
}

async function refreshSources() {
  const [list, def] = await Promise.all([pactl(["-f", "json", "list", "sources"]), pactl(["get-default-source"])]);
  try {
    if (list) {
      sources = JSON.parse(list)
        .filter((s) => !s.name.endsWith(".monitor"))
        .map((s) => ({
          name: s.name,
          label: s.description || s.name,
          bus: s.properties?.["device.bus"] || "",
          available: !(s.ports || []).length || s.ports.some((port) => port.availability !== "not available"),
        }));
    }
  } catch {}
  if (def) defaultSource = def.trim();
  const before = JSON.stringify(state.mic);
  state.mic = chooseMicrophone();
  if (JSON.stringify(state.mic) !== before) broadcast();
  return sources;
}

const wiredRank = (s) => (s.bus === "usb" ? 0 : /digital|internal|interno/i.test(s.label) ? 1 : 2);

function bestWired() {
  return sources.filter((s) => s.bus !== "bluetooth" && s.available).sort((a, b) => wiredRank(a) - wiredRank(b))[0] || null;
}

/** The mic a recording should use now: { device, label, bluetooth }. */
function chooseMicrophone() {
  const describe = (s) => ({ device: s.name, label: s.label, bluetooth: s.bus === "bluetooth" });
  const pick = settings.microphone;
  if (pick === "bluetooth") {
    // headset mic when one is connected (a wired mic records in parallel as backup), else wired
    const headset = sources.find((s) => s.bus === "bluetooth" && s.available);
    if (headset) return describe(headset);
  } else if (pick && pick !== "auto") {
    const chosen = sources.find((s) => s.name === pick);
    if (chosen) return describe(chosen);
    // the chosen mic is gone (headset turned off): behave like "auto"
  }
  if (pick === "") {
    const def = sources.find((s) => s.name === defaultSource);
    return def ? { ...describe(def), device: "" } : { device: "", label: "Padrão do sistema", bluetooth: false };
  }
  const wired = bestWired();
  return wired ? describe(wired) : { device: "", label: "Padrão do sistema", bluetooth: false };
}

/** Follows devices being plugged, connected or switched (pactl subscribe). */
function watchMicrophones() {
  micWatcher = spawn("pactl", ["subscribe"], { env: PACTL_ENV, stdio: ["ignore", "pipe", "ignore"] });
  let timer = null;
  micWatcher.stdout.on("data", (d) => {
    if (!/on (source|card|server)/.test(d.toString())) return;
    clearTimeout(timer);
    timer = setTimeout(refreshSources, 300);
  });
  micWatcher.on("error", () => {});
  micWatcher.on("exit", () => {
    if (!quitting) setTimeout(watchMicrophones, 3000);
  });
}

const AUTOSTART_FILE = path.join(os.homedir(), ".config", "autostart", "dronsioflow.desktop");

function applyAutostart() {
  if (settings.autostart) {
    const launcher = process.env.DRONSIO_LAUNCHER || path.join(path.dirname(process.execPath), "dronsioflow.sh");
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    fs.writeFileSync(
      AUTOSTART_FILE,
      `[Desktop Entry]\nType=Application\nName=DronsioFlow\nExec=${launcher} --hidden\nIcon=dronsioflow\nX-GNOME-Autostart-enabled=true\n`,
    );
  } else {
    fs.rmSync(AUTOSTART_FILE, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const ICON = path.join(__dirname, "assets", "icon.png");
const WEB_PREFS = { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true };

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: "DronsioFlow",
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f5f4f0",
    webPreferences: WEB_PREFS,
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) mainWindow.show();
  });
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide(); // dictation keeps running in the background
    }
  });
  mainWindow.on("focus", () => {
    refreshOllama();
    refreshAgentBin();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 240,
    height: 72,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false, // on X11 this also keeps it above other windows, outside the WM
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: WEB_PREFS,
  });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.loadFile(path.join(__dirname, "ui", "overlay.html"));
}

let overlayPhase = null;

function placeOverlay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [w, h] = overlayWindow.getSize();
  overlayWindow.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height - h - 8));
}

/** The bar stays as a small idle pill (always visible, unobtrusive) and grows while recording. */
function updateOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const visible = state.phase !== "idle" || state.meeting.recording || settings.showIdleBar || Boolean(state.flash);
  if (!visible) {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    overlayPhase = null;
    return;
  }
  // follow the screen with the mouse pointer whenever a recording starts
  if (!overlayWindow.isVisible() || (state.phase === "recording" && overlayPhase !== "recording")) placeOverlay();
  if (!overlayWindow.isVisible()) overlayWindow.showInactive();
  overlayPhase = state.phase;
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
    tray.setToolTip("DronsioFlow");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Abrir DronsioFlow", click: showMainWindow },
        { type: "separator" },
        { label: "Sair", click: () => app.quit() },
      ]),
    );
    tray.on("click", showMainWindow);
  } catch {
    tray = null; // no tray support on this desktop
  }
}

// ---------------------------------------------------------------------------
// IPC with the UI
// ---------------------------------------------------------------------------

ipcMain.handle("get-state", () => snapshot());

ipcMain.handle("set-settings", (_e, patch) => {
  const before = settings;
  settings = mergeDefaults({ ...settings, ...patch });
  saveSettings();
  if (patch.model && patch.model !== before.model) loadModel();
  if ("autostart" in patch) applyAutostart();
  if ("theme" in patch) nativeTheme.themeSource = settings.theme;
  if ("microphone" in patch) state.mic = chooseMicrophone();
  if (patch.ai || patch.dictionary) warmFormatting();
  if (patch.agent) refreshAgentBin();
  broadcast();
  return settings;
});

ipcMain.handle("reset-shortcuts", () => {
  settings.shortcuts = { ...DEFAULT_SETTINGS.shortcuts };
  saveSettings();
  broadcast();
});

ipcMain.handle("clear-shortcut", (_e, name) => {
  if (name.startsWith("polish:")) {
    const preset = settings.polishPresets.find((p) => `polish:${p.id}` === name);
    if (preset) preset.shortcut = [];
  } else {
    settings.shortcuts[name] = [];
  }
  saveSettings();
  broadcast();
});

ipcMain.handle("capture-shortcut", (_e, name) => {
  if (state.phase !== "idle") return;
  state.capture = name;
  captureKeys = new Set();
  broadcast();
});

ipcMain.handle("cancel-capture", () => {
  state.capture = null;
  broadcast();
});

ipcMain.handle("copy", (_e, content) => clipboard.writeText(content));

ipcMain.handle("delete-history", (_e, at) => {
  history = at ? history.filter((h) => h.at !== at) : [];
  writeJson(FILES.history, history);
  broadcast();
});

ipcMain.handle("save-note", (_e, note) => {
  let existing = note.id && notes.find((n) => n.id === note.id);
  if (existing) {
    if (existing.text === note.text) return existing.id;
    Object.assign(existing, { text: note.text, updatedAt: new Date().toISOString() });
  } else {
    existing = { id: newId(), at: new Date().toISOString(), text: note.text || "" };
    notes.unshift(existing);
  }
  writeJson(FILES.notes, notes);
  broadcast();
  return existing.id;
});

ipcMain.handle("delete-note", (_e, id) => {
  notes = notes.filter((n) => n.id !== id);
  writeJson(FILES.notes, notes);
  broadcast();
});

ipcMain.handle("agent-confirm", (_e, ok) => agentJob?.decide?.(Boolean(ok)));
ipcMain.handle("cancel-agent", () => cancelAgent());

ipcMain.handle("start-meeting", () => startMeeting());
ipcMain.handle("stop-meeting", () => stopMeeting());
ipcMain.handle("delete-meeting", (_e, id) => {
  meetings = meetings.filter((m) => m.id !== id);
  writeJson(FILES.meetings, meetings);
  broadcast();
});

ipcMain.handle("list-microphones", async () => (await refreshSources()).map((s) => ({ name: s.name, label: s.label, bus: s.bus })));
ipcMain.handle("refresh-ollama", () => refreshOllama());
ipcMain.handle("retry-model", () => loadModel());
ipcMain.handle("dismiss-error", () => setError(null));
ipcMain.handle("open-folder", () => shell.openPath(DATA_DIR));
ipcMain.handle("quit", () => app.quit());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let quitting = false;

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    quitting = true;
    app.quit();
  });
}

app.on("second-instance", showMainWindow);
app.on("before-quit", () => {
  quitting = true;
  cancelAgent();
  for (const cap of [primary, backup]) cap?.proc.kill("SIGTERM");
  micWatcher?.kill("SIGTERM");
  for (const p of meetingProcs) p.kill("SIGTERM");
  inputHelper?.send({ cmd: "quit" });
  engine?.send({ cmd: "quit" });
});
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(async () => {
  nativeTheme.themeSource = settings.theme;
  refreshAgentBin();
  createMainWindow();
  createOverlayWindow();
  createTray();
  startInputHelper();
  startEngine();
  refreshSources();
  watchMicrophones();
  loadModel();
  await refreshOllama();
  warmFormatting();
});
