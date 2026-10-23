// Dev tool: screenshots / evaluates JS in an Electron page through the Chrome DevTools Protocol.
// Usage: node cdp_shot.mjs <port> <titleOrUrlPart> <out.png> [jsToRunFirst] [waitMs]
import { writeFileSync } from "node:fs";

const [port, match, out, js, waitMs = "800"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && (t.title.includes(match) || t.url.includes(match)));
if (!target) throw new Error(`no page matching ${match}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

if (js) {
  const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
  if (r.result?.result?.value !== undefined) console.log(JSON.stringify(r.result.result.value, null, 1));
  if (r.result?.exceptionDetails) console.error(r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description);
}
await new Promise((r) => setTimeout(r, Number(waitMs)));
if (out !== "-") {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("saved", out);
}
ws.close();
