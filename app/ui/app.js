const api = window.dronsio;
const $ = (sel) => document.querySelector(sel);

let S = null; // last state snapshot from the main process
const ui = {
  page: "home",
  collapsed: false,
  modal: null, // settings | help | addWord | addSnippet
  settingsTab: "general",
  search: {}, // page -> query
  searchOpen: {},
  note: null, // id of the note open in the editor
  meeting: null, // id of the meeting open
  pendingRender: false,
};

try {
  ui.collapsed = localStorage.getItem("sidebar-collapsed") === "1";
} catch {}

// ---- helpers ------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function keysHtml(codes, { soft = false } = {}) {
  if (!codes?.length) return `<span class="muted">Sem atalho</span>`;
  const cls = soft ? "kbd-soft" : "kbd";
  return `<span class="keys">${sortKeys(codes).map((c) => `<span class="${cls}">${esc(keyLabel(c))}</span>`).join('<span class="plus">+</span>')}</span>`;
}

const keysText = (codes) => (codes?.length ? sortKeys(codes).map(keyLabel).join(" + ") : "sem atalho");

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

const timeLabel = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
const matchesSearch = (page, ...fields) => {
  const q = (ui.search[page] || "").trim().toLowerCase();
  return !q || fields.some((f) => String(f || "").toLowerCase().includes(q));
};

function toast(msg) {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (root.innerHTML = ""), 1800);
}

const dismissed = (id) => (S.settings.dismissed || []).includes(id);
const heroClose = (id) => `<button class="icon-btn close" data-act="dismiss" data-arg="${id}" title="Fechar">${icon("close", 14)}</button>`;

function searchTools(page) {
  return ui.searchOpen[page]
    ? `<input class="search-input" data-search="${page}" placeholder="Buscar…" value="${esc(ui.search[page] || "")}" autofocus />`
    : `<button class="icon-btn small" data-act="open-search" data-arg="${page}" title="Buscar">${icon("search", 17)}</button>`;
}

const sw = (checked, attrs) => `<input type="checkbox" class="switch" ${checked ? "checked" : ""} ${attrs} />`;

// ---- shell ------------------------------------------------------------------------

const NAV = [
  ["home", "mic", "Ditado"],
  ["meetings", "record", "Reuniões"],
  ["insights", "chart", "Estatísticas"],
  ["dictionary", "book", "Dicionário"],
  ["snippets", "scissors", "Snippets"],
  ["style", "type", "Estilo"],
  ["transforms", "wand", "Transformações"],
  ["notes", "note", "Notas"],
];

function statusLines() {
  const { state, settings } = S;
  const m = state.model;
  let voice = ["ok", "Voz pronta"];
  if (state.phase === "recording") voice = ["active", "Gravando…"];
  else if (state.phase === "processing") voice = ["active", state.step === "formatting" ? "Formatando…" : "Transcrevendo…"];
  else if (m.state === "downloading") voice = ["wait", `Baixando modelo ${Math.round((m.progress || 0) * 100)}%`];
  else if (m.state === "loading") voice = ["wait", "Carregando modelo…"];
  else if (m.state === "error") voice = ["bad", "Erro no modelo de voz"];
  else if (m.state !== "ready") voice = ["wait", "Iniciando…"];
  const aiOn = settings.ai.enabled && state.ollama.available && settings.ai.model;
  const ai = !settings.ai.enabled ? ["wait", "IA desligada"] : aiOn ? ["ok", "IA pronta"] : ["bad", "IA indisponível"];
  const inputOk = state.input.keyboards > 0 && state.input.uinput;
  const input = inputOk ? ["ok", "Atalhos e colagem ok"] : ["bad", "Sem acesso ao teclado"];
  return [voice, ai, input].map(([tone, label]) => `<div class="status-line"><span class="dot ${tone}"></span>${esc(label)}</div>`).join("");
}

function renderShell() {
  $("#app").classList.toggle("collapsed", ui.collapsed);
  $("#toggle-sidebar").innerHTML = icon("sidebar", 20);
  $("#toggle-theme").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon", 20);
  $("#open-help").innerHTML = icon("help", 20);
  $("#sidebar").innerHTML = `
    <div class="brand">${LOGO_SVG}<span>DronsioFlow</span><span class="badge">Local</span></div>
    <nav class="nav">
      ${NAV.map(([id, ic, label]) => `<button class="nav-item ${ui.page === id ? "active" : ""}" data-act="nav" data-arg="${id}" title="${label}">${icon(ic, 19)}<span>${label}</span>${id === "meetings" && S.state.meeting.recording ? '<span class="rec-dot" style="margin-left:auto"></span>' : ""}</button>`).join("")}
    </nav>
    <div class="side-spacer"></div>
    <div class="side-card">
      <h4>Grátis, no seu computador</h4>
      <p>Sem conta e sem limite. Seu áudio nunca sai desta máquina.</p>
      ${statusLines()}
    </div>
    <div class="side-sep"></div>
    <button class="nav-item" data-act="modal" data-arg="settings" title="Configurações">${icon("settings", 19)}<span>Configurações</span></button>
    <button class="nav-item" data-act="modal" data-arg="help" title="Ajuda">${icon("help", 19)}<span>Ajuda</span></button>`;

  const { state } = S;
  const m = state.model;
  const inputOk = state.input.keyboards > 0 && state.input.uinput;
  const err =
    state.lastError ||
    (m.state === "error" ? `Modelo de voz: ${m.error}` : null) ||
    (!inputOk && state.input.running ? "Sem acesso ao teclado. Na pasta do projeto, rode: sudo ./setup-permissions.sh" : null);
  $("#banner").innerHTML = err ? `<div class="banner"><span>${esc(err)}</span><button class="icon-btn" data-act="dismiss-error">${icon("close", 16)}</button></div>` : "";
}

// ---- pages -----------------------------------------------------------------------

