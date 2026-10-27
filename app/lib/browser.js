// Agent mode in the browser: the DronsioFlow extension (app/extension) connects here over a local
// WebSocket and acts in the user's real tabs; the agent reaches it through an MCP server
// (native/browser_mcp.js) that asks the app over a private Unix socket. Pure Node: no Electron here.
const crypto = require("crypto");
const http = require("http");

const SERVER_NAME = "dronsio_browser";
const PREFIX = `mcp__${SERVER_NAME}__`;
const DEFAULT_PORT = 47615;
// v2: the token never travels; both sides prove they hold it (see proof()). v1 sent it in the clear.
const PROTOCOL = "dronsio.v2";
const NONCE = /^[a-f0-9]{64}$/;
const ORIGIN = /^(moz-extension|chrome-extension):\/\/[a-z0-9-]{8,64}$/i;
const MAX_MESSAGE = 32 * 1024 * 1024; // screenshots and uploads stay well below
const CALL_TIMEOUT_MS = 60 * 1000;
const NOT_CONNECTED =
  "Conecte a extensão do DronsioFlow no seu navegador (Configurações → IA → Navegador) e tente de novo.";

const tab = { tabId: { type: "number", description: "Tab id from tabs_list. Default: the tab used last by the agent, else the active tab." } };
const ref = { ref: { type: "string", description: "Element reference from read_page or find (e.g. ref_12)." } };
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

// readOnly: only looks or moves between pages; the rest changes something in a page and goes
// through the same policy as before (lib/agent.js).
const TOOLS = [
  { name: "tabs_list", readOnly: true, description: "List the open tabs of the user's browser (id, window, title, url, active).", inputSchema: schema() },
  { name: "tab_create", readOnly: true, description: "Open a new tab (optionally at an http/https URL) and make it the agent's tab.", inputSchema: schema({ url: { type: "string" } }) },
  { name: "tab_select", readOnly: true, description: "Bring a tab to the front and make it the agent's tab.", inputSchema: schema({ tabId: tab.tabId }, ["tabId"]) },
  { name: "navigate", readOnly: true, description: 'Load an http/https URL in a tab, or "back" / "forward". Waits for the page to load.', inputSchema: schema({ url: { type: "string" }, ...tab }, ["url"]) },
  {
    name: "read_page",
    readOnly: true,
    description: "Page structure as an indented list: roles, names and refs of links, buttons, fields and headings, plus text. Use the refs with click, type, form_input, scroll.",
    inputSchema: schema({ filter: { type: "string", enum: ["all", "interactive"], description: "interactive: only elements that can be used. Default all." }, ...tab }),
  },
  { name: "get_page_text", readOnly: true, description: "The visible text of the page (title, URL and body text).", inputSchema: schema(tab) },
  { name: "find", readOnly: true, description: "Find elements by words in their label, text or placeholder (e.g. \"campo de mensagem\", \"botão enviar\"). Returns refs.", inputSchema: schema({ query: { type: "string" }, ...tab }, ["query"]) },
  { name: "screenshot", readOnly: true, description: "Screenshot of the visible part of a tab (brings it to the front). Image pixels are CSS pixels unless a scale is reported.", inputSchema: schema(tab) },
  {
    name: "click",
    description: "Click an element (ref) or a point (coordinate in CSS pixels from the screenshot).",
    inputSchema: schema({ ...ref, coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, button: { type: "string", enum: ["left", "right", "double"] }, ...tab }),
  },
  { name: "type", description: "Type text into an element (ref) or the focused one, at the cursor. To replace, first key \"ctrl+a\".", inputSchema: schema({ text: { type: "string" }, ...ref, ...tab }, ["text"]) },
  { name: "key", description: 'Press keys on the focused element, space-separated: "Enter", "Tab", "Escape", "Backspace", "ctrl+a", "shift+Enter"…', inputSchema: schema({ keys: { type: "string" }, ...tab }, ["keys"]) },
  {
    name: "scroll",
    description: "Scroll the page or the area of an element; without a direction, scrolls the element (ref) into view.",
    inputSchema: schema({ direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", description: "Screens to scroll. Default 0.8." }, ...ref, ...tab }),
  },
  { name: "form_input", description: "Set the value of a field (text, select, checkbox, radio) by ref.", inputSchema: schema({ ...ref, value: { type: ["string", "number", "boolean"] }, ...tab }, ["ref", "value"]) },
  { name: "tab_close", description: "Close a tab.", inputSchema: schema({ tabId: tab.tabId }, ["tabId"]) },
  {
    name: "file_upload",
    description: "Attach files from this computer (absolute paths) to a file field (ref).",
    inputSchema: schema({ paths: { type: "array", items: { type: "string" } }, ...ref, ...tab }, ["paths", "ref"]),
  },
  { name: "javascript", description: "Run JavaScript in the page and return the value of the last expression. Always shown to the user first.", inputSchema: schema({ code: { type: "string" }, ...tab }, ["code"]) },
];
const TOOL_NAMES = TOOLS.map((t) => t.name);
// tools that act in one tab: a confirmed call is tied to the tab and site the user saw (see expect in call())
const TAB_TOOLS = TOOLS.filter((t) => "tabId" in t.inputSchema.properties).map((t) => t.name);
const READ_ONLY = TOOLS.filter((t) => t.readOnly).map((t) => t.name);

/** JSON with sorted keys: the same call always gives the same text, whatever the key order. */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** What ties a call the hook allowed to the call that reaches the extension. */
const callKey = (tool, args) => `${tool} ${stableStringify(args || {})}`;

/**
 * The browser calls the PreToolUse hook allowed in this task. allow() when the hook lets a call
 * through, with `site` ({ tabId, origin }) when the user confirmed it on that site; take() when the
 * call reaches the bridge: the approval ({ site }) once per allowed call, within `ttlMs`, else null.
 */
function approvals(ttlMs = 2 * 60 * 1000) {
  let list = [];
  return {
    allow: (name, input, site = null) => list.push({ key: callKey(name, input), at: Date.now(), site }),
    take: (name, args) => {
      list = list.filter((a) => Date.now() - a.at < ttlMs);
      const i = list.findIndex((a) => a.key === callKey(name, args));
      if (i < 0) return null;
      const [a] = list.splice(i, 1);
      return { site: a.site };
    },
  };
}

const newToken = () => crypto.randomBytes(24).toString("hex");
const pairingCode = (port, token) => `DF1-${port}-${token}`;

/** What one side sends to show it holds the token, without sending it: HMAC over both nonces. */
const proof = (token, side, serverNonce, clientNonce) => crypto.createHmac("sha256", String(token)).update(`dronsio:${side}:${serverNonce}:${clientNonce}`).digest("hex");

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Why a WebSocket upgrade is refused ({ status, reason }), or null to accept it. The pairing code is
 * checked after the upgrade, by the challenge (createBrowserLink).
 */
function checkUpgrade(req, { port }) {
  if (req.method !== "GET" || req.url !== "/") return { status: 404, reason: "caminho" };
  if (String(req.headers.upgrade).toLowerCase() !== "websocket" || !req.headers["sec-websocket-key"]) return { status: 400, reason: "não é WebSocket" };
  // a web page (DNS rebinding included) never gets past these two: only an extension, only here
  if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host)) return { status: 403, reason: `host ${req.headers.host}` };
  if (!ORIGIN.test(req.headers.origin || "")) return { status: 403, reason: `origem ${req.headers.origin || "ausente"}` };
  const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  if (!protocols.includes(PROTOCOL)) return { status: 426, reason: protocols.includes("dronsio.v1") ? "versão antiga da extensão" : "protocolo" };
  return null;
}

