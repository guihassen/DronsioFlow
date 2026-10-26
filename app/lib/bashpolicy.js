// Agent mode: decides whether a Bash command the agent wants to run needs the user's confirmation.
// A blocklist with a deliberately simple, conservative shell parser: whatever it can't follow
// (unclosed quotes, command substitution, variables where a path or a command goes) asks the user.
// It reduces risk; it can't prove a command harmless (see README, "Modo agente").

const path = require("path");

const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac", "time", "coproc", "[[", "]]"]);

// Fixed categories, shown read-only in Settings. `names` drive the checks below.
const DELETE = ["rm", "rmdir", "shred", "unlink", "truncate", "wipe", "srm", "trash-put", "trash", "trash-rm", "trash-empty", "kde-rm"];
const SYSTEM = [
  "sudo", "su", "pkexec", "doas", "run0", "systemctl", "service", "systemd-run", "kill", "pkill", "killall", "xkill", "reboot", "shutdown",
  "poweroff", "halt", "init", "telinit", "dd", "fdisk", "sfdisk", "gdisk", "cfdisk", "parted", "wipefs", "mkswap", "mke2fs", "mount", "umount",
  "swapon", "swapoff", "losetup", "chown", "chgrp", "chattr", "crontab", "at", "batch", "insmod", "rmmod", "modprobe", "useradd", "userdel",
  "usermod", "groupadd", "groupdel", "passwd", "chpasswd", "visudo", "iptables", "ip6tables", "nft", "firewall-cmd", "ufw", "setenforce",
  "update-alternatives", "ldconfig", "efibootmgr", "runuser", "unshare", "nsenter", "chroot", "setpriv", "sg", "newgrp", "capsh",
];
const REMOTE = [
  "ssh", "scp", "sftp", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "lftp", "mail", "mailx", "s-nail", "sendmail", "mutt", "msmtp", "http", "https", "xh",
  // servers: expose this computer's files to the network
  "http-server", "live-server", "serve", "httpd", "uploadserver", "pyftpdlib",
];
// read or hand out stored passwords, tokens and keys
const SECRETS = ["secret-tool", "pass", "gopass", "keepassxc-cli", "bw", "op", "lpass", "keyctl", "kwallet-query", "kwalletcli"];
// run and inspect another program (debuggers, tracers) or run it in another place or session
const DIRECT_RUNNERS = ["strace", "ltrace", "gdb", "lldb", "valgrind", "firejail", "bwrap", "flatpak-spawn", "systemd-nspawn", "proot", "fakechroot"];
// run the command that follows their options (k: options that take a value)
const WRAPPERS = {
  "ssh-agent": ["-a", "-E", "-P", "-t"], "dbus-run-session": ["--config-file", "--dbus-daemon"], "dbus-launch": ["--config-file"],
  "xvfb-run": ["-n", "--server-num", "-e", "--error-file", "-f", "--auth-file", "-p", "--xauth-protocol", "-s", "--server-args", "-w", "--wait"],
  fakeroot: ["-l", "--lib", "--faked", "-s", "-i", "-b"], catchsegv: [], torsocks: ["-u", "-p", "-a", "-P"], proxychains: ["-f"], proxychains4: ["-f"],
  "pw-jack": [], unbuffer: [], chronic: [], ifne: [], "run-one": [], numactl: ["-C", "-N", "-m", "-p", "-i", "--physcpubind", "--cpunodebind", "--membind", "--preferred", "--interleave"],
};
const TERMINALS = ["gnome-terminal", "kgx", "ptyxis", "konsole", "xterm", "uxterm", "alacritty", "kitty", "foot", "footclient", "wezterm", "tilix", "terminator", "xfce4-terminal", "x-terminal-emulator", "lxterminal", "mate-terminal", "sakura", "st", "urxvt", "rxvt", "terminology", "cool-retro-term"];
const EDITORS = ["vim", "vi", "nvim", "view", "ex", "gvim", "vimdiff", "emacs", "emacsclient", "nano", "micro", "kak", "helix", "hx"];
// take their arguments as data, never as a command: the generic checks for unknown programs skip them
const NO_EXEC = new Set([
  "echo", "printf", "cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "tr", "ls", "dir", "mkdir", "man", "info", "which", "type", "whereis",
  "whatis", "apropos", "file", "stat", "test", "[", "true", "false", "jq", "yq", "diff", "cmp", "comm", "basename", "dirname", "realpath", "readlink", "date",
  "seq", "sleep", "yes", "notify-send", "column", "tac", "rev", "fold", "fmt", "nl", "paste", "join", "od", "xxd", "hexdump", "base64", "md5sum", "sha1sum",
  "sha256sum", "sha512sum", "b2sum", "du", "df", "free", "ps", "pgrep", "pidof", "id", "groups", "uname", "hostname", "whoami", "pwd", "read", "wait", "jobs",
  "exit", "return", "shift", "set", "unset", "shopt", "ulimit", "umask", "getopts", "local", "zenity", "kdialog", "xdg-open", "xclip", "xsel", "wl-copy", "wl-paste",
  "make", "cmake", "ninja", "pytest", "tsc", "eslint", "prettier", "cargo", "go", "rustc", "gcc", "g++", "clang", "javac", "java", "mvn", "gradle",
]);
const RUNNERS = ["npx", "pnpx", "bunx", "uvx"]; // download and run a package
const BUILTINS = ["eval", "alias", "trap", "enable", "function"]; // run or define code
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash"];
const INTERPRETERS = { expect: "c", node: "ep", nodejs: "ep", perl: "eE", ruby: "e", php: "r", lua: "e", luajit: "e", Rscript: "e", osascript: "e", pwsh: "c", tclsh: "", deno: "", bun: "e" };
const isPython = (n) => /^(python|pypy)[\d.]*$/.test(n);
const isInterpreter = (n) => SHELLS.includes(n) || isPython(n) || n in INTERPRETERS;
const SYS_PACKAGES = ["dnf", "yum", "microdnf", "apt", "apt-get", "aptitude", "zypper"];
const SYS_PACKAGE_READ = new Set(["list", "info", "search", "show", "policy", "provides", "repoquery", "deplist", "check-update", "depends", "rdepends", "changelog", "whatprovides", "repolist", "--version", "-h", "--help"]);
const DANGEROUS_ENV = /^(PATH|LD_\w+|BASH_ENV|ENV|PYTHON(PATH|STARTUP|HOME)|NODE_OPTIONS|NODE_PATH|PERL5?LIB|PERL5OPT|RUBYOPT|RUBYLIB|PROMPT_COMMAND|IFS|GIT_\w+|SHELLOPTS|BASHOPTS|PS4|HOME|ZDOTDIR|EDITOR|VISUAL|PAGER|SSH_ASKPASS|SUDO_ASKPASS|LESSOPEN|BROWSER|CDPATH)$/;
// servers that expose this computer's files or accept uploads and mail
const PYTHON_SERVERS = new Set(["http.server", "SimpleHTTPServer", "CGIHTTPServer", "uploadserver", "pyftpdlib", "smtpd", "aiosmtpd", "wsgiref.simple_server", "xmlrpc.server"]);
const PYTHON_MODULES = new Set(["json.tool", "venv", "pytest", "unittest", "py_compile", "compileall", "zipfile", "tarfile", "timeit", "pydoc", "site", "pip", "pip3"]);

const RULES = [
  { title: "Apagar", items: [...DELETE.filter((n) => !n.startsWith("trash") && n !== "kde-rm"), "lixeira (gio trash/remove, trash-put, trash-empty, kioclient)", "find -delete / -exec rm", "git clean", "git reset --hard", "git checkout -- / git restore", "git branch -D", "git stash drop/clear", "git rm", "rsync --delete", "tar --remove-files, zip -m", "mv de fora das pastas de trabalho"] },
  { title: "Sistema", items: ["sudo, su, pkexec, doas, runuser", "instalar ou remover pacotes (dnf, apt, rpm, flatpak, snap, pip, npm -g, cargo…)", "systemctl, service", "kill, pkill, killall", "reboot, shutdown", "dd, mkfs, fdisk, parted, mount", "chmod/setfacl fora das pastas, chmod -R, chown", "crontab", "dconf, gsettings set, xdg-settings set", "nmcli connection modify/delete/down, radio, rfkill", "loginctl, hostnamectl, timedatectl, update-alternatives", "dbus-send, gdbus call/emit, busctl call/set-property", "unshare, nsenter, chroot", "git apply/merge/pull/rebase/checkout… fora das pastas", "cp/mv/tee/sed -i/sort -o/convert gravando fora das pastas de trabalho"] },
  { title: "Publicar ou enviar", items: ["git push", "gh (exceto consultas)", "ssh, scp, sftp", "rsync para outro computador", "curl enviando dados (-d, -F, -T, -X POST…)", "wget --post", "nc, ncat, socat", "mail, sendmail", "servidores (python -m http.server, php -S, http-server, serve, busybox httpd, ruby -run)"] },
  { title: "Segredos", items: ["secret-tool, keyctl, kwallet-query", "git credential", "gpg --export-secret-keys", "pass, gopass, keepassxc-cli, bw, op, lpass", "nmcli --show-secrets, nmcli device wifi show-password", "printenv, env, set, export -p, declare -p (mostram tokens do ambiente)"] },
  { title: "Brechas", items: ["código inline (bash -c, python -c, node -e…)", "pipe ou entrada para um interpretador", "$(…) e crases", "rodar um arquivo criado ou alterado nesta tarefa", "programas que rodam outro comando (xargs, tmux, terminais, strace, gdb, docker exec, vim -c, busybox…) com um comando da lista", "eval, alias, function, source de fora das pastas", "npx e parecidos", "caminhos sensíveis (~/.ssh, .env, ~/.config…), também por curinga ou variável", "> ou >> para fora das pastas de trabalho", "variáveis como PATH e LD_PRELOAD"] },
];

