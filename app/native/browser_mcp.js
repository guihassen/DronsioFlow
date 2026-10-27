// MCP server (stdio) with the browser tools of the agent mode, started by `claude` through
// --mcp-config (lib/agent.js). It holds no power of its own: each call goes to the DronsioFlow app
// over the Unix socket given as the first argument, and the app only runs calls the PreToolUse hook
// allowed, in the browser where the DronsioFlow extension is connected.
const net = require("net");
const { TOOLS, SERVER_NAME } = require("../lib/browser");

const socketPath = process.argv[2];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

/** Asks the app to run one tool; resolves with { ok, text, image, error }. */
function bridge(tool, args) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (reply) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(reply);
    };
    const sock = net.connect(socketPath);
    sock.on("connect", () => sock.write(JSON.stringify({ tool, args }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, i)));
      } catch {
        finish({ ok: false, error: "resposta inválida do DronsioFlow" });
      }
    });
    sock.on("error", (e) => finish({ ok: false, error: `DronsioFlow indisponível (${e.code || e.message})` }));
    sock.on("close", () => finish({ ok: false, error: "o DronsioFlow fechou a conexão" }));
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      id,
      result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: "1.0.0" } },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) return send({ id, result: { content: [{ type: "text", text: `Ferramenta desconhecida: ${name}` }], isError: true } });
    const reply = await bridge(name, params.arguments || {});
    if (!reply.ok) return send({ id, result: { content: [{ type: "text", text: String(reply.error || "falhou") }], isError: true } });
    const content = [{ type: "text", text: String(reply.text ?? "") }];
    if (reply.image?.data) content.push({ type: "image", data: reply.image.data, mimeType: reply.image.mimeType || "image/jpeg" });
    return send({ id, result: { content } });
  }
  // notifications (no id) need no answer; unknown requests get the standard error
  if (id !== undefined && id !== null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    handle(msg).catch((e) => msg.id != null && send({ id: msg.id, error: { code: -32603, message: e.message } }));
  }
});
process.stdin.on("end", () => process.exit(0));
