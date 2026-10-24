// Dev tool: checks the agent mode helpers (app/lib/agent.js) with a fake `claude` binary.
// Usage: node tools/test_agent.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("args: only read-only tools pre-approved, user settings ignored, hook installed", () => {
  const a = agent.buildArgs({ prompt: "x", hookSocket: "/tmp/d it's/hook.sock" });
  assert.equal(a[a.indexOf("--permission-mode") + 1], "default");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  const allowed = a[a.indexOf("--allowedTools") + 1].split(",");
  for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__claude-in-chrome", "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__form_input", "mcp__claude-in-chrome__javascript_tool"])
    assert(!allowed.includes(t), t);
  for (const t of ["Read", "Grep", "WebFetch", "mcp__claude-in-chrome__read_page", "mcp__claude-in-chrome__navigate"]) assert(allowed.includes(t), t);
  const hook = JSON.parse(a[a.indexOf("--settings") + 1]).hooks.PreToolUse[0];
  const matcher = new RegExp(hook.matcher);
  for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__new_tool"]) assert(matcher.test(t), t);
  assert(!matcher.test("Read") && !matcher.test("BashOutput"));
  assert(hook.hooks[0].timeout * 1000 >= agent.CONFIRM_TIMEOUT_MS);
  assert(hook.hooks[0].command.endsWith(`'/tmp/d it'\\''s/hook.sock'`), hook.hooks[0].command); // quoted for the shell
  // no hook (socket missing): nothing that changes things gets through
  assert(!agent.buildArgs({ prompt: "x" }).includes("--settings"));
});

test("policy: reading passes, changing anything needs the user", () => {
  const P = agent.toolPolicy;
  assert.equal(P("Read", {}), "allow");
  assert.equal(P("mcp__claude-in-chrome__get_page_text", {}), "allow");
  assert.equal(P("mcp__claude-in-chrome__computer", { action: "screenshot" }), "allow");
  for (const action of ["left_click", "type", "key", "scroll", "anything_new"]) assert.equal(P("mcp__claude-in-chrome__computer", { action }), "confirm", action);
  for (const t of ["Bash", "Write", "Edit", "NotebookEdit", "mcp__claude-in-chrome__form_input", "mcp__claude-in-chrome__javascript_tool", "mcp__claude-in-chrome__browser_batch", "mcp__claude-in-chrome__future_tool", "Task"])
    assert.equal(P(t, {}), "confirm", t);
});

test("dialog shows the real call, not the model's description", () => {
  const bash = agent.describeToolCall("Bash", { command: "rm -rf ~/x", description: "limpar arquivos temporários" });
  assert.equal(bash.detail, "rm -rf ~/x");
  assert(!JSON.stringify(bash).includes("temporários"));
  const write = agent.describeToolCall("Write", { file_path: "/tmp/a.txt", content: "ok".repeat(2000) });
  assert(write.detail.startsWith("/tmp/a.txt\n\nokok") && write.detail.includes("mais 2500 caracteres"));
  const edit = agent.describeToolCall("Edit", { file_path: "/tmp/b", old_string: "a", new_string: "b" });
  assert(edit.detail.includes("/tmp/b") && edit.detail.includes("Trocar:\na") && edit.detail.includes("Por:\nb"));
  const click = agent.describeToolCall("mcp__claude-in-chrome__computer", { action: "left_click", coordinate: [10, 20], tabId: 3 });
  assert.equal(click.title, "Clicar no Chrome");
  assert.equal(click.detail, "action: left_click\ncoordinate: [10,20]");
  assert(agent.describeToolCall("mcp__claude-in-chrome__computer", { action: "type", text: "Oi Amanda" }).detail.includes("Oi Amanda"));
  assert.equal(agent.describeToolCall("mcp__claude-in-chrome__javascript_tool", { action: "javascript_exec", text: "document.forms[0].submit()" }).detail, "document.forms[0].submit()");
});

const dir = mkdtempSync(join(tmpdir(), "dronsio-agent-test-"));
// Fake claude: answers "CONFIRMAR: <prompt>" (then "feito" on resume), sleeps, fails, or, like the
// real one, runs the PreToolUse hook from --settings before a Bash call and only runs it if allowed.
const fake = join(dir, "claude");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const prompt = args.at(-1);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const say = (o) => console.log(JSON.stringify({ session_id: resume || "sess-1", ...o }));
const result = (r) => say({ type: "result", is_error: false, result: r });
say({ type: "system", subtype: "init" });
if (prompt === "sleep") setTimeout(() => {}, 60000);
else if (prompt === "fail") { console.error("Not logged in"); process.exit(1); }
else if (prompt.startsWith("group:")) {
  // ignores SIGTERM, like its child: only the SIGKILL of the whole group stops them
  process.on("SIGTERM", () => {});
  const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(prompt.slice(6), String(c.pid));
  setInterval(() => {}, 1000);
} else if (prompt.startsWith("bash:")) {
  const command = "touch " + prompt.slice(5);
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  const i = args.indexOf("--settings");
  const hook = i >= 0 && JSON.parse(args[i + 1]).hooks.PreToolUse.find((h) => new RegExp(h.matcher).test("Bash"));
  let decision = "deny";
  if (hook) {
    const out = spawnSync("sh", ["-c", hook.hooks[0].command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) });
    decision = JSON.parse(out.stdout).hookSpecificOutput.permissionDecision;
  }
  if (decision === "allow") execSync(command);
  result(decision === "allow" ? "feito" : "negado");
}
else result(resume ? "feito" : "CONFIRMAR: " + prompt);
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