// ---------------------------------------------------------------------------
// Parser: commands, words and redirections
// ---------------------------------------------------------------------------

class ParseError extends Error {}

/**
 * Splits `src` into simple commands: { words: [{ text, dynamic }], redirects: [{ op, target }], piped }.
 * `dynamic` marks a word with a variable we can't know; its text keeps the variable as ${NAME}, so a
 * value assigned earlier can be put back (expandWord). Returns { commands, substitution, funcDef }.
 * $HOME and ~ are expanded; heredoc bodies are skipped (the command is marked as reading stdin).
 */
function parse(src, home) {
  const commands = [];
  let substitution = false;
  let funcDef = false;
  let cmd = newCommand(false);
  let word = null; // { text, dynamic }
  let pendingRedirect = null;
  const heredocs = [];
  let i = 0;

  function newCommand(piped) {
    return { words: [], redirects: [], piped, stdin: false };
  }
  const startWord = () => (word ??= { text: "", dynamic: false, quoted: false });
  function endWord() {
    if (!word) return;
    if (pendingRedirect) {
      if (pendingRedirect.op === "<<" || pendingRedirect.op === "<<-") heredocs.push({ delim: word.text, strip: pendingRedirect.op === "<<-" });
      else cmd.redirects.push({ ...pendingRedirect, target: word });
      pendingRedirect = null;
    } else cmd.words.push(word);
    word = null;
  }
  function endCommand(piped = false) {
    endWord();
    if (pendingRedirect) throw new ParseError("redirecionamento sem destino");
    if (cmd.words.length || cmd.redirects.length) commands.push(cmd);
    cmd = newCommand(piped);
  }
  function variable() {
    // at "$": $HOME / ${HOME} expand, $( is a substitution, anything else is unknown
    const rest = src.slice(i + 1);
    const home1 = /^(HOME\b|\{HOME\})/.exec(rest);
    if (home1) {
      startWord().text += home;
      i += 1 + home1[0].length;
      return;
    }
    if (rest[0] === "(") substitution = true;
    const m = /^(\{[^}]*\}|\w+|[@*#?$!\-0-9])/.exec(rest);
    startWord().dynamic = true;
    // ${NAME:-x}, ${#NAME}… keep only the name; anything fancier can't be resolved later
    const inner = m ? m[0].replace(/^\{|\}$/g, "") : "";
    const name = /^\w+$/.test(inner) ? inner : /^\w+/.exec(inner)?.[0] || "?";
    word.text += `\${${name}}`;
    i += 1 + (m ? m[0].length : 0);
  }

  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        startWord().text += src[i + 1] ?? "";
        i += 2;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ParseError("aspas sem fechar");
      startWord().text += src.slice(i + 1, end);
      word.quoted = true;
      i = end + 1;
    } else if (c === '"') {
      startWord().quoted = true;
      i++;
      for (;;) {
        if (i >= src.length) throw new ParseError("aspas sem fechar");
        const d = src[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && '$`"\\\n'.includes(src[i + 1])) {
          word.text += src[i + 1] === "\n" ? "" : src[i + 1];
          i += 2;
        } else if (d === "$") variable();
        else if (d === "`") {
          substitution = true;
          word.text += d;
          i++;
        } else {
          word.text += d;
          i++;
        }
      }
    } else if (c === "$") {
      variable();
    } else if (c === "`") {
      substitution = true;
      startWord().text += c;
      i++;
    } else if (c === "~" && !word && /^(\/|$|[\s;&|)])/.test(src.slice(i + 1, i + 2) || "")) {
      startWord().text += home;
      i++;
    } else if (c === "~" && !word) {
      startWord().dynamic = true; // ~user
      word.text += c;
      i++;
    } else if (c === "#" && !word) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endCommand();
      i++;
      // heredoc bodies start on the next line
      for (const h of heredocs.splice(0)) {
        for (;;) {
          if (i >= src.length) break;
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      substitution = true; // process substitution
      startWord().text += c;
      i++;
    } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // fd prefix (2>, &>) belongs to the redirection, not to the words
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null;
      else endWord();
      const m = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(src.slice(i));
      i += m[0].length;
      if (m[0] === "<<<") {
        cmd.stdin = true;
        pendingRedirect = { op: "<<<" };
      } else if (m[0] === "<<" || m[0] === "<<-") {
        cmd.stdin = true;
        pendingRedirect = { op: m[0] };
      } else if (m[0] === "<" || m[0] === "<&") {
        cmd.stdin = true;
        pendingRedirect = { op: m[0] };
      } else pendingRedirect = { op: m[0] };
    } else if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")") {
      const two = src.slice(i, i + 2);
      if (c === "(" && cmd.words.length === 1 && !word && /^\(\s*\)/.test(src.slice(i))) funcDef = true;
      if (word && c === "(" && /^\(\s*\)/.test(src.slice(i))) funcDef = true;
      if (two === "||" || two === "&&" || two === ";;" || two === "|&") {
        endCommand(two === "|&");
        i += 2;
      } else {
        endCommand(c === "|");
        i++;
      }
    } else {
      startWord().text += c;
      i++;
    }
  }
  endCommand();
  return { commands, substitution, funcDef };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const confirm = (reason) => ({ reason });
const isOption = (w) => w.text.startsWith("-") && w.text !== "-";
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;
const REMOTE_PATH = /^([\w.-]+@)?[\w.-]+:(?!\/\/)/; // host:path, user@host:path

// Commands that only print or test their arguments: a variable we can't resolve there is harmless.
const VAR_SAFE = new Set(["echo", "printf", "test", "[", "true", "false", "mkdir", "sleep", "basename", "dirname", "exit", "return", "shift", "read", "unset", "export", "declare", "typeset", "local", "readonly", "cd", "pushd", "wait", "seq", "expr", "let"]);
const WILDCARD = /[*?[{]/;
const isAssignment = (w) => /^[A-Za-z_]\w*\+?=/.test(w.text) && !w.text.startsWith("=");

/** {a,b} alternatives of a word (bash expands braces before globbing): the checks see every one. */
function braces(t, n = 0) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(t);
  if (!m || n > 4) return [t];
  return m[1].split(",").flatMap((alt) => braces(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length), n + 1)).slice(0, 64);
}

/**
 * ctx: { home, cwd (null when unknown), isWorkPath(abs), sensitivity(abs), isSessionFile(abs),
 * extraPatterns, written (Set of paths written earlier in this command), vars (Map name -> the
 * values assigned earlier in this command; missing = unknown) }.
 */
