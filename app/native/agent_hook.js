// PreToolUse hook of the agent mode (installed by lib/agent.js through `claude --settings`).
// Claude Code passes the tool call on stdin; this asks the DronsioFlow app over the Unix socket given
// as the first argument and waits for the user's answer. Anything but an explicit "allow" denies,
// including a missing socket, a closed connection or a malformed answer (fail closed).
const net = require("net");

const DENIED =
  "O usuário não autorizou esta ação no DronsioFlow. Não tente fazê-la de outro jeito; termine dizendo o que não foi feito.";

let answered = false;
function answer(allow, reason) {
  if (answered) return;
  answered = true;
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allow ? "allow" : "deny", permissionDecisionReason: reason } };
  process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
}

function ask(call) {
  let sock;
  try {
    sock = net.connect(process.argv[2]);
  } catch (e) {
    return answer(false, `DronsioFlow indisponível (${e.message}). ${DENIED}`);
  }
  let buf = "";
  sock.on("connect", () => sock.write(JSON.stringify({ tool_name: call.tool_name, tool_input: call.tool_input }) + "\n"));
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    const i = buf.indexOf("\n");
    if (i < 0) return;
    let reply = null;
    try {
      reply = JSON.parse(buf.slice(0, i));
    } catch {}
    sock.destroy();
    if (reply?.allow === true) answer(true, "Confirmado pelo usuário no DronsioFlow.");
    else answer(false, DENIED);
  });
  sock.on("error", (e) => answer(false, `DronsioFlow indisponível (${e.code || e.message}). ${DENIED}`));
  sock.on("close", () => answer(false, DENIED));
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let call = null;
  try {
    call = JSON.parse(input);
  } catch {}
  if (!call?.tool_name) return answer(false, DENIED);
  ask(call);
});