function historyGroups(items, page) {
  const filtered = items.filter((h) => matchesSearch(page, h.text, h.raw));
  if (!filtered.length) return `<div class="empty">${items.length ? "Nada encontrado." : "Seus ditados vão aparecer aqui. Segure o atalho e fale."}</div>`;
  const groups = [];
  for (const h of filtered) {
    const label = dayLabel(h.at);
    if (!groups.length || groups.at(-1).label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(h);
  }
  const KIND = { command: "Comando", polish: "Transformação", note: "Nota" };
  return groups
    .map(
      (g, i) => `
      <div class="group-label"><span>${esc(g.label)}</span>${i === 0 ? searchTools(page) : ""}</div>
      <div class="rows">${g.items
        .map(
          (h) => `<div class="row">
            <span class="time">${timeLabel(h.at)}</span>
            <div class="body">${KIND[h.kind] ? `<span class="kind">${esc(h.preset ? `${KIND[h.kind]} · ${h.preset}` : KIND[h.kind])}</span>` : ""}<p>${esc(h.text)}</p></div>
            <div class="actions">
              <button class="icon-btn small" data-act="copy" data-text="${esc(h.text)}" title="Copiar">${icon("copy", 16)}</button>
              <button class="icon-btn small" data-act="delete-history" data-arg="${esc(h.at)}" title="Apagar">${icon("trash", 16)}</button>
            </div>
          </div>`,
        )
        .join("")}</div>`,
    )
    .join("");
}

function pageHome() {
  const { settings, stats, history, userName } = S;
  const challenge = Math.min(100, stats.wordsToday);
  return `<div class="page"><div class="home">
    <h1 class="greeting">Olá${userName ? `, ${esc(userName)}` : ""}! Volte ao fluxo com ${keysHtml(settings.shortcuts.pushToTalk)}</h1>
    <div>
      ${dismissed("home-hero") ? "" : `<div class="hero">${heroClose("home-hero")}
        <h2>Dite em qualquer app</h2>
        <p>Segure o atalho, fale e solte: o texto aparece onde o cursor estiver — terminal, navegador, editor.</p>
        <div><button class="btn light" data-act="modal" data-arg="help">Ver todos os atalhos</button></div>
      </div>`}
      ${historyGroups(history, "home")}
    </div>
    <div class="stats-col"><div class="stat-card">
      <section>
        <div class="big-stat"><b>${fmt(stats.words)}</b><span>palavras no total</span></div>
        <div class="big-stat"><b>${fmt(stats.wpm)}</b><span>palavras/min</span></div>
        <div class="big-stat"><b>${fmt(stats.streak)}</b><span>${stats.streak === 1 ? "dia seguido" : "dias seguidos"}</span></div>
      </section>
      <section>
        <h4>Desafio de 100 palavras</h4>
        <p>Dite 100 palavras hoje para manter o ritmo.</p>
        <div class="meter"><div class="track"><div class="fill" style="width:${challenge}%"></div></div>${challenge}/100</div>
      </section>
      <section>
        <h4>Modo comando</h4>
        <p>Selecione um texto, segure ${keysHtml(settings.shortcuts.command, { soft: true })} e diga o que fazer com ele.</p>
      </section>
    </div></div>
  </div></div>`;
}

// first real sentence of the summary (skipping Markdown headings), or the transcript
function meetingPreview(m) {
  const line = (m.summary || "").split("\n").map((l) => l.replace(/^[#*\-\s]+/, "").trim()).find((l) => l && !/^(resumo|pontos principais|decisões|próximos passos)$/i.test(l));
  return (line || m.transcript || "").slice(0, 160);
}

function pageMeetings() {
  const { state, settings, meetings } = S;
  const mt = state.meeting;
  if (ui.meeting) {
    const m = meetings.find((x) => x.id === ui.meeting);
    if (m) {
      return `<div class="page"><div class="column">
        <div class="page-head"><h1><button class="icon-btn" data-act="close-meeting" title="Voltar">${icon("back", 20)}</button>${esc(m.title)}</h1>
          <div class="head-actions">
            <button class="btn secondary small" data-act="copy" data-text="${esc(`${m.summary ? m.summary + "\n\n" : ""}## Transcrição\n${m.transcript}`)}">${icon("copy", 16)}Copiar tudo</button>
            <button class="btn secondary small" data-act="delete-meeting" data-arg="${m.id}">${icon("trash", 16)}Apagar</button>
          </div></div>
        <p class="muted" style="margin:-16px 0 24px">${dayLabel(m.at)} às ${timeLabel(m.at)} · ${formatDuration(m.durationMs)}</p>
        ${m.summary ? `<div class="summary">${esc(m.summary)}</div>` : `<p class="muted">Sem resumo: a IA estava desligada ou indisponível.</p>`}
        <details class="transcript" ${m.summary ? "" : "open"}><summary>Transcrição completa</summary><p>${esc(m.transcript || "(vazia)")}</p></details>
      </div></div>`;
    }
    ui.meeting = null;
  }
  const recBtn = mt.recording
    ? `<button class="btn danger" data-act="stop-meeting"><span class="rec-dot"></span>Parar e transcrever</button>`
    : `<button class="btn" data-act="start-meeting" ${mt.processing ? "disabled" : ""}>${icon("record", 16)}Gravar reunião</button>`;
  let hero;
  if (mt.recording) {
    hero = `<div class="hero cool"><h2>Gravando <em id="meeting-clock">${formatDuration(Date.now() - mt.startedAt)}</em></h2>
      <p>Microfone${settings.meetingSystemAudio ? " e áudio do computador" : ""} sendo gravados localmente. Pare no fim da reunião para transcrever e resumir.</p></div>`;
  } else if (mt.processing) {
    hero = `<div class="hero cool"><h2>${mt.step === "summary" ? "Escrevendo o <em>resumo</em>…" : "Transcrevendo a <em>reunião</em>…"}</h2>
      <p>${mt.step === "summary" ? "A IA local está resumindo decisões e próximos passos." : `${Math.round((mt.progress || 0) * 100)}% transcrito. Pode continuar usando o computador.`}</p>
      <div class="progress"><div style="width:${Math.round((mt.progress || 0) * 100)}%"></div></div></div>`;
  } else if (!dismissed("meetings-hero")) {
    hero = `<div class="hero cool">${heroClose("meetings-hero")}<h2>Suas reuniões, <em>anotadas</em> para você</h2>
      <p>Grave o microfone e o som do computador — as outras pessoas da chamada. O DronsioFlow transcreve tudo localmente e escreve um resumo com decisões e próximos passos.</p></div>`;
  } else hero = "";
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Reuniões</h1><div class="head-actions">${recBtn}</div></div>
    ${hero}
    <div class="group"><div class="item"><div><h4>Incluir áudio do computador</h4><p>Captura o que sai dos alto-falantes ou fones (a outra ponta da chamada).</p></div>
      <div class="control">${sw(settings.meetingSystemAudio, 'data-set="meetingSystemAudio"')}</div></div></div>
    <div class="group-label"><span>Gravações</span>${searchTools("meetings")}</div>
    ${(() => {
      const list = meetings.filter((m) => matchesSearch("meetings", m.title, m.summary, m.transcript));
      if (!list.length) return `<div class="empty">${meetings.length ? "Nada encontrado." : "Nenhuma reunião gravada ainda."}</div>`;
      return `<div class="rows">${list
        .map(
          (m) => `<div class="row note-row" data-act="open-meeting" data-arg="${m.id}">
          <span class="time">${new Date(m.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</span>
          <div class="body"><p class="clip"><b>${esc(m.title)}</b></p><p class="clip muted">${esc(meetingPreview(m))}</p></div>
          <span class="muted">${formatDuration(m.durationMs)}</span></div>`,
        )
        .join("")}</div>`;
    })()}
  </div></div>`;
}

function pageInsights() {
  const { stats, history } = S;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: d.toDateString(), label: d.toLocaleDateString("pt-BR", { day: "2-digit" }), words: 0, today: i === 0 });
  }
  const byKind = { dictation: 0, command: 0, note: 0, polish: 0 };
  let speakingMs = 0;
  for (const h of history) {
    const day = days.find((d) => d.key === new Date(h.at).toDateString());
    const n = h.text.split(/\s+/).filter(Boolean).length;
    if (day) day.words += n;
    byKind[h.kind || "dictation"] = (byKind[h.kind || "dictation"] || 0) + 1;
    speakingMs += h.durationMs || 0;
  }
  const max = Math.max(1, ...days.map((d) => d.words));
  const savedMin = Math.max(0, Math.round(stats.words / 40 - speakingMs / 60000)); // vs typing at 40 wpm
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Estatísticas</h1></div>
    <div class="tiles">
      <div class="tile"><b>${fmt(stats.words)}</b><span>palavras ditadas</span></div>
      <div class="tile"><b>${fmt(stats.wpm)}</b><span>palavras por minuto</span></div>
      <div class="tile"><b>${fmt(stats.streak)}</b><span>dias seguidos</span></div>
      <div class="tile"><b>${fmt(savedMin)}</b><span>minutos economizados</span></div>
    </div>
    <div class="group-label"><span>Últimos 14 dias</span></div>
    <div class="chart">${days.map((d) => `<div class="bar ${d.today ? "today" : ""}" title="${fmt(d.words)} palavras"><i style="height:${Math.round((d.words / max) * 130)}px"></i><small>${d.label}</small></div>`).join("")}</div>
    <div class="group-label" style="margin-top:28px"><span>Por tipo</span></div>
    <div class="group">
      <div class="item"><h4>Ditados</h4><b>${fmt(byKind.dictation)}</b></div>
      <div class="item"><h4>Comandos</h4><b>${fmt(byKind.command)}</b></div>
      <div class="item"><h4>Transformações</h4><b>${fmt(byKind.polish)}</b></div>
      <div class="item"><h4>Notas por voz</h4><b>${fmt(byKind.note)}</b></div>
    </div>
    <p class="muted">"Minutos economizados" compara o tempo que você levaria digitando a 40 palavras por minuto com o tempo que passou falando.</p>
  </div></div>`;
}

function pageDictionary() {
  const { settings } = S;
  const items = settings.dictionary.map((d, i) => ({ ...d, i })).filter((d) => matchesSearch("dictionary", d.term, d.heardAs));
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Dicionário</h1><div class="head-actions"><button class="btn" data-act="modal" data-arg="addWord">Adicionar</button></div></div>
    <div class="tabs"><button class="tab active">Todos</button><div class="tools">${searchTools("dictionary")}</div></div>
    ${dismissed("dict-hero") ? "" : `<div class="hero">${heroClose("dict-hero")}
      <h2>O DronsioFlow escreve do <em>seu</em> jeito.</h2>
      <p>Adicione aqui <b>nomes, siglas, termos técnicos ou jargões</b> para que sejam escritos certo nos ditados e nas reuniões.</p>
      <div class="chips"><button class="btn light" style="margin:0" data-act="modal" data-arg="addWord">Adicionar palavra</button>
      ${settings.dictionary.slice(0, 5).map((d) => `<span class="chip">${esc(d.term)}</span>`).join("")}</div></div>`}
    ${items.length ? `<div class="rows">${items
      .map(
        (d) => `<div class="row"><div class="body clip">${d.heardAs ? `${esc(d.heardAs)} → ` : ""}${esc(d.term)}</div>
        <div class="actions"><button class="icon-btn small" data-act="remove-dict" data-arg="${d.i}" title="Remover">${icon("trash", 16)}</button></div></div>`,
      )
      .join("")}</div>` : `<div class="empty">${settings.dictionary.length ? "Nada encontrado." : "Nenhum termo ainda."}</div>`}
  </div></div>`;
}

function pageSnippets() {
  const { settings } = S;
  const items = settings.snippets.map((s, i) => ({ ...s, i })).filter((s) => matchesSearch("snippets", s.trigger, s.text));
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Snippets</h1><div class="head-actions"><button class="btn" data-act="modal" data-arg="addSnippet">Adicionar</button></div></div>
    <div class="tabs"><button class="tab active">Todos</button><div class="tools">${searchTools("snippets")}</div></div>
    ${dismissed("snip-hero") ? "" : `<div class="hero cool">${heroClose("snip-hero")}
      <h2>O que <em>você</em> não deveria ter que redigitar.</h2>
      <p>Salve textos que você usa sempre — um e-mail, uma apresentação, um prompt — e diga a frase-gatilho para inseri-los na hora.</p>
      <div class="chips"><span class="chip quote">“meu email”</span><span class="chip-arrow">${icon("arrow", 14)}</span><span class="chip">voce@exemplo.com</span></div>
      <div class="chips" style="margin-top:10px"><span class="chip quote">“prompt revisão”</span><span class="chip-arrow">${icon("arrow", 14)}</span><span class="chip">Revise este código procurando bugs…</span></div>
      <div><button class="btn light" data-act="modal" data-arg="addSnippet">Adicionar snippet</button></div></div>`}
    ${items.length ? `<div class="rows">${items
      .map(
        (s) => `<div class="row"><div class="body clip">${esc(s.trigger)} → ${esc(s.text.replace(/\n/g, " "))}</div>
        <div class="actions"><button class="icon-btn small" data-act="remove-snippet" data-arg="${s.i}" title="Remover">${icon("trash", 16)}</button></div></div>`,
      )
      .join("")}</div>` : `<div class="empty">${settings.snippets.length ? "Nada encontrado." : "Nenhum snippet ainda."}</div>`}
  </div></div>`;
}

const STYLE_SHORTCUTS = [
  ["cycleStyle", "Alternar estilo", "Passa para o próximo: Natural → Formal → Casual → Muito casual."],
  ["style:natural", "Natural", "Muda direto para o estilo Natural."],
  ["style:formal", "Formal", "Muda direto para o estilo Formal."],
  ["style:casual", "Casual", "Muda direto para o estilo Casual."],
  ["style:veryCasual", "Muito casual", "Muda direto para o estilo Muito casual."],
];

function shortcutItem(name, title, desc, keys) {
  return `<div class="item"><div><h4>${title}</h4><p>${desc}</p><div style="margin-top:6px">${keysHtml(keys, { soft: true })}</div></div>
    <div class="control">${keys?.length ? `<button class="btn ghost small" data-act="clear-shortcut" data-arg="${name}">Remover</button>` : ""}<button class="btn secondary" data-act="capture" data-arg="${name}">${keys?.length ? "Alterar" : "Definir"}</button></div></div>`;
}

const STYLES = [
  ["natural", "Natural.", "Suas palavras, só com pontuação", "Oi, tudo bem? Amanhã eu consigo te mandar o relatório."],
  ["formal", "Formal.", "Profissional, frases completas", "Olá, tudo bem? Amanhã consigo lhe enviar o relatório."],
  ["casual", "Casual", "Amigável, como para um colega", "Oi, tudo bem? Amanhã te mando o relatório"],
  ["veryCasual", "muito casual", "Estilo chat, minúsculas", "oi tudo bem? amanhã te mando o relatório"],
];

function pageStyle() {
  const { settings, state } = S;
  const ai = settings.ai;
  const aiProblem = !state.ollama.available
    ? "O Ollama não está rodando: os estilos precisam da IA local."
    : !ai.enabled || !ai.formatDictation
      ? "Os estilos só valem com a formatação com IA ligada."
      : "";
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Estilo</h1></div>
    ${dismissed("style-hero") ? "" : `<div class="hero violet">${heroClose("style-hero")}<h2>Faça o DronsioFlow soar como <em>você</em></h2>
      <p>Escolha como seus ditados são escritos. A IA local aplica o estilo em qualquer app.</p></div>`}
    ${aiProblem ? `<div class="group"><div class="item"><div><h4>${esc(aiProblem)}</h4><p>Sem a IA, o ditado é instantâneo: sai como o Whisper reconheceu, sem as hesitações e com o seu dicionário.</p></div><div class="control">${state.ollama.available ? `<button class="btn" data-act="ai-on">Ligar</button>` : ""}</div></div></div>` : ""}
    <div class="style-cards">${STYLES.map(([id, name, sub, sample]) => `<button class="style-card ${ai.style === id ? "active" : ""}" data-act="set-style" data-arg="${id}"><div class="style-top"><div><h3>${name}</h3><div class="sub">${sub}</div></div>${settings.shortcuts[`style:${id}`]?.length ? keysHtml(settings.shortcuts[`style:${id}`], { soft: true }) : ""}</div><div class="bubble">${esc(sample)}</div></button>`).join("")}</div>
    <div class="group-title">Atalhos de estilo</div>
    <div class="group">
      ${STYLE_SHORTCUTS.map(([name, title, desc]) => shortcutItem(name, title, desc, settings.shortcuts[name])).join("")}
    </div>
    <p class="muted" style="margin:-8px 0 24px">Funcionam em qualquer app e mostram o novo estilo na barra flutuante. O DronsioFlow não bloqueia as teclas: evite Ctrl+S, Ctrl+F e parecidos, que o app em foco também recebe. Prefira Ctrl+Alt+1…4.</p>
    <div class="group-title">Limpeza automática</div>
    <div class="group">
      <div class="item"><div><h4>Formatação com IA</h4><p>Reescreve cada ditado no estilo escolhido, aplica autocorreções e monta listas. Neste computador, acrescenta cerca de 8 s por ditado.</p></div><div class="control">${sw(ai.formatDictation && ai.enabled, 'data-ai="formatDictation"')}</div></div>
      <div class="item"><div><h4>Remover hesitações</h4><p>"hum", "ahn", "é…". Instantâneo, funciona mesmo sem IA.</p></div><div class="control">${sw(ai.removeFillers, 'data-ai="removeFillers"')}</div></div>
      <div class="item"><div><h4>Autocorreções</h4><p>"às três, não, às quatro" vira "às quatro". Requer a formatação com IA.</p></div><div class="control">${sw(ai.selfCorrections, 'data-ai="selfCorrections"')}</div></div>
      <div class="item"><div><h4>Listas automáticas</h4><p>"primeiro…, segundo…" vira uma lista. Requer a formatação com IA.</p></div><div class="control">${sw(ai.lists, 'data-ai="lists"')}</div></div>
      <div class="item"><div><h4>Traduzir para</h4><p>Fale em um idioma e cole em outro.</p></div><div class="control">
        <select class="select" data-ai-select="translateTo">${[["", "Não traduzir"], ["en", "Inglês"], ["es", "Espanhol"], ["pt", "Português"], ["fr", "Francês"], ["de", "Alemão"], ["it", "Italiano"]].map(([v, l]) => `<option value="${v}" ${ai.translateTo === v ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    </div>
  </div></div>`;
}

function pageTransforms() {
  const { settings } = S;
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Transformações</h1><div class="head-actions"><button class="btn" data-act="add-preset">Nova transformação</button></div></div>
    ${dismissed("tf-hero") ? "" : `<div class="hero">${heroClose("tf-hero")}<h2>Reescreva qualquer texto com <em>um atalho</em></h2>
      <p>Selecione um texto em qualquer app e aperte o atalho da transformação: ele é reescrito no lugar pela IA local.</p></div>`}
    ${settings.polishPresets
      .map(
        (p, i) => `<div class="preset" data-preset="${i}">
        <div class="preset-head"><input value="${esc(p.name)}" data-preset-field="name" data-arg="${i}" aria-label="Nome" />
          <button class="icon-btn small" data-act="delete-preset" data-arg="${i}" title="Excluir">${icon("trash", 16)}</button></div>
        <textarea rows="2" data-preset-field="prompt" data-arg="${i}" aria-label="Instrução">${esc(p.prompt)}</textarea>
        <div class="preset-foot">${keysHtml(p.shortcut, { soft: true })}
          <button class="btn secondary small" data-act="capture" data-arg="polish:${p.id}">${p.shortcut?.length ? "Alterar atalho" : "Definir atalho"}</button>
          ${p.shortcut?.length ? `<button class="btn ghost small" data-act="clear-shortcut" data-arg="polish:${p.id}">Remover</button>` : ""}</div>
      </div>`,
      )
      .join("")}
  </div></div>`;
}

function pageNotes() {
  const { notes, settings } = S;
  if (ui.note) {
    const n = notes.find((x) => x.id === ui.note);
    if (n) {
      return `<div class="page"><div class="column editor">
        <div class="page-head"><h1><button class="icon-btn" data-act="close-note" title="Voltar">${icon("back", 20)}</button>Nota</h1>
          <div class="head-actions">
            <button class="btn secondary small" data-act="copy-note">${icon("copy", 16)}Copiar</button>
            <button class="btn secondary small" data-act="delete-note" data-arg="${n.id}">${icon("trash", 16)}Apagar</button></div></div>
        <div class="meta">${dayLabel(n.updatedAt || n.at)} às ${timeLabel(n.updatedAt || n.at)}</div>
        <textarea id="note-editor" data-note="${n.id}" placeholder="Escreva ou dite aqui…">${esc(n.text)}</textarea>
      </div></div>`;
    }
    ui.note = null;
  }
  const list = notes.filter((n) => matchesSearch("notes", n.text));
  return `<div class="page"><div class="column">
    <div class="page-head"><h1>Notas</h1><div class="head-actions"><button class="btn" data-act="new-note">Nova nota</button></div></div>
    ${dismissed("notes-hero") ? "" : `<div class="hero">${heroClose("notes-hero")}<h2>Para ideias que você quer <em>revisitar</em></h2>
      <p>Faça uma lista, rascunhe uma mensagem, despeje uma ideia. Escreva aqui ou dite com ${settings.shortcuts.note?.length ? esc(keysText(settings.shortcuts.note)) : "o atalho de nota (defina em Configurações → Atalhos)"}.</p>
      <div><button class="btn light" data-act="new-note">Começar nova nota</button></div></div>`}
    <div class="group-label"><span>Recentes</span>${searchTools("notes")}</div>
    ${list.length ? `<div class="rows">${list
      .map((n) => {
        const [first, ...rest] = (n.text || "Nota vazia").split("\n");
        return `<div class="row note-row" data-act="open-note" data-arg="${n.id}"><span class="time">${new Date(n.updatedAt || n.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</span>
          <div class="body"><p class="clip"><b>${esc(first.slice(0, 120))}</b></p>${rest.join(" ").trim() ? `<p class="clip muted">${esc(rest.join(" ").slice(0, 160))}</p>` : ""}</div></div>`;
      })
      .join("")}</div>` : `<div class="empty">${notes.length ? "Nada encontrado." : "Nenhuma nota ainda."}</div>`}
  </div></div>`;
}

const PAGES = { home: pageHome, meetings: pageMeetings, insights: pageInsights, dictionary: pageDictionary, snippets: pageSnippets, style: pageStyle, transforms: pageTransforms, notes: pageNotes };

// ---- modals ----------------------------------------------------------------------

const SHORTCUTS = [
  ["pushToTalk", "Segurar para falar", "Grava enquanto as teclas estiverem pressionadas e cola ao soltar."],
  ["handsFree", "Mãos livres", "Aperte para começar e de novo para terminar."],
  ["command", "Modo comando", "Com texto selecionado: diga o que fazer com ele. Sem seleção: peça algo."],
  ["note", "Nota por voz", "Dita uma nota que vai para Notas, sem colar."],
  ["pasteLast", "Colar o último ditado", "Cola de novo a última transcrição."],
  ["copyLast", "Copiar o último ditado", "Copia a última transcrição."],
];

const SETTINGS_TABS = [
  ["general", "sliders", "Geral"],
  ["shortcuts", "keyboard", "Atalhos"],
  ["voice", "waves", "Voz e modelo"],
  ["ai", "sparkle", "IA"],
  ["system", "laptop", "Sistema"],
];

function optionList(options, value) {
  return options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("");
}

function settingsBody() {
  const { settings, state } = S;
  const tab = ui.settingsTab;
  if (tab === "general") {
    return `<h2>Geral</h2><div class="group">
      <div class="item"><div><h4>Atalho de ditado</h4><p>Segure ${keysHtml(settings.shortcuts.pushToTalk, { soft: true })} e fale.</p></div><div class="control"><button class="btn secondary" data-act="capture" data-arg="pushToTalk">Alterar</button></div></div>
      <div class="item"><div><h4>Microfone</h4><p>${esc(ui.mics?.find((m) => m.name === settings.microphone)?.label || (settings.microphone ? settings.microphone : "Padrão do sistema"))}</p></div><div class="control"><select class="select" data-select="microphone">${optionList([["", "Padrão do sistema"], ...(ui.mics || []).map((m) => [m.name, m.label])], settings.microphone)}</select></div></div>
      <div class="item"><div><h4>Idioma falado</h4><p>O idioma em que você dita.</p></div><div class="control"><select class="select" data-select="language">${optionList([["pt", "Português"], ["en", "Inglês"], ["es", "Espanhol"], ["fr", "Francês"], ["de", "Alemão"], ["it", "Italiano"], ["auto", "Detectar automaticamente"]], settings.language)}</select></div></div>
      <div class="item"><div><h4>Tema</h4></div><div class="control"><select class="select" data-select="theme">${optionList([["system", "Igual ao sistema"], ["light", "Claro"], ["dark", "Escuro"]], settings.theme)}</select></div></div>
    </div>`;
  }
  if (tab === "shortcuts") {
    return `<h2>Atalhos</h2><div class="group">${SHORTCUTS.map(
      ([name, title, desc]) => `<div class="item"><div><h4>${title}</h4><p>${desc}</p><div style="margin-top:6px">${keysHtml(settings.shortcuts[name], { soft: true })}</div></div>
        <div class="control">${settings.shortcuts[name]?.length ? `<button class="btn ghost small" data-act="clear-shortcut" data-arg="${name}">Remover</button>` : ""}<button class="btn secondary" data-act="capture" data-arg="${name}">Alterar</button></div></div>`,
    ).join("")}</div>
    <div class="group-title">Estilos de escrita</div>
    <div class="group">${STYLE_SHORTCUTS.map(([name, title, desc]) => shortcutItem(name, name === "cycleStyle" ? title : `Estilo ${title}`, desc, settings.shortcuts[name])).join("")}</div>
    <p class="muted" style="margin-bottom:12px">Durante "segurar para falar", adicionar a tecla do modo mãos livres trava a gravação. <b>Esc</b> cancela. Botões laterais do mouse também valem.</p>
    <button class="btn secondary" data-act="reset-shortcuts">Restaurar padrão</button>`;
  }
  if (tab === "voice") {
    const m = state.model;
    const note = m.state === "downloading" ? `Baixando… ${Math.round((m.progress || 0) * 100)}%` : m.state === "loading" ? "Carregando na memória…" : m.state === "ready" ? `"${m.name}" carregado e pronto.` : m.error || "";
    return `<h2>Voz e modelo</h2><div class="group">
      <div class="item"><div><h4>Modelo de reconhecimento</h4><p>${esc(note)}</p></div><div class="control"><select class="select" data-select="model">${optionList([["tiny", "Tiny · 75 MB"], ["base", "Base · 145 MB"], ["small", "Small · 480 MB (recomendado)"], ["medium", "Medium · 1,5 GB"], ["large-v3-turbo", "Large v3 Turbo · 1,6 GB"]], settings.model)}</select></div></div>
    </div>
    <p class="muted">Modelos maiores erram menos e demoram mais no CPU. O Whisper roda inteiro no seu computador; o modelo é baixado só na primeira vez. Falar baixo também funciona: o volume é ajustado automaticamente.</p>`;
  }
  if (tab === "ai") {
    const models = state.ollama.models.length ? state.ollama.models : settings.ai.model ? [settings.ai.model] : [];
    return `<h2>IA local</h2><div class="group">
      <div class="item"><div><h4>IA local (Ollama)</h4><p>Usada no modo comando, nas transformações, no resumo de reuniões e, se ligada em Estilo, nos ditados.</p></div><div class="control">${sw(settings.ai.enabled, 'data-ai="enabled"')}</div></div>
      <div class="item"><div><h4>Formatar ditados com IA</h4><p>Reescreve cada ditado no estilo escolhido em Estilo, com autocorreções e listas. Acrescenta alguns segundos por ditado.</p></div><div class="control">${sw(settings.ai.formatDictation && settings.ai.enabled, 'data-ai="formatDictation"')}</div></div>
      <div class="item"><div><h4>Modelo do Ollama</h4><p>${state.ollama.available ? `${state.ollama.models.length} modelo(s) instalado(s). Modelos menores respondem mais rápido.` : "Ollama não encontrado em localhost:11434."}</p></div>
        <div class="control"><select class="select" data-ai-select="model">${optionList(models.map((m) => [m, m]), settings.ai.model)}</select><button class="icon-btn" data-act="refresh-ollama" title="Atualizar lista">${icon("search", 16)}</button></div></div>
    </div>`;
  }
  return `<h2>Sistema</h2><div class="group">
      <div class="item"><div><h4>Iniciar com o sistema</h4><p>Abre em segundo plano ao entrar na sessão.</p></div><div class="control">${sw(settings.autostart, 'data-set="autostart"')}</div></div>
      <div class="item"><div><h4>Sons</h4><p>Um bipe curto ao começar e terminar a gravação.</p></div><div class="control">${sw(settings.sounds, 'data-set="sounds"')}</div></div>
      <div class="item"><div><h4>Mostrar barra quando parado</h4><p>O tracinho no rodapé da tela que indica que o DronsioFlow está pronto.</p></div><div class="control">${sw(settings.showIdleBar, 'data-set="showIdleBar"')}</div></div>
      <div class="item"><div><h4>Tecla de colar</h4><p>Shift+Insert funciona em terminais e na maioria dos apps.</p></div><div class="control"><select class="select" data-select="pasteKeys">${optionList([["shift+insert", "Shift+Insert"], ["ctrl+v", "Ctrl+V"], ["ctrl+shift+v", "Ctrl+Shift+V"]], settings.pasteKeys)}</select></div></div>
      <div class="item"><div><h4>Restaurar área de transferência</h4><p>Depois de colar, devolve o que estava copiado antes.</p></div><div class="control">${sw(settings.restoreClipboard, 'data-set="restoreClipboard"')}</div></div>
    </div>
    <div class="group-title">Dados</div>
    <div class="group">
      <div class="item"><div><h4>Tudo fica neste computador</h4><p>Histórico, notas, reuniões e modelos ficam salvos localmente.</p></div><div class="control"><button class="btn secondary" data-act="open-folder">Abrir pasta</button></div></div>
      <div class="item"><div><h4>Apagar histórico</h4><p>Remove todos os ditados salvos.</p></div><div class="control"><button class="btn secondary" data-act="clear-history">Apagar</button></div></div>
      <div class="item"><div><h4>Sair do DronsioFlow</h4><p>Fechar a janela não desliga o ditado; isto encerra o app.</p></div><div class="control"><button class="btn danger" data-act="quit">Sair</button></div></div>
    </div>`;
}

function renderModal() {
  const root = $("#modal-root");
  const capture = S.state.capture;
  let html = "";
  if (capture) {
    const name = capture.startsWith("polish:")
      ? S.settings.polishPresets.find((p) => `polish:${p.id}` === capture)?.name || "Transformação"
      : [...SHORTCUTS, ...STYLE_SHORTCUTS.map(([n, t]) => [n, n === "cycleStyle" ? t : `Estilo ${t}`])].find(([n]) => n === capture)?.[1] || capture;
    html = `<div class="modal"><h2>Novo atalho</h2><p class="lead">${esc(name)}</p>
      <div class="capture-box">Segure as teclas juntas e solte.<br /><span class="muted">Esc sozinho cancela.</span></div>
      <div class="foot"><button class="btn secondary" data-act="cancel-capture">Cancelar</button></div></div>`;
  } else if (ui.modal === "settings") {
    html = `<div class="modal settings">
      <nav class="settings-nav"><div class="label">Configurações</div>
        ${SETTINGS_TABS.map(([id, ic, label]) => `<button class="nav-item ${ui.settingsTab === id ? "active" : ""}" data-act="settings-tab" data-arg="${id}">${icon(ic, 18)}<span>${label}</span></button>`).join("")}
        <div class="foot">DronsioFlow v1.0 · grátis e local</div></nav>
      <div class="settings-body">${settingsBody()}</div>
      <button class="icon-btn x" data-act="close-modal" title="Fechar">${icon("close", 18)}</button></div>`;
  } else if (ui.modal === "help") {
    const sc = S.settings.shortcuts;
    html = `<div class="modal" style="width:min(600px,calc(100vw - 48px))"><h2>Atalhos</h2><p class="lead">Funcionam em qualquer app, mesmo com a janela fechada.</p>
      <div class="group">${SHORTCUTS.map(([n, t, d]) => `<div class="item"><div><h4>${t}</h4><p>${d}</p></div><div class="control">${keysHtml(sc[n], { soft: true })}</div></div>`).join("")}
      ${STYLE_SHORTCUTS.filter(([n]) => sc[n]?.length).map(([n, t, d]) => `<div class="item"><div><h4>${n === "cycleStyle" ? t : `Estilo ${t}`}</h4><p>${d}</p></div><div class="control">${keysHtml(sc[n], { soft: true })}</div></div>`).join("")}
      <div class="item"><div><h4>Cancelar</h4><p>Descarta a gravação atual.</p></div><div class="control"><span class="kbd-soft">Esc</span></div></div></div>
      <p class="muted">Para mudar, abra Configurações → Atalhos.</p>
      <div class="foot"><button class="btn secondary" data-act="open-settings" data-arg="shortcuts">Alterar atalhos</button><button class="btn" data-act="close-modal">Entendi</button></div></div>`;
  } else if (ui.modal === "addWord") {
    html = `<form class="modal" data-form="addWord"><h2>Adicionar ao dicionário</h2><p class="lead">O termo vai aparecer escrito exatamente assim.</p>
      <label for="f-term">Termo</label><input class="input" id="f-term" required placeholder="Ex.: Claude Code" autofocus />
      <label for="f-heard">Costuma ser ouvido como <span class="muted">(opcional)</span></label><input class="input" id="f-heard" placeholder="Ex.: cloud code, clold code" />
      <div class="foot"><button type="button" class="btn secondary" data-act="close-modal">Cancelar</button><button class="btn" type="submit">Adicionar</button></div></form>`;
  } else if (ui.modal === "addSnippet") {
    html = `<form class="modal" data-form="addSnippet"><h2>Novo snippet</h2><p class="lead">Diga a frase-gatilho e o texto é inserido no lugar dela.</p>
      <label for="f-trigger">Frase-gatilho</label><input class="input" id="f-trigger" required placeholder="Ex.: meu email" autofocus />
      <label for="f-text">Texto</label><textarea class="input" id="f-text" rows="5" required placeholder="O texto que será inserido"></textarea>
      <div class="foot"><button type="button" class="btn secondary" data-act="close-modal">Cancelar</button><button class="btn" type="submit">Salvar snippet</button></div></form>`;
  }
  const open = Boolean(html);
  if (!open) return (root.innerHTML = "");
  // keep focus/typing intact when only the data behind an open form changed
  if (root.dataset.kind === (capture ? "capture" : ui.modal) && root.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) return;
  root.dataset.kind = capture ? "capture" : ui.modal;
  root.innerHTML = `<div class="overlay-bg" data-act="backdrop">${html}</div>`;
  root.querySelector("[autofocus]")?.focus();
}

// ---- render ------------------------------------------------------------------------

function currentTheme() {
  const t = S?.settings.theme || "system";
  return t === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
}

function editingInView() {
  const a = document.activeElement;
  return a && $("#view").contains(a) && a.matches("input:not([type=checkbox]),textarea");
}

/** force: the user navigated, so replace the view even if a field in it has focus. */
function render(force = false) {
  if (!S) return;
  if (force && editingInView()) {
    if (document.activeElement.id === "note-editor") flushNote();
    document.activeElement.blur();
  }
  document.documentElement.dataset.theme = currentTheme();
  renderShell();
  renderModal();
  if (editingInView()) {
    ui.pendingRender = true;
    return;
  }
  ui.pendingRender = false;
  const scroll = $("#panel").scrollTop;
  $("#view").innerHTML = PAGES[ui.page]();
  $("#panel").scrollTop = scroll;
  const search = $("#view [data-search][autofocus]");
  if (search && ui.focusSearch) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
    ui.focusSearch = false;
  }
}

document.addEventListener("focusout", () => setTimeout(() => ui.pendingRender && !editingInView() && render(), 0));

// ---- actions --------------------------------------------------------------------

const setAi = (patch) => api.setSettings({ ai: { ...S.settings.ai, ...patch } });

async function loadMics() {
  ui.mics = await api.listMicrophones();
  render();
}

const ACTIONS = {
  nav: (id) => {
    ui.page = id;
    ui.note = null;
    ui.meeting = null;
    $("#panel").scrollTop = 0;
    render(true);
  },
  modal: (name) => {
    ui.modal = name;
    if (name === "settings") loadMics();
    render();
  },
  "open-settings": (tab) => {
    ui.modal = "settings";
    ui.settingsTab = tab || "general";
    loadMics();
    render();
  },
  "settings-tab": (tab) => {
    ui.settingsTab = tab;
    render();
  },
  "close-modal": () => {
    ui.modal = null;
    render();
  },
  backdrop: (_a, ev) => {
    if (ev.target.classList.contains("overlay-bg") && !S.state.capture) ACTIONS["close-modal"]();
  },
  dismiss: (id) => api.setSettings({ dismissed: [...(S.settings.dismissed || []), id] }),
  "dismiss-error": () => api.dismissError(),
  copy: async (_a, _e, el) => {
    await api.copy(el.dataset.text);
    toast("Copiado");
  },
  "delete-history": (at) => api.deleteHistory(at),
  "clear-history": () => confirm("Apagar todo o histórico de ditados?") && api.deleteHistory(null),
  "open-search": (page) => {
    ui.searchOpen[page] = true;
    ui.focusSearch = true;
    render();
  },
  "start-meeting": () => api.startMeeting(),
  "stop-meeting": () => api.stopMeeting(),
  "open-meeting": (id) => {
    ui.meeting = id;
    render(true);
  },
  "close-meeting": () => {
    ui.meeting = null;
    render(true);
  },
  "delete-meeting": (id) => {
    if (!confirm("Apagar esta reunião?")) return;
    ui.meeting = null;
    api.deleteMeeting(id);
  },
  "remove-dict": (i) => api.setSettings({ dictionary: S.settings.dictionary.filter((_, j) => j !== Number(i)) }),
  "remove-snippet": (i) => api.setSettings({ snippets: S.settings.snippets.filter((_, j) => j !== Number(i)) }),
  "set-style": (id) => setAi({ style: id }),
  "ai-on": () => setAi({ enabled: true, formatDictation: true }),
  "add-preset": () =>
    api.setSettings({
      polishPresets: [...S.settings.polishPresets, { id: Date.now().toString(36), name: "Nova transformação", prompt: "Reescreva o texto…", shortcut: [] }],
    }),
  "delete-preset": (i) => confirm("Excluir esta transformação?") && api.setSettings({ polishPresets: S.settings.polishPresets.filter((_, j) => j !== Number(i)) }),
  capture: (name) => api.captureShortcut(name),
  "cancel-capture": () => api.cancelCapture(),
  "clear-shortcut": (name) => api.clearShortcut(name),
  "reset-shortcuts": () => api.resetShortcuts(),
  "new-note": async () => {
    const id = await api.saveNote({ text: "" });
    ui.note = id;
    ui.page = "notes";
    render(true);
    $("#note-editor")?.focus();
  },
  "open-note": (id) => {
    ui.note = id;
    render(true);
    $("#note-editor")?.focus();
  },
  "close-note": () => {
    ui.note = null;
    render(true);
  },
  "copy-note": async () => {
    await api.copy($("#note-editor").value);
    toast("Copiado");
  },
  "delete-note": (id) => {
    ui.note = null;
    document.activeElement?.blur();
    api.deleteNote(id);
  },
  "refresh-ollama": () => api.refreshOllama(),
  "open-folder": () => api.openFolder(),
  quit: () => api.quit(),
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset.arg, ev, el);
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.dataset.set) api.setSettings({ [el.dataset.set]: el.checked });
  else if (el.dataset.select) api.setSettings({ [el.dataset.select]: el.value });
  else if (el.dataset.ai) setAi({ [el.dataset.ai]: el.checked });
  else if (el.dataset.aiSelect) setAi({ [el.dataset.aiSelect]: el.value });
});