function makeChecker(ctx) {
  // the values a word takes with the variables assigned earlier put back; null when one is unknown
  function expandWord(w) {
    if (!w.dynamic) return [w];
    const pieces = w.text.split(/\$\{(\w+|\?)\}/);
    if (pieces.length === 1) return null; // ~user and the like
    let outs = [""];
    for (let k = 0; k < pieces.length; k++) {
      if (k % 2 === 0) {
        outs = outs.map((o) => o + pieces[k]);
        continue;
      }
      const values = pieces[k] === "PWD" && ctx.cwd ? [{ text: ctx.cwd, dynamic: false }] : ctx.vars.get(pieces[k]);
      if (!values || values.some((v) => v.dynamic)) return null;
      outs = outs.flatMap((o) => values.map((v) => o + v.text)).slice(0, 32);
    }
    return outs.map((text) => ({ ...w, text, dynamic: false }));
  }
  // NAME=value (alone, or after export/declare/local/readonly): remembered for later $NAME
  function assign(w) {
    const i = w.text.indexOf("=");
    const append = w.text[i - 1] === "+";
    const name = w.text.slice(0, append ? i - 1 : i);
    const value = { ...w, text: w.text.slice(i + 1).replace(/^~(?=\/|$)/, ctx.home) };
    const values = !append && expandWord(value);
    if (values) ctx.vars.set(name, values);
    else ctx.vars.delete(name);
  }
  const resolve = (w) => {
    const values = expandWord(w);
    if (!values || values.length !== 1) return null;
    const t = values[0].text;
    if (path.isAbsolute(t)) return path.normalize(t);
    return ctx.cwd ? path.resolve(ctx.cwd, t) : null;
  };
  // where a write lands: allowed only inside the work folders, never on a dotfile of the home or in .git
  function writeTarget(w, what) {
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(w.text)) return null;
    const p = resolve(w);
    if (!p || WILDCARD.test(p)) return confirm(`${what} para um caminho que o app não consegue resolver (${w.text})`);
    if (ctx.sensitivity(p) || p.split(path.sep).includes(".git")) return confirm(`${what} em caminho sensível (${w.text})`);
    if (!ctx.isWorkPath(p)) return confirm(`${what} fora das pastas de trabalho (${w.text})`);
    ctx.written.add(p);
    return null;
  }
  // a script or program that is about to run: confirm if it was created or changed during the task
  function runTarget(w, what) {
    if (URLISH.test(w.text)) return confirm(`${what} baixado da internet (${w.text})`);
    const p = resolve(w);
    if (!p) return confirm(`${what} em caminho desconhecido (${w.text})`);
    if ([...ctx.written].some((x) => x === p || p.startsWith(x + path.sep)) || ctx.isSessionFile(p)) return confirm(`${what} criado ou alterado nesta tarefa (${w.text})`);
    return null;
  }
  const inHome = (p) => p === ctx.home || p.startsWith(ctx.home + path.sep);
  // one path-like value: sensitive itself, below a sensitive folder, or a pattern that could reach one
  function mentionOne(v, whole, recursive) {
    if (!v || URLISH.test(v) || (v.startsWith("-") && v === whole)) return null;
    if (WILDCARD.test(v)) {
      const parts = v.split("/");
      const k = parts.findIndex((x) => WILDCARD.test(x));
      const fixed = parts.slice(0, k).join("/");
      const base = v.startsWith("/") ? fixed || "/" : fixed ? path.resolve(ctx.cwd || ctx.home, fixed) : ctx.cwd;
      // ~/.s*/id*, ~/*/credentials, /home/*/.ssh: the fixed start already holds sensitive folders
      if (base && (fixed || ctx.cwd)) {
        const s = ctx.sensitivity(base);
        if (s === "deny" || s === "hidden" || s === "contains") return confirm(`curinga num caminho sensível (${v})`);
        if (inHome(base) && parts.slice(k).some((x) => x.startsWith("."))) return confirm(`curinga em arquivos ocultos (${v})`);
      } else if (parts.some((x) => x.startsWith("."))) return confirm(`curinga em arquivos ocultos numa pasta desconhecida (${v})`);
      return ctx.sensitiveName(path.basename(v)) ? confirm(`curinga em arquivos sensíveis (${v})`) : null;
    }
    if (!(v.includes("/") || v.startsWith(".") || v.startsWith(ctx.home))) {
      if (!ctx.sensitiveName(v)) return null;
      return confirm(`cita um arquivo sensível (${v})`);
    }
    const p = path.isAbsolute(v) ? path.normalize(v) : path.resolve(ctx.cwd || ctx.home, v);
    const s = ctx.sensitivity(p);
    // a relative path while the folder is unknown: judge its own parts too
    const parts = path.isAbsolute(v) || ctx.cwd ? [] : v.split("/").filter((x) => x && x !== "." && x !== "..");
    if (s === "deny" || s === "hidden" || (s === "contains" && recursive) || parts.some((x) => x.startsWith(".")))
      return confirm(`cita um caminho sensível (${v})`);
    return null;
  }
  // sensitive paths cited anywhere (also as NAME=value, through known variables, braces and wildcards);
  // `recursive` also catches folders that hold sensitive ones
  function mentions(words, recursive) {
    for (const w of words) {
      for (const x of expandWord(w) || []) {
        for (const t of braces(x.text)) {
          const values = [t];
          if (t.includes("=")) values.push(t.slice(t.indexOf("=") + 1).replace(/^~(?=\/|$)/, ctx.home));
          for (const v of values) {
            const r = mentionOne(v, t, recursive);
            if (r) return r;
          }
        }
      }
    }
    return null;
  }
  return { resolve, writeTarget, runTarget, mentions, expandWord, assign };
}

/** Options-aware split: [options before the first operand, operands]; `withArg` options take the next word. */
function operands(words, withArg = []) {
  const out = [];
  let opts = true;
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text;
    if (opts && t === "--") {
      opts = false;
      continue;
    }
    if (opts && isOption(words[i])) {
      if (withArg.includes(t)) i++;
      continue;
    }
    out.push(words[i]);
  }
  return out;
}

const hasFlag = (words, long, short = "") =>
  words.some((w) => (long.some((l) => w.text === l || w.text.startsWith(`${l}=`)) || (short && /^-[^-]/.test(w.text) && [...w.text.slice(1)].some((ch) => short.includes(ch)))));

function matchesPattern(argv, pattern) {
  const toks = pattern.trim().split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > argv.length) return false;
  return toks.every((t, k) => {
    const a = k === 0 ? path.basename(argv[0]) : argv[k];
    if (t === "*") return true;
    if (t.endsWith("*")) return a.startsWith(t.slice(0, -1));
    return a === t;
  });
}

