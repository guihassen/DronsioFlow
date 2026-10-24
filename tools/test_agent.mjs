// Dev tool: checks the agent mode helpers (app/lib/agent.js) with a fake `claude` binary.
// Usage: node tools/test_agent.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = createRequire(import.meta.url)("../app/lib/agent.js");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("stream parser joins lines split across chunks and skips junk", () => {
  const events = [];
  const feed = agent.streamParser((e) => events.push(e));
  feed('{"type":"system","session_id":"s1"}\n{"type":"res');
  feed('ult","result":"ok"}\n\nnot json\n');
  assert.deepEqual(events, [{ type: "system", session_id: "s1" }, { type: "result", result: "ok" }]);
});

test("detects CONFIRMAR lines", () => {
  assert.equal(agent.confirmationRequest('CONFIRMAR: enviar "Oi" para Amanda no WhatsApp'), 'enviar "Oi" para Amanda no WhatsApp');
  assert.equal(agent.confirmationRequest("**CONFIRMAR:** criar o arquivo /tmp/x.txt**"), "criar o arquivo /tmp/x.txt");
  assert.equal(agent.confirmationRequest("Preparei tudo.\nconfirmar: apagar a pasta X"), "apagar a pasta X");
  assert.equal(agent.confirmationRequest("O título é Example Domain."), null);
  assert.equal(agent.confirmationRequest("Não precisei confirmar: era só leitura."), null);
  assert.equal(agent.confirmationRequest("CONFIRMAR:   "), null);
  assert.equal(agent.confirmationRequest(""), null);
});

test("args: instruction after --, resume continues the session", () => {
  const a = agent.buildArgs({ prompt: "--help; rm -rf ~" });
  assert.equal(a[0], "-p");
  assert.deepEqual(a.slice(-2), ["--", "--help; rm -rf ~"]);
  for (const f of ["--chrome", "--verbose", "--append-system-prompt", "--permission-mode", "--allowedTools"]) assert(a.includes(f), f);
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert(!a.some((x) => x.includes("dangerously")));
  const r = agent.buildArgs({ prompt: "ignored", sessionId: "abc" });
  assert.equal(r[r.indexOf("--resume") + 1], "abc");
  assert.deepEqual(r.slice(-2), ["--", agent.CONFIRMED_PROMPT]);
});

const dir = mkdtempSync(join(tmpdir(), "dronsio-agent-test-"));
// Fake claude: prints its argv as the result, or sleeps when the prompt says so.
const fake = join(dir, "claude");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: resume || "sess-1" }));
if (prompt === "sleep") setTimeout(() => {}, 60000);
else if (prompt === "fail") { console.error("Not logged in"); process.exit(1); }
else console.log(JSON.stringify({ type: "result", is_error: false, session_id: resume || "sess-1", result: resume ? "feito" : "CONFIRMAR: " + prompt }));
`,
);
chmodSync(fake, 0o755);

test("findClaude: configured path, PATH, missing", () => {
  assert.equal(agent.findClaude(fake), fake);
  assert.equal(agent.findClaude(join(dir, "nope")), null);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  assert.equal(agent.findClaude(""), fake);
  process.env.PATH = path;
});

test("run: result, session id and resume", async () => {
  const first = await agent.run({ bin: fake, prompt: 'criar "a b"; $(whoami)', timeoutMs: 5000 }).promise;
  assert.equal(first.sessionId, "sess-1");
  assert.equal(agent.confirmationRequest(first.result), 'criar "a b"; $(whoami)'); // no shell expansion
  const second = await agent.run({ bin: fake, prompt: "x", sessionId: first.sessionId, timeoutMs: 5000 }).promise;
  assert.deepEqual([second.sessionId, second.result], ["sess-1", "feito"]);
});

test("run: cancel, timeout, failure and missing binary", async () => {
  const t = agent.run({ bin: fake, prompt: "sleep", timeoutMs: 5000 });
  setTimeout(t.cancel, 200);
  await assert.rejects(t.promise, (e) => e.cancelled === true);
  await assert.rejects(agent.run({ bin: fake, prompt: "sleep", timeoutMs: 300 }).promise, /tempo esgotado/);
  await assert.rejects(agent.run({ bin: fake, prompt: "fail", timeoutMs: 5000 }).promise, /Not logged in/);
  await assert.rejects(agent.run({ bin: join(dir, "nope"), prompt: "x", timeoutMs: 5000 }).promise, /ENOENT/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
