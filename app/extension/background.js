// Background of the DronsioFlow extension (one code for Firefox and Chromium). It keeps a WebSocket to
// the DronsioFlow app on this computer (127.0.0.1 only) and runs the agent's browser tools in the
// user's tabs. Both sides prove they hold the pairing code without sending it, and no call runs before
// the app proved it: whatever else listens on the port gets nothing. The app decides what may run.
const api = globalThis.browser ?? globalThis.chrome;
const VERSION = api.runtime.getManifest().version;
const CODE = /^DF1-(\d{2,5})-([a-f0-9]{32,128})$/i;
const NOT_PAIRED = "Cole o código de pareamento do DronsioFlow (Configurações → IA → Navegador).";
const NO_LINK = "Sem conexão com o DronsioFlow. Confira se ele está aberto e se o código colado é o atual.";
const BAD_CODE = "O código colado não confere com o do DronsioFlow. Cole o código atual (Configurações → IA → Navegador).";
const NOT_APP = "O programa nesta porta não provou ser o DronsioFlow; nada foi executado. Tentando de novo…";
const PROTOCOL = "dronsio.v2";
const HANDSHAKE_MS = 10000;

let ws = null;
let state = { status: "unpaired", error: null, browser: null }; // unpaired | connecting | connected | paused
let retryDelay = 1000;
let retryTimer = null;
let agentTab = null; // the tab the agent used last: the default target of the tools

function setState(patch) {
  state = { ...state, ...patch };
  api.runtime.sendMessage({ type: "state", state }).catch(() => {}); // no popup open
}

async function browserName() {
  try {
    if (api.runtime.getBrowserInfo) {
      const info = await api.runtime.getBrowserInfo();
      return `${info.name} ${String(info.version).split(".")[0]}`;
    }
  } catch {}
  const brand = navigator.userAgentData?.brands?.find((b) => !/chromium|brand/i.test(b.brand));
  return brand ? `${brand.brand} ${brand.version}` : "Chromium";
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Same as proof() in lib/browser.js: HMAC-SHA256 of both nonces, keyed by the pairing token. */
async function proof(token, side, serverNonce, clientNonce) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`dronsio:${side}:${serverNonce}:${clientNonce}`)));
}

/** Compares in constant time, so the answer's timing doesn't tell how much of a proof was right. */
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(retryTimer);
  const { code, paused } = await api.storage.local.get(["code", "paused"]);
  const m = CODE.exec(code || "");
  if (!m) return setState({ status: "unpaired", error: NOT_PAIRED });
  if (paused) return setState({ status: "paused", error: paused });
  if (ws && ws.readyState <= WebSocket.OPEN) return; // another connect() got here first
  setState({ status: "connecting" });
  const sock = new WebSocket(`ws://127.0.0.1:${m[1]}/`, [PROTOCOL]);
  // authed only after the app's proof; until then the only messages read are challenge and welcome
  Object.assign(sock, { token: m[2].toLowerCase(), authed: false, expected: null, failure: null });
  ws = sock;
  sock.onopen = () => setTimeout(() => sock.authed || sock.close(), HANDSHAKE_MS);
  sock.onmessage = (e) => onMessage(sock, e.data);
  sock.onclose = async (e) => {
    if (ws !== sock) return;
    ws = null;
    // the app replaced this browser or the code: stop, or two browsers would keep taking turns
    const stop = { 4000: "Outro navegador se conectou ao DronsioFlow. Clique em Conectar para voltar a usar este.", 4002: "O código de pareamento foi trocado no DronsioFlow. Cole o novo código." }[sock.authed && e.code];
    if (stop) {
      await api.storage.local.set({ paused: stop });
      return setState({ status: "paused", error: stop });
    }
    const why = sock.failure || (e.code === 4004 ? BAD_CODE : sock.authed ? "A conexão com o DronsioFlow caiu. Tentando de novo…" : NO_LINK);
    setState({ status: "connecting", error: why });
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };
}

async function onMessage(sock, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (!sock.authed) return handshake(sock, msg);
  if (msg.type === "ping") {
    // WebSocket traffic alone doesn't count as activity for Firefox: an extension API call does,
    // so the background stays alive (and connected) while the app is there
    api.runtime.getPlatformInfo();
    return sock.send(JSON.stringify({ type: "pong" }));
  }
  if (msg.type !== "call" || ws !== sock) return;
  let reply;
  try {
    reply = { type: "result", id: msg.id, ok: true, result: await runTool(msg.tool, msg.args || {}, msg.expect || null) };
  } catch (e) {
    reply = { type: "result", id: msg.id, ok: false, error: String(e?.message || e) };
  }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

/**
 * The app's challenge (a nonce) gets this extension's nonce and proof; the app's welcome must carry
 * the matching proof. Anything else before that (a call above all) closes the connection.
 */
async function handshake(sock, msg) {
  const fail = (why) => {
    sock.failure = why;
    sock.close();
  };
  if (msg.type === "challenge" && !sock.expected && /^[a-f0-9]{64}$/.test(String(msg.nonce))) {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    sock.expected = proof(sock.token, "server", msg.nonce, nonce);
    const mine = await proof(sock.token, "client", msg.nonce, nonce);
    const name = await browserName();
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "hello", nonce, proof: mine, browser: name, version: VERSION }));
    return;
  }
  if (msg.type === "welcome" && sock.expected) {
    if (!sameText(String(msg.proof), await sock.expected)) return fail(NOT_APP);
    sock.authed = true;
    retryDelay = 1000;
    return setState({ status: "connected", error: null, browser: await browserName() });
  }
  fail(NOT_APP);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function webUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`Endereço inválido: ${url}. Use um endereço completo, como https://exemplo.com.`);
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("A extensão só abre páginas http ou https.");
  return u.href;
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
};
const CHANGED = "A aba mudou de site desde que o usuário confirmou; a ação foi cancelada. Peça de novo.";