test("hook: blocks the Bash call until the app answers; Cancelar denies, Confirmar allows", async () => {
  for (const ok of [false, true]) {
    const marker = join(dir, `ran-${ok}`);
    let asked = null;
    let answer;
    const server = await agent.permissionServer((call) => {
      asked = call;
      return new Promise((r) => (answer = r));
    });
    try {
      const dirMode = statSync(join(server.socketPath, "..")).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(statSync(server.socketPath).mode & 0o777, 0o600);
      const turn = agent.run({ bin: fake, prompt: `bash:${marker}`, hookSocket: server.socketPath, timeoutMs: 10000 });
      let finished = false;
      turn.promise.finally(() => (finished = true)).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(asked, { tool_name: "Bash", tool_input: { command: `touch ${marker}` } });
      assert(!finished && !existsSync(marker), "ran before the user answered");
      answer(ok);
      assert.equal((await turn.promise).result, ok ? "feito" : "negado");
      assert.equal(existsSync(marker), ok);
    } finally {
      server.close();
    }
  }
});

test("hook: fails closed without the app, with a bad answer or bad input", async () => {
  const hookCmd = (socket) => JSON.parse(agent.buildArgs({ prompt: "x", hookSocket: socket }).find((a) => a.startsWith('{"hooks"'))).hooks.PreToolUse[0].hooks[0].command;
  const call = JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" } });
  // async: the socket server lives in this same process
  const decision = (cmd, args, input) =>
    new Promise((resolve) => {
      const p = spawn(cmd, args);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(JSON.parse(out).hookSpecificOutput.permissionDecision));
      p.stdin.end(input);
    });
  const decide = (socket, input = call) => decision("sh", ["-c", hookCmd(socket)], input);
  assert.equal(await decide(join(dir, "no-such.sock")), "deny");
  assert.equal(await decision(process.execPath, [new URL("../app/native/agent_hook.js", import.meta.url).pathname], call), "deny"); // no socket given
  const server = await agent.permissionServer(async () => "yes"); // anything but true is a no
  try {
    assert.equal(await decide(server.socketPath), "deny");
    assert.equal(await decide(server.socketPath, "not json"), "deny");
  } finally {
    server.close();
  }
  assert(!existsSync(server.socketPath), "socket directory removed");
  const allow = await agent.permissionServer(async () => true);
  try {
    assert.equal(await decide(allow.socketPath), "allow");
  } finally {
    allow.close();
  }
});

test("cancel as claude delivers its answer: rejected as cancelled, no answer to keep", async () => {
  let t;
  t = agent.run({ bin: fake, prompt: "x", timeoutMs: 5000, onEvent: (e) => e.type === "result" && t.cancel() });
  await assert.rejects(t.promise, (e) => e.cancelled === true);
  // after the exit, cancel is a no-op (main.js checks job.cancelled after the await instead)
  const done = agent.run({ bin: fake, prompt: "x", timeoutMs: 5000 });
  await done.promise;
  done.cancel();
});

const alive = (pid) => {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); // a zombie is dead
  } catch {
    return false;
  }
};

test("timeout and cancel kill the whole process group, SIGKILL after SIGTERM", async () => {
  for (const how of ["timeout", "cancel"]) {
    const pidFile = join(dir, `child-${how}`);
    const t = agent.run({ bin: fake, prompt: `group:${pidFile}`, timeoutMs: how === "timeout" ? 500 : 60000 });
    if (how === "cancel") setTimeout(t.cancel, 500);
    const started = Date.now();
    await assert.rejects(t.promise, how === "timeout" ? /tempo esgotado/ : (e) => e.cancelled === true);
    assert(Date.now() - started >= 3000, "claude ignores SIGTERM: only the SIGKILL ends it");
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert(!alive(pid), `child ${pid} survived the ${how}`);
  }
});

test("hold pauses the timeout while the user decides", async () => {
  const t = agent.run({ bin: fake, prompt: "sleep", timeoutMs: 400 });
  const release = t.hold();
  await new Promise((r) => setTimeout(r, 700));
  release();
  release(); // twice is harmless
  const started = Date.now();
  await assert.rejects(t.promise, /tempo esgotado/);
  assert(Date.now() - started >= 150, "the time spent on hold did not count");
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