/** Reason to confirm one simple command, or null. `cmd.words` already has keywords stripped. */
function checkCommand(cmd, ctx, chk, depth = 0) {
  if (depth > 8) return confirm("comando aninhado demais");
  let words = cmd.words;
  // leading assignments: harmless, unless they change how programs are found or started
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0].text) && !words[0].quoted) {
    const name = words[0].text.split("=")[0];
    if (DANGEROUS_ENV.test(name)) return confirm(`muda a variável ${name}`);
    words = words.slice(1);
  }
  if (!words.length) return null;
  const head = words[0];
  if (head.dynamic) return confirm(`o comando vem de uma variável (${head.text})`);
  const name = path.basename(head.text);
  const args = words.slice(1);
  const argv = words.map((w) => w.text);
  const sub = (from) => checkCommand({ ...cmd, words: from }, ctx, chk, depth + 1);
  // what a wrapper runs: a command line given as one quoted string, or the words that follow
  const runInner = (from) => (from.length === 1 && /\s/.test(from[0].text) ? checkNested(from[0].text, ctx, depth, name) : sub(from));

  for (const p of ctx.extraPatterns) if (matchesPattern(argv, p)) return confirm(`está na sua lista de comandos que pedem confirmação (${p})`);

  if (head.text.includes("/")) {
    const r = chk.runTarget(head, "programa");
    if (r) return r;
  }
  if (DELETE.includes(name)) return confirm(`apaga arquivos (${name})`);
  if (SYSTEM.includes(name) || /^mkfs(\.|$)/.test(name)) return confirm(`altera o sistema (${name})`);
  if (REMOTE.includes(name)) return confirm(`envia ou conecta a outro computador (${name})`);
  if (RUNNERS.includes(name)) return confirm(`baixa e executa um pacote (${name})`);
  if (BUILTINS.includes(name)) return confirm(`roda ou define código (${name})`);
  if (SECRETS.includes(name) || name.startsWith("git-credential")) return confirm(`lê ou entrega senhas e chaves guardadas (${name})`);
  if (DIRECT_RUNNERS.includes(name)) return confirm(`roda outro programa por baixo (${name})`);
  if (name in WRAPPERS) {
    let k = 0;
    while (k < args.length && isOption(args[k])) k += WRAPPERS[name].includes(args[k].text) ? 2 : 1;
    if (args[k]?.text === "--") k++;
    return k < args.length ? runInner(args.slice(k)) : null;
  }
  if (TERMINALS.includes(name)) {
    // the command comes after -e/-x/--/start, as --command=…, or as the first operand (kitty, foot)
    for (const w of args) if (/^--(command|execute)=/.test(w.text)) return checkNested(w.text.slice(w.text.indexOf("=") + 1), ctx, depth, name);
    const k = args.findIndex((w) => !isOption(w) && w.text !== "start");
    const dash = args.findIndex((w) => ["-e", "-x", "--", "--command", "--execute", "-c"].includes(w.text));
    const from = dash >= 0 && (k < 0 || dash < k) ? dash + 1 : k;
    return from >= 0 && from < args.length ? runInner(args.slice(from)) : null;
  }
  if (EDITORS.includes(name)) {
    // nano's short options are mostly display ones (-l numbers lines): only -s (speller) and -f (rcfile) run something
    const nano = name === "nano";
    const single = nano ? /^(-s|-f|--speller|--rcfile)$/ : /^(-c|--cmd|-S|-s|-e|-es|-E|-Es|-u|-U|-x|-y|-l|--load|--eval|-eval|-f|--funcall|-batch|--batch|--script|--remote-send|--remote-expr|--speller|--rcfile|-plugin)$/;
    const letters = nano ? "sf" : "cSseEuUxyl";
    const runs = args.some((w) => single.test(w.text) || /^(--(eval|load|funcall|cmd|remote-send|remote-expr|speller|rcfile)=)/.test(w.text) || (!nano && /^\+[^\d/?]/.test(w.text)) || (/^-[A-Za-z]{2,}$/.test(w.text) && [...w.text.slice(1)].some((ch) => letters.includes(ch))));
    return runs ? confirm(`${name} com comandos na linha de comando`) : null;
  }

  switch (name) {
    // wrappers: judge the command they run
    case "env": {
      let k = 0;
      while (k < args.length) {
        const t = args[k].text;
        if (t === "-S" || t.startsWith("--split-string")) return confirm("env -S roda um comando em texto");
        if (t === "-u" || t === "-C" || t === "--unset" || t === "--chdir") k += 2;
        else if (t.startsWith("-")) k++;
        else if (/^[A-Za-z_]\w*=/.test(t)) {
          if (DANGEROUS_ENV.test(t.split("=")[0])) return confirm(`muda a variável ${t.split("=")[0]}`);
          k++;
        } else break;
      }
      if (k >= args.length) return confirm("env sem comando mostra as variáveis de ambiente (tokens)");
      return sub(args.slice(k));
    }
    case "printenv":
      return confirm("printenv mostra as variáveis de ambiente (tokens)");
    case "set":
      return args.length ? null : confirm("set sem argumentos mostra as variáveis (tokens)");
    case "unset": case "read": case "mapfile": case "readarray":
      for (const w of operands(args, ["-p", "-d", "-n", "-N", "-t", "-u", "-C", "-c", "-s", "-O"])) ctx.vars.delete(w.text);
      return null;
    case "taskset": case "chrt": {
      if (hasFlag(args, ["--pid"], "p")) return confirm(`${name} -p muda um processo em execução`);
      let k = 0;
      while (k < args.length && isOption(args[k])) k++;
      return k + 1 < args.length ? sub(args.slice(k + 1)) : null; // skip the mask / priority
    }
    case "tmux": {
      // listing and attaching only; anything else can run or type commands (new-session, send-keys…)
      const READ = ["ls", "list-sessions", "list-windows", "lsw", "list-panes", "lsp", "list-clients", "lsc", "has-session", "has", "attach", "attach-session", "a", "at", "list-keys", "lsk", "list-commands", "lscm", "info", "show-options", "show"];
      let k = 0;
      while (k < args.length && isOption(args[k])) {
        if (args[k].text === "-c") return checkNested(args[k + 1]?.text || "", ctx, depth, "tmux -c");
        k += ["-L", "-S", "-f", "-T"].includes(args[k].text) ? 2 : 1;
      }
      const verb = args[k]?.text;
      if (!verb && k === 0) return null;
      return READ.includes(verb) && !args.some((w) => w.text === ";") ? null : confirm(`tmux ${verb || "com opções"} pode rodar ou digitar comandos`);
    }
    case "screen":
      return args.some((w) => ["-ls", "-list", "-r", "-R", "-x", "-v", "--version"].includes(w.text)) && !args.some((w) => ["-X", "-dm", "-dmS", "-Dm", "-d", "-m", "-c"].includes(w.text)) ? null : confirm("screen pode rodar comandos");
    case "script": {
      const c = args.findIndex((w) => /^-[a-zA-Z]*c$/.test(w.text) || w.text === "--command" || w.text.startsWith("--command="));
      if (c >= 0) {
        const r = checkNested(args[c].text.startsWith("--command=") ? args[c].text.slice(10) : args[c + 1]?.text || "", ctx, depth, "script -c");
        if (r) return r;
      }
      const file = operands(args, ["-c", "--command", "-t", "--timing", "-T", "--log-timing", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-E", "--echo", "-m", "--logging-format", "-o", "--output-limit"])[0];
      if (file) return chk.writeTarget(file, "script grava");
      return ctx.cwd ? chk.writeTarget({ text: path.join(ctx.cwd, "typescript"), dynamic: false }, "script grava") : confirm("script grava numa pasta desconhecida");
    }
    case "busybox": case "toybox": {
      if (!args.length || ["--list", "--help", "--list-full"].includes(args[0].text)) return null;
      return isOption(args[0]) ? confirm(`${name} ${args[0].text}`) : sub(args);
    }
    case "docker": case "podman": case "nerdctl": case "docker-compose": case "podman-compose": {
      let k = 0;
      while (k < args.length && isOption(args[k])) {
        if (/^(-H|--host|--context|--url|--connection|--remote)(=|$)/.test(args[k].text)) return confirm(`${name} em outro computador`);
        k += ["--config", "-l", "--log-level", "-f", "--file", "-p", "--project-name", "--env-file", "--profile"].includes(args[k].text) ? 2 : 1;
      }
      let verb = args[k]?.text;
      let rest = args.slice(k + 1);
      if (verb === "compose" || verb === "container") [verb, rest] = [operands(rest, ["-f", "--file", "-p", "--project-name", "--env-file", "--profile"])[0]?.text, rest];
      const compose = name.endsWith("compose") || args[k]?.text === "compose";
      if (["exec", "attach", "cp", "commit", "export", "save", "load", "import", "login", "logout", "push", "debug"].includes(verb)) return confirm(`${name} ${verb} mexe em arquivos do computador, em contêiner já rodando ou na conta`);
      if (compose && ["up", "run", "start", "create", "restart", "watch"].includes(verb)) return confirm(`${name} compose ${verb} pode montar pastas do computador`);
      if (["run", "create"].includes(verb)) {
        const hostAccess = rest.some((w, j) => /^(-v|--volume|--mount|--privileged|--pid|--ipc|--uts|--userns|--device|--cap-add|--security-opt|--volumes-from|--cgroupns)(=|$)/.test(w.text) || /^-[a-zA-Z]*v/.test(w.text) || (/^--(net|network)(=host)?$/.test(w.text) && (w.text.endsWith("=host") || rest[j + 1]?.text === "host")));
        if (hostAccess) return confirm(`${name} ${verb} com acesso a pastas ou recursos do computador`);
      }
      return null;
    }
    case "gio": {
      const verb = args[0]?.text;
      const rest = args.slice(1);
      if (["remove", "rm", "trash"].includes(verb)) return confirm(`apaga arquivos (gio ${verb})`);
      if (verb === "mount") return confirm("gio mount monta ou desmonta");
      if (["copy", "cp"].includes(verb)) return sub([{ ...head, text: "cp" }, ...rest]);
      if (["move", "mv"].includes(verb)) return sub([{ ...head, text: "mv" }, ...rest]);
      if (verb === "rename") {
        const [file, newName] = operands(rest);
        const p = file && chk.resolve(file);
        if (!p || !ctx.isWorkPath(p)) return confirm(`renomeia um arquivo de fora das pastas de trabalho (${file?.text || ""})`);
        return newName ? chk.writeTarget({ text: path.join(path.dirname(p), newName.text), dynamic: newName.dynamic }, "gio rename") : null;
      }
      if (["save", "set"].includes(verb)) {
        const file = operands(rest, ["-t", "--type"])[0];
        return file ? chk.writeTarget(file, `gio ${verb}`) : confirm(`gio ${verb} sem arquivo`);
      }
      return null;
    }
    case "kioclient": case "kioclient5": case "kioclient6": {
      const ops = operands(args);
      const verb = ops[0]?.text;
      if (["remove", "rm", "del", "move", "mv"].includes(verb)) return confirm(`apaga ou move arquivos (${name} ${verb})`);
      if (["copy", "cp"].includes(verb)) return ops.length > 2 ? chk.writeTarget(ops.at(-1), "cópia") : null;
      return null;
    }
    case "gpg": case "gpg2":
      return args.some((w) => /^--export-secret/.test(w.text)) ? confirm("gpg exporta chaves secretas") : null;
    case "nmcli": {
      if (hasFlag(args, ["--show-secrets"], "s")) return confirm("nmcli --show-secrets mostra senhas de rede");
      const [obj, verb, ...more] = operands(args, ["-f", "--fields", "-g", "--get-values", "-m", "--mode", "-c", "--colors", "-e", "--escape", "-w", "--wait"]).map((w) => w.text);
      const is = (word, full) => word && full.startsWith(word);
      if (is(obj, "device") && is(verb, "wifi") && is(more[0], "show-password")) return confirm("nmcli device wifi show-password mostra a senha do Wi-Fi");
      if (is(obj, "connection") && (["modify", "delete", "down", "up", "add", "edit", "clone", "import", "load", "reload"].some((v) => is(verb, v)) || (is(verb, "show") && more.some((x) => x === "-s" || x === "--show-secrets"))))
        return confirm(`nmcli connection ${verb} altera a rede`);
      if (is(obj, "radio") && more.concat(verb ? [verb] : []).some((x) => x === "on" || x === "off")) return confirm("nmcli radio liga ou desliga o rádio");
      if ((is(obj, "networking") && ["on", "off"].includes(verb)) || (is(obj, "general") && ["hostname", "logging", "reload"].some((v) => is(verb, v)) && more.length) || (is(obj, "device") && ["set", "connect", "disconnect", "delete", "modify", "reapply", "up", "down"].some((v) => is(verb, v))) || (is(obj, "device") && is(verb, "wifi") && ["connect", "hotspot"].some((v) => is(more[0], v))))
        return confirm(`nmcli ${obj} ${verb} altera a rede`);
      return null;
    }
    case "gdbus":
      return ["call", "emit"].includes(args[0]?.text) ? confirm(`gdbus ${args[0].text} manda uma mensagem a outro programa`) : null;
    case "dbus-send":
      return confirm("dbus-send manda uma mensagem a outro programa");
    case "busctl": {
      const verb = operands(args, ["-H", "--host", "-M", "--machine", "--destination", "--match", "--size", "--timeout", "--json", "--augment-creds"])[0]?.text;
      if (hasFlag(args, ["--host"], "H")) return confirm("busctl em outro computador");
      return ["call", "set-property", "emit", "wait"].includes(verb) ? confirm(`busctl ${verb} manda uma mensagem a outro programa`) : null;
    }
    case "dconf":
      return ["write", "reset", "load", "update", "compile"].includes(args[0]?.text) ? confirm(`dconf ${args[0].text} altera as configurações`) : null;
    case "gsettings": {
      const verb = operands(args, ["--schemadir"])[0]?.text;
      return ["set", "reset", "reset-recursively"].includes(verb) ? confirm(`gsettings ${verb} altera as configurações`) : null;
    }
    case "rfkill":
      return !args.length || ["list", "--help", "-h", "--version", "-V", "event"].includes(operands(args, ["-o", "--output"])[0]?.text ?? args[0].text) ? null : confirm("rfkill liga ou desliga rádios");
    case "xdg-settings":
      return args[0]?.text === "set" ? confirm("xdg-settings set troca os programas padrão") : null;
    case "loginctl": case "hostnamectl": case "timedatectl": {
      const verb = operands(args, ["-H", "--host", "-M", "--machine", "-p", "--property", "-o", "--output", "-n", "--lines"])[0]?.text;
      if (hasFlag(args, ["--host"], "H")) return confirm(`${name} em outro computador`);
      return !verb || /^(list|show|status|session-status|user-status|seat-status|timesync-status|show-timesync)/.test(verb) ? null : confirm(`${name} ${verb} altera o sistema`);
    }
    case "setfacl": {
      if (hasFlag(args, ["--recursive"], "R")) return confirm("setfacl -R");
      for (const f of operands(args, ["-m", "-M", "-x", "-X", "--modify", "--modify-file", "--remove", "--remove-file", "--set", "--set-file"])) {
        const r = chk.writeTarget(f, "setfacl muda permissões");
        if (r) return r;
      }
      return null;
    }
    case "sort": {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        const out = t === "-o" || t === "--output" ? args[k + 1] : t.startsWith("--output=") ? { ...args[k], text: t.slice(9) } : /^-[^-]*o./.test(t) && !/^-[^-]*o$/.test(t) ? { ...args[k], text: t.slice(t.indexOf("o") + 1) } : /^-[^-]*o$/.test(t) && t !== "-o" ? args[k + 1] : null;
        if (out) {
          const r = chk.writeTarget(out, "sort -o grava");
          if (r) return r;
        }
      }
      return null;
    }
    case "uniq": {
      const out = operands(args, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])[1];
      return out ? chk.writeTarget(out, "uniq grava") : null;
    }
    case "split": case "csplit": {
      if (args.some((w) => w.text.startsWith("--filter"))) return confirm("split --filter roda um comando");
      if (name === "csplit") {
        const k = args.findIndex((w) => w.text === "-f" || w.text.startsWith("--prefix"));
        const prefix = k < 0 ? null : args[k].text.includes("=") ? { ...args[k], text: args[k].text.split("=")[1] } : args[k + 1];
        return prefix ? chk.writeTarget(prefix, "csplit grava") : ctx.cwd ? chk.writeTarget({ text: path.join(ctx.cwd, "xx00"), dynamic: false }, "csplit grava") : confirm("csplit grava numa pasta desconhecida");
      }
      const ops = operands(args, ["-a", "-b", "-C", "-l", "-n", "-t", "--suffix-length", "--bytes", "--line-bytes", "--lines", "--number", "--separator", "--additional-suffix", "--numeric-suffixes", "--hex-suffixes"]);
      const prefix = ops[1] || (ctx.cwd ? { text: path.join(ctx.cwd, "x"), dynamic: false } : null);
      return prefix ? chk.writeTarget(prefix, "split grava") : confirm("split grava numa pasta desconhecida");
    }
    case "convert": case "magick": case "ffmpeg": case "mogrify": {
      // ImageMagick writes the last operand (and -write targets); mogrify rewrites its inputs; ffmpeg's last word is the output
      const outs = [];
      for (let k = 0; k < args.length; k++) if (args[k].text === "-write" || args[k].text === "+write") outs.push(args[k + 1]);
      if (name === "mogrify") outs.push(...args.filter((w, k) => !isOption(w) && (k === 0 || !isOption(args[k - 1]) || /[./]/.test(w.text)) && /[./]/.test(w.text)));
      else if (args.length && !isOption(args.at(-1)) && !(name === "magick" && args.length === 1)) outs.push(args.at(-1));
      for (const f of outs.filter(Boolean)) {
        if (/^-$|^(png|jpe?g|gif|pdf|webp|tiff?|bmp|ppm|miff|info|null):-?$/i.test(f.text)) continue; // stdout
        const r = chk.writeTarget(f, `${name} grava`);
        if (r) return r;
      }
      return null;
    }
    case "nice": case "nohup": case "command": case "builtin": case "exec": case "setsid": case "stdbuf": case "ionice": case "unbuffer": case "time": {
      if (name === "command" && args.some((w) => w.text === "-v" || w.text === "-V")) return null;
      const withArg = { nice: ["-n"], exec: ["-a"], ionice: ["-c", "-n", "-t"], stdbuf: ["-i", "-o", "-e"] }[name] || [];
      let k = 0;
      while (k < args.length && isOption(args[k])) k += withArg.includes(args[k].text) ? 2 : 1;
      return sub(args.slice(k));
    }
    case "timeout": {
      let k = 0;
      while (k < args.length && isOption(args[k])) k += ["-s", "-k", "--signal", "--kill-after"].includes(args[k].text) ? 2 : 1;
      return sub(args.slice(k + 1)); // skip the duration
    }
    case "xargs": case "parallel": {
      const withArg = ["-I", "-n", "-P", "-L", "-l", "-s", "-d", "-E", "-e", "-a", "-j", "--max-args", "--max-procs", "--delimiter", "--arg-file", "-S", "--sshlogin"];
      let k = 0;
      while (k < args.length && (isOption(args[k]) || /^-I./.test(args[k].text))) {
        if (["-S", "--sshlogin", "--sshloginfile"].includes(args[k].text)) return confirm("parallel em outro computador");
        k += withArg.includes(args[k].text) ? 2 : 1;
      }
      const end = args.findIndex((w, j) => j >= k && [":::", "::::", ":::+"].includes(w.text));
      const inner = args.slice(k, end < 0 ? undefined : end);
      return inner.length ? sub(inner) : null;
    }
    case "watch": {
      let k = 0;
      while (k < args.length && isOption(args[k])) k += ["-n", "--interval", "-d"].includes(args[k].text) && args[k].text !== "-d" ? 2 : 1;
      return checkNested(args.slice(k).map((w) => w.text).join(" "), ctx, depth, "watch");
    }
    case "flock": {
      const ops = operands(args, ["-w", "-E", "--timeout", "--conflict-exit-code"]);
      if (args.some((w) => w.text === "-c" || w.text === "--command")) return confirm("flock -c roda um comando em texto");
      return ops.length > 1 ? sub(ops.slice(1)) : null;
    }
    case "export": case "declare": case "typeset": case "local": case "readonly": {
      for (const w of args) if (/^[A-Za-z_]\w*=/.test(w.text) && DANGEROUS_ENV.test(w.text.split("=")[0])) return confirm(`muda a variável ${w.text.split("=")[0]}`);
      // with no name they print every variable (or -p): tokens of the environment
      if (!args.some((w) => !isOption(w)) && !hasFlag(args, [], "fF")) return confirm(`${name} sem nome mostra as variáveis (tokens)`);
      for (const w of args) if (isAssignment(w)) chk.assign(w);
      return null;
    }
    case "hash":
      return args.some((w) => w.text.startsWith("-p")) ? confirm("hash -p troca o programa de um comando") : null;
    case "cd": case "pushd": {
      const target = operands(args)[0];
      if (!target) ctx.cwd = name === "cd" ? ctx.home : null;
      else if (target.text === "-" || target.dynamic) ctx.cwd = null;
      else ctx.cwd = path.isAbsolute(target.text) ? path.normalize(target.text) : ctx.cwd && path.resolve(ctx.cwd, target.text);
      return null;
    }
    case "popd":
      ctx.cwd = null;
      return null;
    case "source": case ".": {
      const file = operands(args)[0];
      if (!file) return null;
      const p = chk.resolve(file);
      if (!p || !ctx.isWorkPath(p)) return confirm(`carrega um script de fora das pastas de trabalho (${file.text})`);
      return chk.runTarget(file, "script");
    }
    case "find": {
      const k = args.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w.text));
      if (args.some((w) => w.text === "-delete")) return confirm("find -delete apaga arquivos");
      if (args.some((w) => /^-f(print|print0|printf|ls)$/.test(w.text))) return confirm("find grava em arquivo");
      if (k >= 0) {
        const end = args.findIndex((w, j) => j > k && (w.text === ";" || w.text === "+"));
        const inner = args.slice(k + 1, end < 0 ? undefined : end).filter((w) => w.text !== "{}");
        const r = sub(inner);
        if (r || end < 0) return r;
        return sub([head, ...args.slice(end + 1)]); // a later -exec

      }
      return null;
    }
    case "git":
      return checkGit(args, chk, ctx);
    case "gh":
      return checkGh(args);
    case "curl":
      return checkCurl(args, chk, ctx);
    case "wget": {
      if (args.some((w) => /^--(post-data|post-file|body-data|body-file)/.test(w.text))) return confirm("wget envia dados");
      const method = args.find((w) => w.text.startsWith("--method"));
      if (method) {
        const v = method.text.includes("=") ? method.text.split("=")[1] : args[args.indexOf(method) + 1]?.text;
        if (!/^(GET|HEAD)$/i.test(v || "")) return confirm(`wget com método ${v}`);
      }
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        const out = t === "-O" || t === "--output-document" || t === "-P" || t === "--directory-prefix" ? args[k + 1] : /^(--output-document|--directory-prefix)=/.test(t) ? { ...args[k], text: t.split("=")[1] } : /^-O./.test(t) ? { ...args[k], text: t.slice(2) } : null;
        if (out && out.text !== "-") {
          const r = chk.writeTarget(out, "download");
          if (r) return r;
        }
      }
      return null;
    }
    case "rsync": {
      if (args.some((w) => !isOption(w) && (REMOTE_PATH.test(w.text) || w.text.startsWith("rsync://")))) return confirm("rsync para ou de outro computador");
      if (hasFlag(args, ["--delete", "--delete-before", "--delete-after", "--delete-during", "--remove-source-files"])) return confirm("rsync apaga arquivos");
      if (hasFlag(args, ["--rsh"], "e")) return confirm("rsync -e roda um comando");
      const ops = operands(args);
      return ops.length > 1 ? chk.writeTarget(ops.at(-1), "cópia") : null;
    }
    case "cp": case "mv": case "install": case "ln": {
      if (name === "cp" && hasFlag(args, ["--recursive", "--archive"], "rRa")) {
        const r = chk.mentions(args, true);
        if (r) return r;
      }
      const tIdx = args.findIndex((w) => w.text === "-t" || w.text.startsWith("--target-directory"));
      let ops = operands(args, ["-t", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]);
      let dest;
      if (tIdx >= 0) dest = args[tIdx].text.includes("=") ? { ...args[tIdx], text: args[tIdx].text.split("=")[1] } : args[tIdx + 1];
      else if (ops.length > 1 || name === "ln") [dest, ops] = [ops.at(-1), ops.slice(0, -1)];
      if (!dest) return null;
      if (name === "mv") {
        for (const src of ops) {
          const p = chk.resolve(src);
          if (!p || !ctx.isWorkPath(p)) return confirm(`move um arquivo de fora das pastas de trabalho (${src.text})`);
        }
      }
      return chk.writeTarget(dest, name === "ln" ? "link" : name === "mv" ? "destino" : "cópia");
    }
    case "tee": case "touch": {
      for (const f of operands(args, ["-d", "-r", "-t", "--reference", "--date"])) {
        const r = chk.writeTarget(f, name === "tee" ? "tee grava" : "touch");
        if (r) return r;
      }
      return null;
    }
    case "sed": {
      const scripts = [];
      for (let k = 0; k < args.length; k++) if (args[k].text === "-e" || args[k].text === "--expression") scripts.push(args[k + 1]?.text || "");
      const hasF = args.some((w) => w.text === "-f" || w.text.startsWith("--file"));
      let ops = operands(args, ["-e", "--expression", "-f", "--file", "-l", "-s"]);
      if (!scripts.length && !hasF) [scripts[0], ops] = [ops[0]?.text || "", ops.slice(1)];
      if (hasF) return confirm("sed com script em arquivo");
      if (scripts.some((s) => /\/[gpIiMm\d]*e[gpIiMm\d]*(\s|;|}|$)|(^|[;{}\s])e(\s|;|$)|(^|[;{}\s\d$\/])[wW]\s+\S|\/[gpIiMme\d]*w\s+\S/.test(s))) return confirm("sed pode executar ou gravar arquivos");
      if (hasFlag(args, ["--in-place"], "i")) {
        for (const f of ops) {
          const r = chk.writeTarget(f, "sed -i altera");
          if (r) return r;
        }
      }
      return null;
    }
    case "awk": case "gawk": case "mawk": case "nawk": {
      if (args.some((w) => w.text === "-f" || w.text.startsWith("--file"))) return confirm("awk com programa em arquivo");
      const prog = operands(args, ["-F", "-v", "--assign", "--field-separator"])[0]?.text || "";
      if (/system\s*\(|\|\s*getline|\|&|print[f]?\b[^;{}]*(>|\|)/.test(prog)) return confirm("awk pode executar ou gravar arquivos");
      return null;
    }
    case "chmod": {
      if (hasFlag(args, ["--recursive"], "R")) return confirm("chmod -R");
      // the mode is the first operand, unless given as an option (-x) or taken from --reference
      const modeAsOption = args.some((w) => /^-[rwxXstugoa=+0-7,]+$/.test(w.text) && !/^-[cfv]+$/.test(w.text));
      const ops = operands(args.filter((w) => !/^-[rwxXstugoa=+0-7,]+$/.test(w.text) || /^-[cfv]+$/.test(w.text)));
      for (const f of modeAsOption || args.some((w) => w.text.startsWith("--reference")) ? ops : ops.slice(1)) {
        const r = chk.writeTarget(f, "chmod muda permissões");
        if (r) return r;
      }
      return null;
    }
    case "tar": {
      const first = args[0]?.text || "";
      const extract = hasFlag(args, ["--extract", "--get"]) || (/^-?[A-Za-z]+$/.test(first) && !first.startsWith("--") && first.replace("-", "").includes("x"));
      const create = hasFlag(args, ["--create", "--append", "--update"]) || (/^-?[A-Za-z]+$/.test(first) && /[cru]/.test(first.replace("-", "")));
      if (hasFlag(args, ["--to-command", "--use-compress-program", "--checkpoint-action", "--rsh-command", "--info-script", "--new-volume-script"], "I")) return confirm("tar roda um comando");
      if (hasFlag(args, ["--remove-files"])) return confirm("tar --remove-files apaga os originais");
      const r = chk.mentions(args, true);
      if (r) return r;
      if (extract) {
        const k = args.findIndex((w) => w.text === "-C" || w.text.startsWith("--directory"));
        const dir = k < 0 ? (ctx.cwd ? { text: ctx.cwd, dynamic: false } : null) : args[k].text.includes("=") ? { ...args[k], text: args[k].text.split("=")[1] } : args[k + 1];
        return dir ? chk.writeTarget(dir, "extração") : confirm("tar extrai numa pasta desconhecida");
      }
      if (create) {
        const k = args.findIndex((w) => w.text === "-f" || w.text.startsWith("--file") || (/^-?[A-Za-z]*f$/.test(w.text) && w === args[0]));
        const file = k < 0 ? null : args[k].text.includes("=") ? { ...args[k], text: args[k].text.split("=")[1] } : args[k + 1];
        if (file && file.text !== "-") return chk.writeTarget(file, "arquivo tar");
      }
      return null;
    }
    case "unzip": {
      const k = args.findIndex((w) => w.text === "-d");
      if (args.some((w) => w.text === "-l" || w.text === "-t" || w.text === "-Z" || w.text === "-p")) return null;
      const dir = k >= 0 ? args[k + 1] : ctx.cwd ? { text: ctx.cwd, dynamic: false } : null;
      return dir ? chk.writeTarget(dir, "extração") : confirm("unzip extrai numa pasta desconhecida");
    }
    case "zip": {
      if (hasFlag(args, ["--move"], "m")) return confirm("zip -m apaga os originais");
      const r = chk.mentions(args, true);
      if (r) return r;
      const out = operands(args)[0];
      return out ? chk.writeTarget(out, "arquivo zip") : null;
    }
    case "patch":
      return args.some((w) => w.text === "--dry-run") ? null : confirm("patch altera arquivos");
    case "grep": case "egrep": case "fgrep":
      return chk.mentions(args, hasFlag(args, ["--recursive", "--dereference-recursive"], "rR"));
    case "rg": case "ag": case "ack":
      return chk.mentions(args, true);
    case "npm": case "pnpm": case "yarn": case "bun": {
      const verb = operands(args, ["--prefix", "-C", "--cwd"])[0]?.text;
      const global = hasFlag(args, ["--global", "--location"], "g") || verb === "global";
      if (["publish", "unpublish", "deprecate", "owner", "adduser", "login", "token", "access", "dist-tag", "link"].includes(verb)) return confirm(`${name} ${verb} publica ou mexe na conta`);
      if (["exec", "dlx", "x", "create", "init"].includes(verb) && !(name === "npm" && verb === "init" && !operands(args)[1])) return confirm(`${name} ${verb} baixa e executa um pacote`);
      if (global && ["i", "install", "add", "remove", "uninstall", "rm", "un", "update", "upgrade", "global"].includes(verb)) return confirm(`${name} instala ou remove globalmente`);
      if (name === "bun" && verb && !["run", "test", "install", "i", "add", "remove", "update", "build", "pm"].includes(verb)) return checkInterpreter("bun", args, chk);
      return null;
    }
    case "pip": case "pip3": case "pipx": case "uv": case "cargo": case "gem": case "go": case "brew": case "conda": case "mamba": case "flatpak": case "snap": {
      const ops = operands(args).map((w) => w.text);
      const risky = {
        pip: ["install", "uninstall"], pip3: ["install", "uninstall"], pipx: ["install", "uninstall", "run", "inject", "reinstall", "upgrade"],
        cargo: ["install", "uninstall"], gem: ["install", "uninstall", "update"], go: ["install"], brew: ["install", "uninstall", "remove", "upgrade", "reinstall"],
        conda: ["install", "remove", "uninstall", "update", "create"], mamba: ["install", "remove", "uninstall", "update", "create"],
        flatpak: ["install", "uninstall", "remove", "update", "upgrade", "repair", "override", "remote-add"], snap: ["install", "remove", "refresh", "revert"],
      }[name];
      if (name === "uv") return (ops[0] === "pip" && ["install", "uninstall"].includes(ops[1])) || (ops[0] === "tool" && ["install", "uninstall", "run"].includes(ops[1])) ? confirm("uv instala ou executa pacotes") : null;
      return risky.includes(ops[0]) ? confirm(`${name} ${ops[0]} instala ou remove pacotes`) : null;
    }
    case "rpm":
      return args.length && args.every((w) => !isOption(w) || /^-(q|V)|^--(query|verify|version|help)/.test(w.text)) && /^-(q|V)|^--(query|verify|version|help)/.test(args[0].text) ? null : confirm("rpm instala ou remove pacotes");
    case "dpkg": case "dpkg-query":
      return args.some((w) => /^(-[lLsSpcI]|--(list|listfiles|status|search|print-avail|contents|info|version|help))/.test(w.text)) && !args.some((w) => /^(-[irPP]|--(install|remove|purge|unpack|configure))/.test(w.text)) ? null : confirm("dpkg instala ou remove pacotes");
    case "pacman":
      return /^-(Q|Ss|Si|F|Sl|Sg|T|V|h)/.test(args[0]?.text || "") || args[0]?.text === "--version" ? null : confirm("pacman instala ou remove pacotes");
  }
  if (SYS_PACKAGES.includes(name)) {
    const verb = operands(args)[0]?.text ?? args[0]?.text;
    return SYS_PACKAGE_READ.has(verb) ? null : confirm(`${name} ${verb || ""} instala ou remove pacotes`.replace("  ", " "));
  }
  if (isInterpreter(name)) return checkInterpreter(name, args, chk, cmd);
  if (NO_EXEC.has(name)) return null;
  // An unknown program may run what it is given: a listed command among its operands, whatever
  // follows "--", or a quoted command line, is judged as if run directly.
  const dd = args.findIndex((w) => w.text === "--");
  if (dd >= 0 && dd + 1 < args.length) {
    const r = sub(args.slice(dd + 1));
    if (r) return r;
  }
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (w.dynamic) continue;
    if (!isOption(w) && isListed(path.basename(w.text))) {
      const r = sub(args.slice(k));
      if (r) return r;
    }
    if (w.quoted && /\s/.test(w.text)) {
      const r = checkNested(w.text, ctx, depth, name, true);
      if (r) return r;
    }
  }
  return null;
}