/** The tab a confirmed call was tied to, refused if it is gone or no longer shows the same site. */
async function expectedTab(expect) {
  const t = await api.tabs.get(Number(expect.tabId)).catch(() => null);
  if (!t) throw new Error(`A aba ${expect.tabId} confirmada pelo usuário não existe mais.`);
  if (originOf(t.url) !== expect.origin) throw new Error(CHANGED);
  agentTab = t.id;
  return t;
}

async function targetTab(tabId) {
  if (tabId != null) {
    const t = await api.tabs.get(Number(tabId)).catch(() => null);
    if (!t) throw new Error(`A aba ${tabId} não existe mais; veja tabs_list.`);
    agentTab = t.id;
    return t;
  }
  if (agentTab != null) {
    const t = await api.tabs.get(agentTab).catch(() => null);
    if (t) return t;
  }
  const [t] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("Nenhuma aba aberta.");
  agentTab = t.id;
  return t;
}

/** Resolves once the tab loads (a "loading" then "complete"), or soon if nothing starts loading. */
function waitLoaded(tabId, ms = 20000) {
  return new Promise((resolve) => {
    let loading = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idle);
      api.tabs.onUpdated.removeListener(on);
      resolve();
    };
    const on = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") loading = true;
      if (info.status === "complete" && loading) finish();
    };
    const timer = setTimeout(finish, ms);
    const idle = setTimeout(() => loading || finish(), 3000); // same-page change: nothing loads
    api.tabs.onUpdated.addListener(on);
  });
}

const tabLine = (t) => `[${t.id}]${t.active ? " (ativa)" : ""}${t.id === agentTab ? " (do agente)" : ""} ${t.title || "(sem título)"} — ${t.url || ""}`;

async function loadedText(tabId) {
  const t = await api.tabs.get(tabId);
  agentTab = t.id;
  return { text: `Aba ${t.id}: ${t.title || "(sem título)"} — ${t.url}` };
}

/**
 * Runs one action of page.js in the tab; it answers { ok } or { error }. With `origin`, the page itself
 * refuses if it is no longer that site (checked in the same step that acts).
 */
async function inPage(tab, tool, args, origin = null) {
  let r;
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["page.js"] });
    [r] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (tool, args, origin, changed) => (origin && location.origin !== origin ? { error: changed } : globalThis.__dronsioRun(tool, args)),
      args: [tool, args, origin, CHANGED],
    });
  } catch (e) {
    throw new Error(`O navegador não deixa a extensão ler ou agir nesta página (${tab.url}): ${e.message}. Abra um site comum ou confira a permissão de acesso aos sites da extensão.`);
  }
  const out = r?.result;
  if (!out) throw new Error("A página não respondeu.");
  if (out.error) throw new Error(out.error);
  return out.ok;
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const MAX_SHOT_WIDTH = 1400;

/** The visible part of the tab, resized to CSS pixels (so its coordinates work with click). */
async function screenshot(tab, origin) {
  if (!tab.active) {
    await api.tabs.update(tab.id, { active: true });
    await sleep(400);
  }
  const view = await inPage(tab, "viewport", {}, origin);
  const shot = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = Math.min(1, MAX_SHOT_WIDTH / view.width);
  const canvas = new OffscreenCanvas(Math.round(view.width * scale), Math.round(view.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  const note = scale < 1 ? ` Imagem reduzida: multiplique as coordenadas da imagem por ${(1 / scale).toFixed(3)} para usar em click.` : "";
  return {
    text: `Aba ${tab.id}: ${tab.title} — ${tab.url}. Janela de ${view.width}×${view.height} pixels CSS, rolada em (${view.scrollX}, ${view.scrollY}).${note}`,
    image: { data: base64(await blob.arrayBuffer()), mimeType: "image/jpeg" },
  };
}

/** JavaScript in the page's own world; the page's security policy may block it. */
async function runJavaScript(tab, code, origin) {
  let r;
  try {
    [r] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (code, origin, changed) => {
        if (origin && location.origin !== origin) return { error: changed };
        try {
          let v = (0, eval)(code);
          if (v && typeof v.then === "function") v = await v;
          let text;
          try {
            text = v === undefined ? "undefined" : typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? String(v));
          } catch {
            text = String(v);
          }
          return { ok: text.slice(0, 20000) };
        } catch (e) {
          return { error: `${e?.name || "Erro"}: ${e?.message || e}` };
        }
      },
      args: [code, origin, CHANGED],
    });
  } catch (e) {
    throw new Error(`O navegador não deixa a extensão rodar código nesta página (${tab.url}): ${e.message}`);
  }
  const out = r?.result;
  if (!out) throw new Error("A página não respondeu.");
  if (out.error) throw new Error(/EvalError|Content Security|unsafe-eval/i.test(out.error) ? `A página bloqueia JavaScript de fora (política de segurança do site): ${out.error}` : out.error);
  return { text: out.ok };
}