const timers = {};
function debounce(key, fn, ms = 500) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

function flushNote() {
  const ed = $("#note-editor");
  if (ed) api.saveNote({ id: ed.dataset.note, text: ed.value });
}

document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.dataset.search) {
    ui.search[el.dataset.search] = el.value;
    ui.pendingRender = false;
    const pos = el.selectionStart;
    $("#view").innerHTML = PAGES[ui.page]();
    const again = $(`#view [data-search="${el.dataset.search}"]`);
    again?.focus();
    again?.setSelectionRange(pos, pos);
  } else if (el.dataset.note) {
    debounce("note", flushNote);
  } else if (el.dataset.presetField) {
    debounce(`preset${el.dataset.arg}`, () => {
      const i = Number(el.dataset.arg);
      const presets = S.settings.polishPresets.map((p, j) => (j === i ? { ...p, [el.dataset.presetField]: el.value } : p));
      api.setSettings({ polishPresets: presets });
    });
  }
});

document.addEventListener("submit", (ev) => {
  const form = ev.target.closest("[data-form]");
  if (!form) return;
  ev.preventDefault();
  if (form.dataset.form === "addWord") {
    const term = $("#f-term").value.trim();
    if (term) api.setSettings({ dictionary: [...S.settings.dictionary, { term, heardAs: $("#f-heard").value.trim() }] });
  } else if (form.dataset.form === "addSnippet") {
    const trigger = $("#f-trigger").value.trim();
    const text = $("#f-text").value;
    if (trigger && text.trim()) api.setSettings({ snippets: [...S.settings.snippets, { id: Date.now().toString(36), trigger, text }] });
  }
  ui.modal = null;
  render();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && ui.modal && !S.state.capture) ACTIONS["close-modal"]();
});

$("#toggle-sidebar").addEventListener("click", () => {
  ui.collapsed = !ui.collapsed;
  try {
    localStorage.setItem("sidebar-collapsed", ui.collapsed ? "1" : "0");
  } catch {}
  render();
});
$("#toggle-theme").addEventListener("click", () => api.setSettings({ theme: currentTheme() === "dark" ? "light" : "dark" }));
$("#open-help").addEventListener("click", () => ACTIONS.modal("help"));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

// live meeting clock
setInterval(() => {
  const clock = $("#meeting-clock");
  if (clock && S?.state.meeting.recording) clock.textContent = formatDuration(Date.now() - S.state.meeting.startedAt);
}, 1000);

api.onState((s) => {
  S = s;
  render();
});
api.getState().then((s) => {
  S = s;
  if (window.__DRONSIO_PAGE) ui.page = window.__DRONSIO_PAGE;
  render();
});
