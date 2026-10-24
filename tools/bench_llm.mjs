// Dev tool: compares Ollama models on DronsioFlow's real prompts (speed + quality checks).
// Usage: node bench_llm.mjs model1 model2 ...
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const llm = require("../app/lib/llm.js");

const terms = ["Claude Code", "Kubernetes"];
const formatting = llm.formattingSystemPrompt({ style: "natural", terms, removeFillers: true, selfCorrections: true, lists: true });
const technical = llm.formattingSystemPrompt({ style: "technical", terms, removeFillers: true, selfCorrections: true, lists: true });

const LONG =
  "então eu queria que você revisasse o módulo de autenticação do projeto é hum principalmente a parte de refresh token " +
  "porque os usuários estão sendo deslogados depois de uns cinco minutos não dez minutos e eu acho que o problema está no " +
  "cálculo da expiração aí depois disso escreve testes para cobrir esse caso e me explica o que você mudou";

const CASES = [
  { name: "autocorreção", sys: formatting, input: "é hum amanhã a gente faz a reunião às três não às quatro da tarde",
    check: (o) => /quatro/i.test(o) && !/três/i.test(o) && !/\bhum\b/i.test(o) },
  { name: "lista", sys: formatting, input: "preciso comprar três coisas primeiro leite segundo pão e terceiro café",
    check: (o) => o.split("\n").filter((l) => /leite|pão|café/i.test(l)).length >= 3 },
  { name: "não executar prompt", sys: formatting, input: "cria uma função em python que lê um arquivo json e me explica como funciona",
    check: (o) => !/```|def |import /.test(o) && o.length < 220 && /python/i.test(o) },
  { name: "não responder pergunta", sys: formatting, input: "qual é a capital da frança",
    check: (o) => /capital/i.test(o) && !/paris/i.test(o) && o.length < 80 },
  { name: "termos técnicos", sys: formatting, input: "abre o cloud code e roda o npm install no projeto do cubernetes",
    check: (o) => /Claude Code/.test(o) && /Kubernetes/.test(o) && /npm install/.test(o) },
  { name: "pontuação", sys: formatting, input: "oi tudo bem queria saber se você pode me mandar o arquivo até amanhã",
    check: (o) => /[?,]/.test(o) && /amanhã/i.test(o) && o.length < 120 },
  { name: "ditado longo", sys: formatting, input: LONG,
    check: (o) => /dez minutos/i.test(o) && !/cinco minutos/i.test(o) && /refresh token/i.test(o) && o.length < LONG.length * 1.3 },
  { name: "estilo técnico", sys: technical, input: "é hum roda o npm install e depois faz o commit e o deploy da branch main",
    check: (o) => /`npm install`/.test(o) && /commit/i.test(o) && /deploy/i.test(o) && !/\bhum\b/i.test(o) },
  { name: "comando: traduzir seleção", sys: llm.COMMAND_WITH_SELECTION,
    input: "INSTRUÇÃO: traduz para inglês\n\nTEXTO SELECIONADO:\nObrigado pela reunião de hoje, mando o relatório amanhã.",
    check: (o) => /meeting/i.test(o) && /report/i.test(o) && !/reunião/i.test(o) },
];

async function run(model) {
  // warm: load the model and cache the formatting prompt, like the app does
  const t0 = Date.now();
  await llm.generate(model, formatting, ".", { timeoutMs: 300000, numPredict: 1 }).catch(() => {});
  const load = Date.now() - t0;
  const results = [];
  for (const c of CASES) {
    if (c.sys !== formatting) await llm.generate(model, c.sys, ".", { timeoutMs: 300000, numPredict: 1 }).catch(() => {}); // fair: cache this prompt too
    const t = Date.now();
    let out = "";
    try {
      out = await llm.generate(model, c.sys, [formatting, technical].includes(c.sys) ? llm.formattingUserPrompt(c.input) : c.input, { timeoutMs: 300000 });
    } catch (e) {
      out = `ERRO: ${e.message}`;
    }
    results.push({ name: c.name, ms: Date.now() - t, ok: c.check(out), out });
    if (c.sys !== formatting) await llm.generate(model, formatting, ".", { timeoutMs: 300000, numPredict: 1 }).catch(() => {});
  }
  const fmt = results.filter((r) => r.name !== "ditado longo" && !r.name.startsWith("comando"));
  const summary = {
    model,
    loadMs: load,
    score: `${results.filter((r) => r.ok).length}/${results.length}`,
    shortAvgMs: Math.round(fmt.reduce((a, r) => a + r.ms, 0) / fmt.length),
    longMs: results.find((r) => r.name === "ditado longo").ms,
  };
  console.log(`\n### ${model}  score ${summary.score}  curto≈${(summary.shortAvgMs / 1000).toFixed(1)}s  longo ${(summary.longMs / 1000).toFixed(1)}s  (carga ${(load / 1000).toFixed(1)}s)`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (${(r.ms / 1000).toFixed(1)}s): ${r.out.replace(/\n/g, " / ").slice(0, 170)}`);
  // free memory before the next model
  await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
  return summary;
}

const summaries = [];
for (const m of process.argv.slice(2)) summaries.push(await run(m));
console.log("\n" + JSON.stringify(summaries));