/**
 * Runs one tool. `expect` ({ tabId, origin }) comes with a call the user confirmed: it runs only in
 * that tab, and only while it still shows that site.
 */
async function runTool(tool, args, expect = null) {
  const origin = expect ? String(expect.origin) : null;
  const pick = (tabId) => (expect ? expectedTab(expect) : targetTab(tabId));
  switch (tool) {
    case "tab_info": {
      // what the confirmation dialog shows, and what the confirmed call is then tied to
      const t = await targetTab(args.tabId);
      return { tabId: t.id, title: t.title || "", url: t.url || "", origin: originOf(t.url) };
    }
    case "tabs_list": {
      const tabs = await api.tabs.query({});
      return { text: tabs.map(tabLine).join("\n") || "Nenhuma aba aberta." };
    }
    case "tab_create": {
      const url = args.url ? webUrl(args.url) : null;
      const t = await api.tabs.create({ active: true });
      agentTab = t.id;
      if (url) {
        const loaded = waitLoaded(t.id);
        await api.tabs.update(t.id, { url });
        await loaded;
      }
      return loadedText(t.id);
    }
    case "tab_select": {
      const t = await pick(args.tabId);
      await api.tabs.update(t.id, { active: true });
      await api.windows.update(t.windowId, { focused: true }).catch(() => {});
      return loadedText(t.id);
    }
    case "tab_close": {
      const t = await pick(args.tabId);
      await api.tabs.remove(t.id);
      if (agentTab === t.id) agentTab = null;
      return { text: `Aba ${t.id} fechada.` };
    }
    case "navigate": {
      const t = await pick(args.tabId);
      const loaded = waitLoaded(t.id);
      if (args.url === "back" || args.url === "forward") {
        // tabs.goBack sometimes finds no history in Chromium where the page's own history works
        const back = args.url === "back";
        await (back ? api.tabs.goBack(t.id) : api.tabs.goForward(t.id)).catch(() =>
          api.scripting.executeScript({ target: { tabId: t.id }, func: (b) => (b ? history.back() : history.forward()), args: [back] }),
        );
      } else await api.tabs.update(t.id, { url: webUrl(args.url) });
      await loaded;
      return loadedText(t.id);
    }
    case "screenshot":
      return screenshot(await pick(args.tabId), origin);
    case "javascript":
      return runJavaScript(await pick(args.tabId), String(args.code ?? ""), origin);
    case "read_page":
    case "get_page_text":
    case "find":
    case "click":
    case "type":
    case "key":
    case "scroll":
    case "form_input":
    case "file_upload": {
      const t = await pick(args.tabId);
      const text = await inPage(t, tool, args, origin);
      if (tool === "click" || tool === "key") await sleep(300); // let the page react before the next look
      return { text };
    }
    default:
      throw new Error(`Ferramenta desconhecida: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Popup and lifecycle
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL("popup.html"))) return; // only the popup
  if (msg.type === "getState") {
    sendResponse(state);
  } else if (msg.type === "pair") {
    const code = String(msg.code || "").trim();
    if (!CODE.test(code)) {
      sendResponse({ ...state, error: "Código inválido. Copie o código inteiro em Configurações → IA → Navegador." });
      return;
    }
    ws?.close();
    ws = null;
    api.storage.local.set({ code, paused: null }).then(connect).then(() => sendResponse(state));
    return true;
  } else if (msg.type === "reconnect") {
    ws?.close();
    ws = null;
    api.storage.local.set({ paused: null }).then(connect).then(() => sendResponse(state));
    return true;
  } else if (msg.type === "forget") {
    ws?.close();
    ws = null;
    api.storage.local.remove(["code", "paused"]).then(() => {
      setState({ status: "unpaired", error: NOT_PAIRED, browser: null });
      sendResponse(state);
    });
    return true;
  }
});

// Firefox ends an idle background page and Chromium an idle service worker: the app's pings keep it
// busy while connected, and the alarm wakes it up to reconnect when the app comes back.
api.alarms.create("reconnect", { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => connect());
api.runtime.onStartup.addListener(() => connect());
connect();
