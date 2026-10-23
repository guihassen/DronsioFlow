// evdev key code -> label shown in the UI
const KEY_LABELS = (() => {
  const m = {
    1: "Esc", 14: "Backspace", 15: "Tab", 28: "Enter", 29: "Ctrl", 42: "Shift", 56: "Alt",
    57: "Espaço", 58: "Caps Lock", 125: "Super", 127: "Menu", 110: "Insert", 111: "Delete",
    102: "Home", 107: "End", 104: "Page Up", 109: "Page Down", 103: "↑", 108: "↓", 105: "←", 106: "→",
    41: "`", 12: "-", 13: "=", 26: "[", 27: "]", 43: "\\", 39: ";", 40: "'", 51: ",", 52: ".", 53: "/",
    89: "/?", 86: "\\|", 99: "Print", 119: "Pause", 70: "Scroll Lock", 69: "Num Lock",
    0x112: "Botão do meio", 0x113: "Botão lateral 1", 0x114: "Botão lateral 2", 0x115: "Botão 6", 0x116: "Botão 7",
  };
  "1234567890".split("").forEach((c, i) => (m[2 + i] = c));
  ["qwertyuiop", "asdfghjkl", "zxcvbnm"].forEach((row, r) =>
    row.split("").forEach((c, i) => (m[[16, 30, 44][r] + i] = c.toUpperCase())),
  );
  for (let i = 0; i < 10; i++) m[59 + i] = `F${i + 1}`;
  m[87] = "F11";
  m[88] = "F12";
  for (let i = 0; i < 12; i++) m[183 + i] = `F${13 + i}`;
  return m;
})();

const MODIFIER_ORDER = [29, 125, 56, 42];

function keyLabel(code) {
  return KEY_LABELS[code] || `Tecla ${code}`;
}

function sortKeys(codes) {
  const rank = (c) => (MODIFIER_ORDER.includes(c) ? MODIFIER_ORDER.indexOf(c) : 10);
  return [...codes].sort((a, b) => rank(a) - rank(b) || a - b);
}