/** A name from the fixed lists: something that deletes, changes the system, sends, reveals secrets or runs code. */
function isListed(n) {
  return [DELETE, SYSTEM, REMOTE, SECRETS, RUNNERS, BUILTINS, DIRECT_RUNNERS, SYS_PACKAGES, TERMINALS].some((l) => l.includes(n)) || isInterpreter(n) || n in WRAPPERS || /^mkfs(\.|$)/.test(n) || ["xargs", "env", "exec", "nohup", "setsid", "timeout", "find", "git", "curl", "wget", "rsync", "busybox", "toybox", "docker", "podman", "tmux", "screen", "gio", "kioclient"].includes(n);
}

function checkInterpreter(name, args, chk, cmd = {}) {
  const inline = SHELLS.includes(name) ? "c" : isPython(name) ? "c" : INTERPRETERS[name] ?? "";
  const longInline = ["--eval", "--print", "--command", "-Command", "-EncodedCommand", "-command"];
  const withArg = isPython(name) ? ["-W", "-X", "-Q"] : name === "node" || name === "nodejs" ? ["-r", "--require", "--import", "--loader", "--input-type", "--env-file"] : name === "php" ? ["-d", "-c"] : SHELLS.includes(name) ? ["-o", "+O", "-O"] : [];
  if (name === "deno") {
    const verb = args[0]?.text;
    if (verb === "eval" || verb === "repl") return confirm("deno eval roda código inline");
    if (["run", "test", "task", "serve"].includes(verb)) {
      const script = operands(args.slice(1))[0];
      return script ? chk.runTarget(script, "script") : null;
    }
    return null;
  }
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (!t.startsWith("-") || t === "-" || t === "--") break;
    if (longInline.some((l) => t === l || t.startsWith(`${l}=`))) return confirm(`${name} ${t} roda código inline`);
    if (!t.startsWith("--") && inline && [...t.slice(1)].some((ch) => inline.includes(ch))) return confirm(`${name} ${t} roda código inline`);
    if (isPython(name) && t === "-m") {
      const mod = args[k + 1]?.text || "";
      if (PYTHON_SERVERS.has(mod)) return confirm(`python -m ${mod} abre um servidor com os arquivos deste computador`);
      if (mod === "pip" || mod === "pip3") return checkCommand({ words: [{ text: "pip", dynamic: false }, ...args.slice(k + 2)], redirects: [] }, chk.ctx, chk);
      return PYTHON_MODULES.has(mod) ? null : confirm(`python -m ${mod} pode rodar um módulo criado nesta tarefa`);
    }
    if ((name === "node" || name === "nodejs") && (t === "-r" || t === "--require" || t === "--import")) {
      const r = chk.runTarget(args[k + 1] || { text: "", dynamic: true }, "módulo");
      if (r) return r;
    }
    if (withArg.includes(t)) k++;
  }
  const ops = operands(args, withArg);
  const script = ops[0];
  const only = args.every((w) => ["--version", "-V", "-v", "--help", "-h"].includes(w.text));
  if (!script || script.text === "-") {
    if (only && args.length) return null;
    return confirm(`${name} lendo código da entrada (pipe ou redirecionamento)`);
  }
  if (name === "php" && args.some((w) => w.text === "-S")) return confirm("php -S abre um servidor com os arquivos deste computador");
  if (name === "php" && args.some((w) => w.text === "-a")) return confirm("php interativo");
  return chk.runTarget(script, "script");
}

