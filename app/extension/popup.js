// Popup of the DronsioFlow extension: pairing code, connection status and the sites permission.
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const LABELS = { connected: "Conectada ao DronsioFlow", connecting: "Conectando…", paused: "Pausada", unpaired: "Não pareada" };

function show(state) {
  if (!state) return;
  $("status").className = `status ${state.status}`;
  $("label").textContent = LABELS[state.status] || state.status;
  $("detail").textContent = state.status === "connected" ? `O agente do DronsioFlow pode usar este navegador (${state.browser}).` : state.error || "";
  $("reconnect").hidden = state.status !== "paused";
  $("forget").hidden = state.status === "unpaired";
}

const ask = (msg) => api.runtime.sendMessage(msg).then(show);

async function checkPermission() {
  const ok = await api.permissions.contains({ origins: ["<all_urls>"] });
  $("perm").hidden = ok;
}

$("pair").addEventListener("click", () => ask({ type: "pair", code: $("code").value }));
$("code").addEventListener("keydown", (e) => e.key === "Enter" && ask({ type: "pair", code: $("code").value }));
$("reconnect").addEventListener("click", () => ask({ type: "reconnect" }));
$("forget").addEventListener("click", () => {
  $("code").value = "";
  ask({ type: "forget" });
});
$("grant").addEventListener("click", () => api.permissions.request({ origins: ["<all_urls>"] }).then(checkPermission));
api.runtime.onMessage.addListener((msg) => msg.type === "state" && show(msg.state));

ask({ type: "getState" });
checkPermission();
