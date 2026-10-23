#!/usr/bin/env bash
# Gives the user at the active local session access to keyboards/mice and to
# /dev/uinput (systemd-logind "uaccess"), so DronsioFlow can see its global
# shortcut and simulate the paste keystroke on Wayland and X11.
# Run with: sudo ./setup-permissions.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode como root: sudo $0"; exit 1; }

cat > /etc/udev/rules.d/70-dronsioflow.rules <<'EOF'
# DronsioFlow: global shortcuts + paste simulation
KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_MOUSE}=="1", TAG+="uaccess"
EOF
echo uinput > /etc/modules-load.d/dronsioflow-uinput.conf
modprobe uinput
udevadm control --reload-rules
udevadm trigger --subsystem-match=input --action=change
udevadm trigger --subsystem-match=misc --sysname-match=uinput --action=change
echo "Permissões instaladas (/etc/udev/rules.d/70-dronsioflow.rules)."