function checkGit(args, chk, ctx) {
  let k = 0;
  let where = ctx.cwd; // the repository the command acts on (-C changes it; null: unknown)
  while (k < args.length && isOption(args[k])) {
    const t = args[k].text;
    if (t === "-c" || t.startsWith("--config-env") || t.startsWith("--exec-path")) return confirm("git -c pode rodar comandos");
    if (t === "-C") {
      const d = args[k + 1];
      where = !d || d.dynamic ? null : path.isAbsolute(d.text) ? path.normalize(d.text) : where && path.resolve(where, d.text);
    }
    if (/^--(git-dir|work-tree)/.test(t)) where = null;
    k += t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" ? 2 : 1;
  }
  const verb = args[k]?.text;
  const rest = args.slice(k + 1);
  const has = (...f) => rest.some((w) => f.includes(w.text));
  if (verb === "credential" || verb?.startsWith("credential-")) return confirm("git credential lê ou grava senhas");
  // commands that rewrite the files of the working tree: only inside the work folders
  const changesTree = ["apply", "am", "checkout", "switch", "merge", "pull", "rebase", "cherry-pick", "revert", "reset"].includes(verb) || (verb === "stash" && !["list", "show", "create", "store", "drop", "clear"].includes(operands(rest, ["-m", "--message", "--pathspec-from-file"])[0]?.text)); // stash (push), pop, apply, branch
  if (changesTree && !(verb === "apply" && has("--check", "--stat", "--numstat", "--summary"))) {
    if (!where) return confirm(`git ${verb} muda arquivos numa pasta que o app não conhece`);
    if (!ctx.isWorkPath(where)) return confirm(`git ${verb} muda arquivos fora das pastas de trabalho (${where})`);
  }
  switch (verb) {
    case "push": case "send-email":
      return confirm(`git ${verb} publica`);
    case "clean": case "rm": case "filter-branch": case "filter-repo": case "prune":
      return confirm(`git ${verb} apaga`);
    case "reset":
      return has("--hard", "--merge", "--keep") ? confirm("git reset descarta mudanças") : null;
    case "checkout":
      return has("--", ".", "-f", "--force") ? confirm("git checkout descarta mudanças") : null;
    case "restore":
      return has("--staged", "-S") && !has("--worktree", "-W") ? null : confirm("git restore descarta mudanças");
    case "switch":
      return has("--discard-changes", "-f", "--force") ? confirm("git switch descarta mudanças") : null;
    case "branch":
      return has("-D", "-M") || (has("-d", "--delete") && has("-f", "--force")) ? confirm("git branch apaga um branch") : null;
    case "stash":
      return ["drop", "clear"].includes(rest[0]?.text) ? confirm(`git stash ${rest[0].text} apaga`) : null;
    case "reflog":
      return ["expire", "delete"].includes(rest[0]?.text) ? confirm("git reflog apaga") : null;
    case "update-ref":
      return has("-d") ? confirm("git update-ref apaga") : null;
    case "worktree": case "submodule":
      return ["remove", "prune", "deinit"].includes(rest[0]?.text) ? confirm(`git ${verb} ${rest[0].text} apaga`) : null;
    case "config": {
      if (has("--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin")) return null;
      return operands(rest).length <= 1 && !has("--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--remove-section", "--rename-section") ? null : confirm("git config pode definir comandos");
    }
  }
  return null;
}

