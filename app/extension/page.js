// Injected by the DronsioFlow extension into a page (the extension's isolated world, top frame):
// reads the page and acts on it for the agent. Elements keep the same ref (ref_N) while the page lives.
// Events are synthetic (no debugger API in Firefox), so typing goes through the browser's own editing
// commands, which pages handle like real typing.
(() => {
  if (globalThis.__dronsioRun) return;

  const MAX_TEXT = 40000;
  const refs = new Map();
  const ids = new WeakMap();
  let next = 1;

  function refOf(el) {
    let r = ids.get(el);
    if (!r) {
      r = `ref_${next++}`;
      ids.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  }

  function byRef(r) {
    const el = refs.get(String(r))?.deref();
    if (!el || !el.isConnected) throw new Error(`O elemento ${r} não existe mais nesta página; leia a página de novo (read_page ou find).`);
    return el;
  }

  const clean = (s, max = 100) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  const fold = (s) => String(s).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  const INTERACTIVE = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "textbox", "searchbox",
    "combobox", "slider", "spinbutton", "treeitem", "listbox", "file",
  ]);
  const LEAF = new Set(["button", "link", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton", "file", "heading", "img", "option"]);
  const STRUCTURE = new Set(["heading", "navigation", "main", "dialog", "alertdialog", "form", "img", "list", "listitem", "row", "grid", "table", "region", "search", "iframe", "alert", "status"]);
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "svg", "canvas", "video", "audio"]);

  const editableRoot = (el) => el.isContentEditable && !el.parentElement?.isContentEditable;

  function role(el) {
    const given = el.getAttribute("role");
    if (given) return given.trim().split(/\s+/)[0];
    switch (el.localName) {
      case "a":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
      case "summary":
        return "button";
      case "input": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return null;
        return { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", file: "file" }[t] || "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return el.multiple ? "listbox" : "combobox";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return "heading";
      case "img":
        return el.getAttribute("alt") ? "img" : null;
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "dialog":
        return "dialog";
      case "form":
        return "form";
      case "ul": case "ol":
        return "list";
      case "li":
        return "listitem";
      case "table":
        return "table";
      case "iframe":
        return "iframe";
    }
    return editableRoot(el) ? "textbox" : null;
  }

  function labelText(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return t;
    }
    return null;
  }

  function name(el) {
    const r = role(el);
    const candidates = [
      el.getAttribute("aria-label"),
      labelText(el),
      el.labels?.length ? [...el.labels].map((l) => l.innerText).join(" ") : null,
      el.getAttribute("alt"),
      el.localName === "input" && ["button", "submit", "reset"].includes(el.type) ? el.value : null,
      ["button", "link", "heading", "tab", "menuitem", "option", "listitem", "row", "treeitem"].includes(r) || !r ? el.innerText : null,
      el.getAttribute("title"),
      el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || el.dataset?.placeholder,
    ];
    for (const c of candidates) if (c && clean(c)) return clean(c);
    return "";
  }

  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  const isTextField = (el) =>
    (el.localName === "input" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color", "hidden"].includes((el.type || "text").toLowerCase())) ||
    el.localName === "textarea";
  const isEditable = (el) => Boolean(el) && (isTextField(el) || el.isContentEditable);

  function states(el) {
    const out = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("desativado");
    if (el.checked || el.getAttribute("aria-checked") === "true") out.push("marcado");
    if (el.getAttribute("aria-selected") === "true") out.push("selecionado");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) out.push(expanded === "true" ? "aberto" : "fechado");
    if (isTextField(el)) out.push(el.type === "password" ? (el.value ? "valor: ••••" : "vazio") : el.value ? `valor: "${clean(el.value, 80)}"` : "vazio");
    if (el.localName === "select") out.push(`valor: "${clean(el.selectedOptions?.[0]?.text, 60)}"`);
    if (el.isContentEditable && editableRoot(el)) out.push(clean(el.innerText) ? `texto: "${clean(el.innerText, 80)}"` : "vazio");
    if (deepActive() === el) out.push("em foco");
    return out.length ? ` (${out.join(", ")})` : "";
  }

  const interactive = (el, r) => INTERACTIVE.has(r) || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && r !== "dialog" && r !== "main");
  const line = (el, r, depth) => `${"  ".repeat(depth)}${r || "clicável"} "${name(el)}" [${refOf(el)}]${states(el)}`;

  function walk(el, depth, out, onlyInteractive) {
    if (out.size > MAX_TEXT) return;
    for (const node of el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes) {
      if (out.size > MAX_TEXT) return (out.cut = true);
      if (node.nodeType === Node.TEXT_NODE) {
        const t = clean(node.textContent, 200);
        if (t && !onlyInteractive) out.push(`${"  ".repeat(depth)}"${t}"`);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || SKIP.has(node.localName) || node.getAttribute("aria-hidden") === "true") continue;
      if (!visible(node) && node.localName !== "slot") {
        if (getComputedStyle(node).display !== "contents") continue;
      }
      const r = role(node);
      if (interactive(node, r)) {
        out.push(line(node, r, depth));
        if (!LEAF.has(r)) walk(node, depth + 1, out, onlyInteractive);
      } else if (STRUCTURE.has(r) && !(onlyInteractive && !["dialog", "alertdialog", "form", "heading"].includes(r))) {
        out.push(`${"  ".repeat(depth)}${r}${r === "heading" || r === "img" || name(node) ? ` "${name(node)}"` : ""}`);
        if (!LEAF.has(r)) walk(node, depth + 1, out, onlyInteractive);
      } else {
        walk(node, depth, out, onlyInteractive);
      }
    }
  }

  function header() {
    const a = deepActive();
    return `Página: ${document.title} — ${location.href}${a && a !== document.body ? `\nFoco: ${describe(a)}` : ""}`;
  }

  function readPage({ filter }) {
    const lines = [];
    lines.size = 0;
    const push = lines.push.bind(lines);
    lines.push = (s) => {
      lines.size += s.length + 1;
      return push(s);
    };
    walk(document.body || document.documentElement, 0, lines, filter === "interactive");
    const cut = lines.size > MAX_TEXT || lines.cut ? "\n… (página longa, cortada aqui: use find para achar um elemento ou scroll e leia de novo)" : "";
    return `${header()}\n\n${lines.join("\n")}${cut}`;
  }

  function* allElements(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      yield n;
      if (n.shadowRoot) yield* allElements(n.shadowRoot);
    }
  }

  const SYNONYMS = { botao: ["button"], campo: ["textbox", "searchbox", "combobox"], caixa: ["textbox", "checkbox"], link: ["link"], aba: ["tab"], menu: ["menuitem", "menu"], titulo: ["heading"], busca: ["searchbox"], pesquisa: ["searchbox"] };

  function find({ query }) {
    const words = fold(query).split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) throw new Error("Diga o que procurar.");
    const found = [];
    for (const el of allElements()) {
      const r = role(el);
      if (!interactive(el, r) && r !== "heading" && r !== "dialog") continue;
      if (!visible(el)) continue;
      const hay = fold(`${r || ""} ${name(el)} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`);
      let score = 0;
      for (const w of words) if (hay.includes(w) || SYNONYMS[w]?.includes(r)) score++;
      if (score) found.push({ el, r, score });
      if (found.length > 2000) break;
    }
    found.sort((a, b) => b.score - a.score);
    const best = found.filter((f) => f.score === found[0]?.score || f.score >= Math.ceil(words.length / 2)).slice(0, 15);
    if (!best.length) return `${header()}\n\nNada encontrado para "${query}". Tente outras palavras, read_page ou screenshot.`;
    return `${header()}\n\n${best.map((f) => line(f.el, f.r, 0)).join("\n")}`;
  }

  function pageText() {
    const t = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    return `${header()}\n\n${t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… (texto cortado)` : t}`;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function deepFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  const describe = (el) => `${role(el) || el.localName} "${name(el)}" [${refOf(el)}]`;

  // ---------------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------------

  function center(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  function mouse(target, type, x, y, button, extra = {}) {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button, buttons: type.endsWith("down") ? (button === 2 ? 2 : 1) : 0, ...extra };
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    if (type.startsWith("pointer")) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true });
    return target.dispatchEvent(new Ctor(type, init));
  }

  function clickAt(target, x, y, button) {
    const b = button === "right" ? 2 : 0;
    for (const t of ["pointerover", "mouseover", "pointermove", "mousemove"]) mouse(target, t, x, y, 0);
    const times = button === "double" ? 2 : 1;
    for (let i = 1; i <= times; i++) {
      mouse(target, "pointerdown", x, y, b);
      if (mouse(target, "mousedown", x, y, b, { detail: i })) {
        const f = target.closest?.(FOCUSABLE);
        if (f && f !== deepActive()) f.focus({ preventScroll: true });
      }
      mouse(target, "pointerup", x, y, b);
      mouse(target, "mouseup", x, y, b, { detail: i });
      if (b === 2) mouse(target, "contextmenu", x, y, 2);
      else mouse(target, "click", x, y, 0, { detail: i });
    }
    if (button === "double") mouse(target, "dblclick", x, y, 0, { detail: 2 });
  }

  function click({ ref, coordinate, button = "left" }) {
    let target;
    let x;
    let y;
    if (ref) {
      const el = byRef(ref);
      [x, y] = center(el);
      const hit = deepFromPoint(x, y);
      // whatever is on top at that point gets the click, as with a real mouse, if it belongs to the element
      target = hit && (hit === el || el.contains(hit)) ? hit : el;
    } else if (Array.isArray(coordinate) && coordinate.length === 2) {
      [x, y] = coordinate.map(Number);
      target = deepFromPoint(x, y);
      if (!target) throw new Error(`Nada na posição (${x}, ${y}): ela está fora da janela? Veja o tamanho no screenshot.`);
    } else throw new Error("Diga onde clicar: ref (de read_page ou find) ou coordinate [x, y].");
    clickAt(target, x, y, button);
    const what = button === "right" ? "com o botão direito em" : button === "double" ? "duas vezes em" : "em";
    return `Clicou ${what} ${describe(ref ? byRef(ref) : target)}.`;
  }

  function caretToEnd(el) {
    if (isTextField(el)) {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {} // email and number fields have no selection
      return;
    }
    const sel = getSelection();
    if (sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) return; // keep the caret the agent placed
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusField(ref) {
    let el = byRef(ref);
    if (!isEditable(el)) el = el.querySelector('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') || el;
    if (!isEditable(el)) throw new Error(`${describe(el)} não é um campo de texto.`);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (deepActive() !== el && !el.contains(deepActive())) el.focus({ preventScroll: true });
    caretToEnd(el);
    return el;
  }

  const valueSetter = (el) => Object.getOwnPropertyDescriptor(el.localName === "textarea" ? HTMLTextAreaElement.prototype : el.localName === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set;

  /** Inserts at the cursor like typing: the editing command first, the page's own handlers as a fallback. */
  function insertText(el, text) {
    if (!text) return;
    if (document.execCommand("insertText", false, text)) return;
    if (isTextField(el)) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      valueSetter(el).call(el, el.value.slice(0, start) + text + el.value.slice(end));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return;
    }
    // rich editors (Lexical, ProseMirror, Draft) insert on beforeinput themselves
    if (!el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text }))) return;
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function newLine(el) {
    if (el.localName === "input") return;
    if (!document.execCommand("insertLineBreak")) insertText(el, "\n");
  }

  function type({ text, ref }) {
    const el = ref ? focusField(ref) : deepActive();
    if (!isEditable(el)) throw new Error("Nenhum campo de texto em foco: clique no campo antes ou passe o ref dele.");
    String(text ?? "").split("\n").forEach((part, i) => {
      if (i) newLine(el);
      insertText(el, part);
    });
    return `Digitou ${String(text ?? "").length} caracteres em ${describe(el)}.`;
  }

  const KEYS = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46], space: [" ", "Space", 32],
    arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  };
  for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

  function parseKey(combo) {
    const parts = combo.split("+").filter(Boolean);
    const last = parts.pop() || "";
    const mods = new Set(parts.map((p) => fold(p)));
    const mod = { ctrlKey: mods.has("ctrl") || mods.has("control"), shiftKey: mods.has("shift"), altKey: mods.has("alt"), metaKey: mods.has("meta") || mods.has("cmd") || mods.has("super") };
    const known = KEYS[fold(last)];
    if (known) return { key: known[0], code: known[1], keyCode: known[2], ...mod };
    if ([...last].length !== 1) throw new Error(`Tecla desconhecida: ${last}`);
    const upper = last.toUpperCase();
    const code = /[a-z]/i.test(last) ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : "";
    return { key: mod.shiftKey ? upper : last, code, keyCode: upper.charCodeAt(0), ...mod, printable: true };
  }

  function moveFocus(back) {
    const all = [...document.querySelectorAll(FOCUSABLE)].filter((e) => e.tabIndex >= 0 && !e.disabled && visible(e));
    if (!all.length) return;
    const i = all.indexOf(deepActive());
    all[(i + (back ? -1 : 1) + all.length) % all.length].focus();
  }

  /** What the browser would do for a key the page didn't handle (untrusted events have no default action). */
  function defaultAction(k, target) {
    const editable = isEditable(target);
    const plain = !k.ctrlKey && !k.metaKey && !k.altKey;
    const scroller = document.scrollingElement;
    if (k.key === "Enter") {
      if (target.localName === "input" && target.form) return target.form.requestSubmit();
      if (editable) return k.shiftKey || target.localName === "textarea" ? newLine(target) : document.execCommand("insertParagraph") || newLine(target);
      if (target.matches?.("a[href], button, summary, [role=button], [role=link]")) return target.click();
      return;
    }
    if (k.key === "Tab" && plain) return moveFocus(k.shiftKey);
    if (k.key === "Backspace" && editable) return document.execCommand("delete");
    if (k.key === "Delete" && editable) return document.execCommand("forwardDelete");
    if ((k.ctrlKey || k.metaKey) && fold(k.key) === "a") return isTextField(target) ? target.select() : document.execCommand("selectAll");
    if ((k.ctrlKey || k.metaKey) && fold(k.key) === "z") return document.execCommand(k.shiftKey ? "redo" : "undo");
    if (k.key === " " && plain && target.matches?.("button, input[type=checkbox], input[type=radio], [role=button], [role=checkbox]")) return target.click();
    if (k.printable && plain && editable) return insertText(target, k.key);
    if (editable) return;
    const page = innerHeight * 0.85;
    const by = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, " ": k.shiftKey ? -page : page }[k.key];
    if (by) scroller.scrollBy({ top: by, behavior: "instant" });
    if (k.key === "Home") scroller.scrollTo({ top: 0, behavior: "instant" });
    if (k.key === "End") scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
  }

  function key({ keys }) {
    const combos = String(keys ?? "").trim().split(/\s+/).filter(Boolean);
    if (!combos.length) throw new Error("Diga as teclas, por exemplo Enter ou ctrl+a.");
    const parsed = combos.map(parseKey);
    for (const k of parsed) {
      const target = deepActive() || document.body;
      const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey, bubbles: true, cancelable: true, composed: true };
      let go = target.dispatchEvent(new KeyboardEvent("keydown", init));
      if (go && (k.printable || k.key === "Enter") && !k.ctrlKey && !k.metaKey && !k.altKey) go = target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: k.key === "Enter" ? 13 : k.key.charCodeAt(0) }));
      if (go) defaultAction(k, target);
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    }
    return `Pressionou ${combos.join(" ")}.`;
  }

  function scrollableAncestor(node, vertical) {
    for (let n = node; n && n !== document.documentElement; n = n.parentElement || n.getRootNode?.().host) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const s = getComputedStyle(n);
      const overflow = vertical ? s.overflowY : s.overflowX;
      if ((vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth) && /(auto|scroll|overlay)/.test(overflow)) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scroll({ direction, amount, ref }) {
    const el = ref ? byRef(ref) : null;
    if (!direction) {
      if (!el) throw new Error("Diga a direção (up, down, left, right) ou o ref do elemento a mostrar.");
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return `Rolou até ${describe(el)}.`;
    }
    const vertical = direction === "up" || direction === "down";
    const scroller = scrollableAncestor(el || deepFromPoint(innerWidth / 2, innerHeight / 2) || document.body, vertical);
    const view = scroller === document.scrollingElement ? (vertical ? innerHeight : innerWidth) : vertical ? scroller.clientHeight : scroller.clientWidth;
    const delta = Math.round((Number(amount) || 0.8) * view) * (direction === "up" || direction === "left" ? -1 : 1);
    const before = vertical ? scroller.scrollTop : scroller.scrollLeft;
    scroller.scrollBy({ [vertical ? "top" : "left"]: delta, behavior: "instant" });
    const after = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const where = scroller === document.scrollingElement ? "a página" : describe(scroller);
    return `Rolou ${where} de ${Math.round(before)} para ${Math.round(after)} px${before === after ? " (já estava no limite)" : ""}.`;
  }

  function formInput({ ref, value }) {
    const el = byRef(ref);
    const v = String(value ?? "");
    const fire = () => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (el.localName === "select") {
      const opt = [...el.options].find((o) => o.value === v) || [...el.options].find((o) => fold(clean(o.text)) === fold(clean(v))) || [...el.options].find((o) => fold(o.text).includes(fold(v)));
      if (!opt) throw new Error(`Opção "${v}" não existe. Opções: ${[...el.options].map((o) => clean(o.text, 40)).join(", ")}`);
      valueSetter(el).call(el, opt.value);
      fire();
      return `Escolheu "${clean(opt.text)}" em ${describe(el)}.`;
    }
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) {
      const want = value === true || /^(true|on|1|sim|yes|checked|marcado)$/i.test(v);
      if (el.checked !== want) el.click();
      return `${el.checked ? "Marcou" : "Desmarcou"} ${describe(el)}.`;
    }
    if (isTextField(el)) {
      el.focus({ preventScroll: true });
      valueSetter(el).call(el, v);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: v }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return `Preencheu ${describe(el)}.`;
    }
    if (el.isContentEditable) {
      el.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      insertText(el, v);
      return `Preencheu ${describe(el)}.`;
    }
    throw new Error(`${describe(el)} não é um campo de formulário comum: use click e type.`);
  }

  function fileUpload({ ref, files }) {
    let el = byRef(ref);
    if (!(el.localName === "input" && el.type === "file")) el = el.control || el.querySelector?.("input[type=file]") || el;
    if (!(el.localName === "input" && el.type === "file")) throw new Error(`${describe(el)} não é um campo de arquivo.`);
    const dt = new DataTransfer();
    for (const f of files || []) {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type || "" }));
    }
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Anexou ${dt.files.length} arquivo(s) em ${describe(el)}.`;
  }

  const viewport = () => ({ width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), dpr: devicePixelRatio });

  const TOOLS = { read_page: readPage, get_page_text: pageText, find, click, type, key, scroll, form_input: formInput, file_upload: fileUpload, viewport };

  globalThis.__dronsioRun = async (tool, args) => {
    try {
      if (!TOOLS[tool]) throw new Error(`Ação desconhecida: ${tool}`);
      return { ok: await TOOLS[tool](args || {}) };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  };
})();
