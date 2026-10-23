#!/usr/bin/env bash
# Dev tool: screenshots every DronsioFlow page from a test instance with CDP on port $PORT.
# Usage: shoot_all.sh <outdir> [theme...]
OUT="$1"; shift; PORT="${PORT:-9444}"
SHOT="$(dirname "$0")/cdp_shot.mjs"
mkdir -p "$OUT"
for theme in "${@:-light}"; do
  timeout 20 node "$SHOT" "$PORT" DronsioFlow - "window.dronsio.setSettings({theme:'$theme'}).then(()=>1)" 600 >/dev/null
  for page in home meetings insights dictionary snippets style transforms notes; do
    timeout 20 node "$SHOT" "$PORT" DronsioFlow "$OUT/$theme-$page.png" "(() => { document.querySelector('[data-act=close-modal]')?.click(); document.querySelector('[data-act=nav][data-arg=$page]').click(); return 1; })()" 500 >/dev/null
  done
  for tab in general shortcuts ai system; do
    timeout 20 node "$SHOT" "$PORT" DronsioFlow "$OUT/$theme-settings-$tab.png" "(() => { document.querySelector('[data-act=modal][data-arg=settings]').click(); setTimeout(()=>document.querySelector('[data-act=settings-tab][data-arg=$tab]')?.click(),50); return 1; })()" 700 >/dev/null
  done
  timeout 20 node "$SHOT" "$PORT" DronsioFlow - "document.querySelector('[data-act=close-modal]')?.click()" 100 >/dev/null
done
ls "$OUT" | wc -l