function checkGh(args) {
  const [a, b] = operands(args, ["-R", "--repo"]).map((w) => w.text);
  if (["status", "search", "browse", "help", "version", "--version"].includes(a) || args[0]?.text === "--version") return null;
  if (a === "auth" && b === "status") return null;
  if (a === "release") return confirm("gh release publica");
  if (a === "api") {
    const m = args.findIndex((w) => w.text === "-X" || w.text === "--method");
    const method = m >= 0 ? args[m + 1]?.text : args.find((w) => /^(-X|--method=)/.test(w.text) && w.text.length > 2)?.text.replace(/^(-X|--method=)/, "");
    if ((method && !/^GET$/i.test(method)) || args.some((w) => /^(-f|-F|--field|--raw-field|--input)/.test(w.text))) return confirm("gh api altera dados");
    return null;
  }
  if (["list", "view", "status", "diff", "checks"].includes(b)) return null;
  return confirm(`gh ${[a, b].filter(Boolean).join(" ")} pode publicar ou alterar`);
}

function checkCurl(args, chk, ctx) {
  const SHORT_ARG = "dFTXoHAbcCeuxwrmKEyYzDPQtU";
  const check = (flag, value) => {
    if (["d", "F", "T"].includes(flag)) return confirm(`curl -${flag} envia dados`);
    if (flag === "K") return confirm("curl -K lê opções de um arquivo");
    if (flag === "X" && !/^(GET|HEAD)$/i.test(value || "")) return confirm(`curl com método ${value}`);
    if (flag === "o" && value && value !== "-") return chk.writeTarget({ text: value, dynamic: false }, "download");
    if (flag === "O") return ctx.cwd ? chk.writeTarget({ text: ctx.cwd, dynamic: false }, "download") : confirm("curl -O grava numa pasta desconhecida");
    return null;
  };
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t.startsWith("--")) {
      const [opt, eq] = t.split(/=(.*)/s);
      const value = eq ?? args[k + 1]?.text;
      if (/^--(data|json|form|upload-file)/.test(opt)) return confirm(`curl ${opt} envia dados`);
      if (opt === "--config") return check("K");
      if (opt === "--request") {
        const r = check("X", value);
        if (r) return r;
      }
      if (opt === "--output") {
        const r = check("o", value);
        if (r) return r;
      }
      if (opt === "--remote-name" || opt === "--remote-name-all") {
        const r = check("O");
        if (r) return r;
      }
      if (/^--(output-dir)$/.test(opt) && value) {
        const r = chk.writeTarget({ text: value, dynamic: false }, "download");
        if (r) return r;
      }
    } else if (t.startsWith("-") && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const flag = t[j];
        if (SHORT_ARG.includes(flag)) {
          const value = t.slice(j + 1) || args[k + 1]?.text;
          const r = check(flag, value);
          if (r) return r;
          if (!t.slice(j + 1)) k++;
          break;
        }
        const r = check(flag);
        if (r) return r;
      }
    }
  }
  return null;
}