/** A WebSocket frame from the server (never masked). */
function frame(opcode, payload) {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext);
  head[0] = 0x80 | opcode;
  head[1] = ext === 0 ? len : ext === 2 ? 126 : 127;
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([head, payload]);
}

/** Minimal RFC 6455 connection over an upgraded socket: text messages, ping/pong, close. */
function wsConnection(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const close = (code = 1000) => {
    if (closed) return;
    closed = true;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    socket.end(frame(0x8, p));
    setTimeout(() => socket.destroy(), 1000).unref();
    onClose();
  };
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (!masked || len > MAX_MESSAGE) return close(1002); // clients must mask
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(at + 4 + len);
      if (opcode === 0x8) return close();
      if (opcode === 0x9) socket.write(frame(0xa, payload));
      else if (opcode === 0x1 || opcode === 0x0) {
        parts.push(payload);
        if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return close(1009);
        if (fin) {
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          onMessage(text);
        }
      }
    }
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  });
  socket.on("error", () => {});
  return { send: (obj) => !closed && socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))), close };
}

/**
 * The WebSocket server the extension connects to, on 127.0.0.1 only. Pairing is mutual: the server
 * sends a nonce (challenge), the extension answers with its own nonce and proof("client"), the server
 * answers with proof("server"). Only then the extension takes calls, so a program that grabbed the port
 * learns nothing and runs nothing. One browser at a time: a new connection replaces the old one. onChange(status) on every connect/disconnect; log(...) for the
 * dictation log. Returns { start(), stop(), setToken(), status(), call(tool, args) }.
 */
