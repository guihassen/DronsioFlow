#!/usr/bin/env bash
# Installs DronsioFlow for the current user (no root needed).
# Keyboard access needs a one-time: sudo ./setup-permissions.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_VERSION="42.11.2"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/dronsioflow"
DEST="$HOME/.local/opt/dronsioflow"
VENDOR="$HERE/vendor"

echo "==> Verificando dependências"
missing=()
for cmd in node npm python3 parecord pactl; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  command -v wl-copy >/dev/null || missing+=("wl-copy")
else
  command -v xclip >/dev/null || missing+=("xclip")
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "Faltam programas: ${missing[*]}"
  echo "Fedora:        sudo dnf install nodejs npm python3 pulseaudio-utils wl-clipboard xclip"
  echo "Ubuntu/Debian: sudo apt install nodejs npm python3-venv pulseaudio-utils wl-clipboard xclip"
  exit 1
fi
command -v ollama >/dev/null || echo "   (opcional) Ollama não encontrado: modo comando, transformações e resumos ficam desativados. https://ollama.com"

echo "==> Ambiente Python (faster-whisper) em $DATA/venv"
if [ ! -x "$DATA/venv/bin/python" ]; then
  mkdir -p "$DATA"
  python3 -m venv "$DATA/venv"
fi
"$DATA/venv/bin/python" -c "import faster_whisper" 2>/dev/null \
  || "$DATA/venv/bin/pip" install --quiet --disable-pip-version-check faster-whisper

echo "==> Electron $ELECTRON_VERSION"
if [ ! -x "$VENDOR/node_modules/electron/dist/electron" ]; then
  mkdir -p "$VENDOR"
  [ -f "$VENDOR/package.json" ] || echo '{"name":"dronsioflow-vendor","private":true,"version":"0.0.0"}' > "$VENDOR/package.json"
  (cd "$VENDOR" && npm install --no-audit --no-fund "electron@$ELECTRON_VERSION")
  (cd "$VENDOR" && node node_modules/electron/install.js)
fi

echo "==> Instalando em $DEST"
rm -rf "$DEST" && mkdir -p "$DEST"
cp -a "$VENDOR/node_modules/electron/dist/." "$DEST/"
mv "$DEST/electron" "$DEST/dronsioflow"
rm -f "$DEST/resources/default_app.asar"
cp -a "$HERE/app" "$DEST/resources/app"
# the browser extension as a .xpi, for Zen/LibreWolf "install from file" (files at the root of the zip)
(cd "$HERE/app/extension" && python3 -m zipfile -c "$DEST/dronsioflow-extension.xpi" manifest.json background.js page.js popup.html popup.js icons)

cat > "$DEST/dronsioflow.sh" <<'EOF'
#!/usr/bin/env bash
# XWayland lets the floating indicator stay on top and be positioned on GNOME.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export DRONSIO_LAUNCHER="$DIR/dronsioflow.sh"
exec "$DIR/dronsioflow" --ozone-platform=x11 "$@"
EOF
chmod +x "$DEST/dronsioflow.sh"

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
ln -sf "$DEST/dronsioflow.sh" "$HOME/.local/bin/dronsioflow"
cp "$HERE/app/assets/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/dronsioflow.png"
cat > "$HOME/.local/share/applications/dronsioflow.desktop" <<EOF
[Desktop Entry]
Name=DronsioFlow
Comment=Ditado por voz gratuito e local
Exec=$DEST/dronsioflow.sh
Icon=$DEST/resources/app/assets/icon.png
Terminal=false
Type=Application
Categories=Utility;Accessibility;
Keywords=voz;ditado;whisper;transcrição;
StartupWMClass=dronsioflow
EOF
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
# -f/-t: rebuild even without an index.theme, so a stale user cache never hides the icon
gtk-update-icon-cache -f -t -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

readable=0
for dev in /dev/input/event*; do [ -r "$dev" ] && { readable=1; break; }; done
if [ "$readable" = 0 ] || [ ! -w /dev/uinput ]; then
  echo "!! Falta acesso ao teclado/uinput: rode  sudo $HERE/setup-permissions.sh"
fi
echo "==> Pronto. Abra 'DronsioFlow' no menu de aplicativos (ou rode: dronsioflow)"
echo "   Modo agente no navegador: instale $DEST/dronsioflow-extension.xpi (veja o README, \"Extensão do navegador\")"