/** Parses and checks a whole command line. ctx as in makeChecker, plus `cwd` updated by cd. */
function checkScript(src, ctx, depth = 0, via = "") {
  let parsed;
  try {
    parsed = parse(src, ctx.home);
  } catch (e) {
    return confirm(`não consegui analisar o comando (${e.message})`);
  }
  if (parsed.substitution) return confirm("usa substituição de comando ($(…) ou crases)");
  if (parsed.funcDef) return confirm("define uma função");
  const chk = makeChecker(ctx);
  chk.ctx = ctx;
  for (const cmd of parsed.commands) {
    // control-flow words around the real command
    let words = cmd.words;
    while (words.length && KEYWORDS.has(words[0].text) && !words[0].quoted) words = words.slice(1);
    if (words.length && ["for", "select"].includes(words[0].text) && !words[0].quoted) {
      // for NAME in LIST: NAME takes the values of the list (checked like any argument)
      const list = words[2]?.text === "in" ? words.slice(3) : null;
      const m = list && chk.mentions(list, false);
      if (m) return m;
      const values = list?.map((w) => chk.expandWord(w));
      if (words[1] && values && values.every(Boolean)) ctx.vars.set(words[1].text, values.flat());
      else if (words[1]) ctx.vars.delete(words[1].text);
      continue;
    }
    if (words.length && ["case", "in"].includes(words[0].text) && !words[0].quoted) words = [];
    const c = { ...cmd, words };
    for (const r of cmd.redirects) {
      if (r.op === "<<<") continue;
      if (/^</.test(r.op) && r.op !== "<>") {
        if (r.target.dynamic && !chk.expandWord(r.target)) return confirm(`lê de uma variável de valor desconhecido (${r.target.text})`);
        const m = chk.mentions([r.target], false);
        if (m) return m;
        continue;
      }
      if (/&$/.test(r.op) && /^(\d+|-)$/.test(r.target.text)) continue; // >&2
      const w = chk.writeTarget(r.target, "redirecionamento");
      if (w) return w;
    }
    // NAME=value words before the command are checked as values too, not skipped as its name
    const n = words.findIndex((w) => !(isAssignment(w) && !w.quoted));
    const assigns = n < 0 ? words : words.slice(0, n);
    const rest = n < 0 ? [] : words.slice(n);
    const m = chk.mentions([...assigns, ...rest.slice(1)], false);
    if (m) return m;
    if (rest.length && !VAR_SAFE.has(path.basename(rest[0].text))) {
      const unknown = rest.slice(1).find((w) => w.dynamic && !chk.expandWord(w));
      if (unknown) return confirm(`usa uma variável de valor desconhecido (${unknown.text})`);
    }
    if (words.length && isInterpreter(path.basename(words[0].text)) && (cmd.piped || cmd.stdin) && !words.slice(1).some((w) => !isOption(w))) {
      return confirm(`${path.basename(words[0].text)} recebe código por pipe ou redirecionamento`);
    }
    const r = checkCommand(c, ctx, chk, depth);
    if (r) return via ? confirm(`${via}: ${r.reason}`) : r;
    if (!rest.length) for (const w of assigns) chk.assign(w); // a bare NAME=value lasts for the next commands
  }
  return null;
}

/**
 * Checks text another program will run as a command line (tmux 'cmd', a terminal's -e "cmd",
 * script -c, watch). A cd or an assignment in there doesn't change the outer command's folder or
 * variables. `lenient`: text that doesn't parse as a command line is taken as plain data.
 */
function checkNested(src, ctx, depth, via, lenient = false) {
  if (lenient) {
    try {
      parse(src, ctx.home);
    } catch {
      return null;
    }
  }
  const saved = { cwd: ctx.cwd, vars: new Map(ctx.vars) };
  try {
    return checkScript(src, ctx, depth + 1, via);
  } finally {
    Object.assign(ctx, saved);
  }
}

/**
 * Decision for a Bash command: { decision: "allow" | "confirm", reason, writes }.
 * opts: { home, sensitivity(abs), sensitiveName(name), isWorkPath(abs), isSessionFile(abs), extraPatterns }.
 */
function classifyBash(command, opts) {
  const ctx = { ...opts, cwd: null, written: new Set(), vars: new Map(), extraPatterns: opts.extraPatterns || [] };
  if (typeof command !== "string" || !command.trim()) return { decision: "confirm", reason: "comando vazio", writes: [] };
  const r = checkScript(command, ctx);
  return { decision: r ? "confirm" : "allow", reason: r?.reason || null, writes: [...ctx.written] };
}

module.exports = { classifyBash, parse, RULES };