function createBrowserLink({ port = DEFAULT_PORT, token, onChange = () => {}, log = () => {} }) {
  let server = null;
  let conn = null; // { ws, browser, version, socket }
  let error = null;
  let seq = 0;
  let pingTimer = null;
  let lastSeen = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }

  const status = () => ({ connected: Boolean(conn), browser: conn?.browser || null, version: conn?.version || null, port, error });
  const failPending = (why) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(id);
    }
  };
  const drop = (c, why) => {
    if (conn !== c) return;
    conn = null;
    failPending(why);
    log(`browser extension disconnected (${why})`);
    onChange(status());
  };

  function onUpgrade(req, socket) {
    const refused = checkUpgrade(req, { port });
    if (refused) {
      log(`browser connection refused: ${refused.reason}`);
      socket.end(`HTTP/1.1 ${refused.status} ${http.STATUS_CODES[refused.status]}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${PROTOCOL}\r\n\r\n`);
    socket.setNoDelay(true);
    const c = { socket, browser: null, version: null, nonce: crypto.randomBytes(32).toString("hex") };
    c.ws = wsConnection(
      socket,
      (text) => {
        lastSeen = Date.now();
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === "hello" && !c.browser) {
          const clientNonce = String(msg.nonce || "");
          if (!NONCE.test(clientNonce) || !sameToken(String(msg.proof || ""), proof(token, "client", c.nonce, clientNonce))) {
            log(`browser connection refused: código de pareamento não confere (origem ${req.headers.origin})`);
            return c.ws.close(4004);
          }
          c.ws.send({ type: "welcome", proof: proof(token, "server", c.nonce, clientNonce) });
          c.browser = String(msg.browser || "Navegador").slice(0, 60);
          c.version = String(msg.version || "").slice(0, 20);
          if (conn && conn !== c) conn.ws.close(4000); // the newest browser takes over
          conn = c;
          log(`browser extension connected: ${c.browser} (extension ${c.version}) origin=${req.headers.origin}`);
          onChange(status());
        } else if (msg.type === "result" && conn === c && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result || {});
          else p.reject(new Error(String(msg.error || "a extensão devolveu um erro")));
        }
      },
      () => drop(c, "conexão fechada"),
    );
    c.ws.send({ type: "challenge", nonce: c.nonce });
    setTimeout(() => c.browser || c.ws.close(4003), 10000).unref(); // no valid answer to the challenge
  }

  const start = () =>
    new Promise((resolve) => {
      server = http.createServer((_req, res) => res.writeHead(426).end());
      server.on("upgrade", onUpgrade);
      server.on("error", (e) => {
        error = e.code === "EADDRINUSE" ? `a porta ${port} já está em uso` : e.message;
        log(`browser link failed: ${error}`);
        onChange(status());
        resolve(false);
      });
      server.listen(port, "127.0.0.1", () => {
        error = null;
        log(`browser link listening on 127.0.0.1:${port}`);
        // the extension answers with a pong: keeps a Chromium service worker awake, finds dead links
        pingTimer = setInterval(() => {
          if (!conn) return;
          if (Date.now() - lastSeen > 65000) return conn.ws.close(4001);
          conn.ws.send({ type: "ping" });
        }, 20000);
        pingTimer.unref?.();
        resolve(true);
      });
    });

  const stop = () => {
    clearInterval(pingTimer);
    conn?.ws.close(1001);
    conn = null;
    failPending("DronsioFlow encerrado");
    server?.close();
    server = null;
  };

  /** A new code: the browser paired with the old one is disconnected and must pair again. */
  const setToken = (t) => {
    token = t;
    const c = conn;
    if (c) {
      drop(c, "código de pareamento trocado");
      c.ws.close(4002);
    }
  };

  /**
   * Runs one tool in the browser; resolves with { text, image? }. With `expect` ({ tabId, origin }) the
   * extension runs it only in that tab and only while it still shows that site.
   */
  const call = (tool, args, { expect = null, timeoutMs = CALL_TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      if (!conn) return reject(new Error(NOT_CONNECTED));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`o navegador não respondeu em ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      conn.ws.send({ type: "call", id, tool, args: args || {}, ...(expect && { expect }) });
    });

  return { start, stop, setToken, status, call };
}

module.exports = {
  SERVER_NAME,
  PREFIX,
  DEFAULT_PORT,
  PROTOCOL,
  NOT_CONNECTED,
  TOOLS,
  TOOL_NAMES,
  TAB_TOOLS,
  READ_ONLY,
  stableStringify,
  callKey,
  approvals,
  newToken,
  pairingCode,
  proof,
  checkUpgrade,
  createBrowserLink,
};
