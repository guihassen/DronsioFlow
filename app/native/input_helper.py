#!/usr/bin/env python3
"""DronsioFlow input helper.

Reads keyboards/mice through evdev (works on Wayland and X11) and pastes text
by filling the clipboard and simulating a key combo on a uinput device.

Protocol (JSON lines):
  stdout events:  {"t": "key", "code": 29, "down": true}
                  {"t": "status", "keyboards": 2, "uinput": true}
                  {"t": "pasted", "id": "...", "ok": true, "reason": null}
                  {"t": "selection", "id": "...", "text": "highlighted text or empty"}
  stdin commands: {"cmd": "paste", "id": "...", "text": "...", "keys": "shift+insert",
                   "restoreClipboard": true, "restoreDelayMs": 700}
                  {"cmd": "selection", "id": "..."}
                  {"cmd": "combo", "keys": "ctrl+v"}
                  {"cmd": "quit"}
Standard library only.
"""

import array
import fcntl
import json
import os
import select
import shutil
import struct
import subprocess
import sys
import threading
import time

VIRTUAL_DEVICE_NAME = "dronsioflow-virtual-keyboard"
EV_SYN, EV_KEY = 0x00, 0x01
INPUT_EVENT = struct.Struct("llHHi")
MOUSE_BUTTONS = {0x112, 0x113, 0x114, 0x115, 0x116}

KEY_NAMES = {
    "ctrl": 29, "shift": 42, "alt": 56, "super": 125, "insert": 110,
    "v": 47, "enter": 28, "space": 57,
}

out_lock = threading.Lock()


def emit(obj):
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with out_lock:
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)


def log(*args):
    print("[input-helper]", *args, file=sys.stderr, flush=True)


def _ioc(direction, typ, nr, size):
    return (direction << 30) | (size << 16) | (ord(typ) << 8) | nr


EVIOCGNAME_256 = _ioc(2, "E", 0x06, 256)
EVIOCGBIT_KEY_96 = _ioc(2, "E", 0x20 + EV_KEY, 96)
UI_SET_EVBIT = _ioc(1, "U", 100, 4)
UI_SET_KEYBIT = _ioc(1, "U", 101, 4)
UI_DEV_SETUP = _ioc(1, "U", 3, 92)
UI_DEV_CREATE = _ioc(0, "U", 1, 0)
UI_DEV_DESTROY = _ioc(0, "U", 2, 0)


def device_name(fd):
    buf = array.array("B", [0] * 256)
    try:
        fcntl.ioctl(fd, EVIOCGNAME_256, buf, True)
        return buf.tobytes().split(b"\0", 1)[0].decode(errors="replace")
    except OSError:
        return ""


def key_bits(fd):
    buf = array.array("B", [0] * 96)
    try:
        fcntl.ioctl(fd, EVIOCGBIT_KEY_96, buf, True)
        return buf
    except OSError:
        return None


def has_bit(bits, code):
    return bool(bits[code // 8] & (1 << (code % 8)))


class VirtualKeyboard:
    def __init__(self):
        self.fd = None
        try:
            fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        except OSError as e:
            log("no access to /dev/uinput:", e)
            return
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
            for code in range(1, 256):
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            setup = struct.pack("HHHH80sI", 0x03, 0x1d70, 0x0f10, 1, VIRTUAL_DEVICE_NAME.encode(), 0)
            fcntl.ioctl(fd, UI_DEV_SETUP, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
            time.sleep(0.2)
            self.fd = fd
        except OSError as e:
            log("uinput setup failed:", e)
            os.close(fd)

    def _emit(self, typ, code, value):
        os.write(self.fd, INPUT_EVENT.pack(0, 0, typ, code, value))

    def combo(self, codes):
        if self.fd is None or not codes:
            return False
        for code in codes:
            self._emit(EV_KEY, code, 1)
            self._emit(EV_SYN, 0, 0)
            time.sleep(0.008)
        for code in reversed(codes):
            self._emit(EV_KEY, code, 0)
            self._emit(EV_SYN, 0, 0)
            time.sleep(0.008)
        return True

    def close(self):
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(self.fd)
            self.fd = None


def parse_keys(spec):
    return [KEY_NAMES[p] for p in spec.lower().replace(" ", "").split("+") if p in KEY_NAMES]


class Clipboard:
    def __init__(self):
        self.wayland = bool(os.environ.get("WAYLAND_DISPLAY")) and shutil.which("wl-copy")
        self.xclip = shutil.which("xclip")

    def read(self):
        try:
            if self.wayland:
                cmd = ["wl-paste", "-n", "-t", "text"]
            elif self.xclip:
                cmd = ["xclip", "-o", "-selection", "clipboard"]
            else:
                return None
            r = subprocess.run(cmd, capture_output=True, timeout=0.6)
            return r.stdout.decode(errors="replace") if r.returncode == 0 else None
        except Exception:
            return None

    def read_primary(self):
        """Text currently highlighted in any app (X11/Wayland primary selection)."""
        try:
            if self.wayland:
                cmd = ["wl-paste", "--primary", "-n", "-t", "text"]
            elif self.xclip:
                cmd = ["xclip", "-o", "-selection", "primary"]
            else:
                return None
            r = subprocess.run(cmd, capture_output=True, timeout=0.6)
            return r.stdout.decode(errors="replace") if r.returncode == 0 else None
        except Exception:
            return None

    def clear_primary(self):
        quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": 2}
        try:
            if self.wayland:
                subprocess.run(["wl-copy", "--primary", "--clear"], **quiet)
            elif self.xclip:
                subprocess.run(["xclip", "-selection", "primary", "/dev/null"], **quiet)
        except Exception:
            pass

    def write(self, text, primary=True):
        data = text.encode()
        # wl-copy/xclip keep a background process serving the selection; it must not
        # inherit our stdout (the IPC pipe to Electron).
        quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": 3}
        try:
            if self.wayland:
                subprocess.run(["wl-copy"], input=data, check=True, **quiet)
                if primary:
                    subprocess.run(["wl-copy", "--primary"], input=data, **quiet)
            elif self.xclip:
                subprocess.run(["xclip", "-selection", "clipboard"], input=data, check=True, **quiet)
                if primary:
                    subprocess.run(["xclip", "-selection", "primary"], input=data, **quiet)
            else:
                return False
            return True
        except Exception as e:
            log("clipboard write failed:", e)
            return False


class Helper:
    def __init__(self):
        self.vkbd = VirtualKeyboard()
        self.clipboard = Clipboard()
        self.devices = {}
        self.pressed = set()
        self.restore_timer = None

    def status(self):
        keyboards = sum(1 for d in self.devices.values() if d[1])
        emit({"t": "status", "keyboards": keyboards, "uinput": self.vkbd.fd is not None})

    def scan(self):
        changed = False
        try:
            names = os.listdir("/dev/input")
        except OSError:
            return
        for name in names:
            path = "/dev/input/" + name
            if not name.startswith("event") or path in self.devices:
                continue
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError:
                continue
            bits = key_bits(fd)
            is_kbd = bits is not None and has_bit(bits, 30) and has_bit(bits, 57)
            is_mouse = bits is not None and has_bit(bits, 0x112)
            if device_name(fd) == VIRTUAL_DEVICE_NAME or not (is_kbd or is_mouse):
                os.close(fd)
                continue
            self.devices[path] = (fd, is_kbd)
            changed = True
        if changed:
            self.status()

    def input_loop(self):
        self.scan()
        self.status()
        last_scan = time.time()
        while True:
            fds = [d[0] for d in self.devices.values()]
            try:
                ready, _, _ = select.select(fds, [], [], 2.0)
            except (OSError, ValueError):
                ready = []
            for fd in ready:
                self.read(fd)
            if time.time() - last_scan > 3:
                self.scan()
                last_scan = time.time()

    def read(self, fd):
        try:
            data = os.read(fd, INPUT_EVENT.size * 64)
        except BlockingIOError:
            return
        except OSError:
            for path, (dfd, _) in list(self.devices.items()):
                if dfd == fd:
                    del self.devices[path]
            try:
                os.close(fd)
            except OSError:
                pass
            self.status()
            return
        for off in range(0, len(data) - INPUT_EVENT.size + 1, INPUT_EVENT.size):
            _, _, typ, code, value = INPUT_EVENT.unpack_from(data, off)
            if typ != EV_KEY or value == 2:
                continue
            if code >= 0x110 and code not in MOUSE_BUTTONS:
                continue  # left/right click, touchpad, etc.
            down = value == 1
            if down == (code in self.pressed):
                continue
            (self.pressed.add if down else self.pressed.discard)(code)
            emit({"t": "key", "code": code, "down": down})

    def paste(self, cmd):
        ok, reason = False, None
        previous = self.clipboard.read() if cmd.get("restoreClipboard", True) else None
        if not self.clipboard.write(cmd.get("text", "")):
            reason = "clipboard"
        elif self.vkbd.fd is None:
            reason = "uinput"
        else:
            # wait until the user lets go of the dictation shortcut
            deadline = time.time() + 1.5
            while self.pressed - MOUSE_BUTTONS and time.time() < deadline:
                time.sleep(0.02)
            time.sleep(0.05)
            ok = self.vkbd.combo(parse_keys(cmd.get("keys", "shift+insert")))
            reason = None if ok else "keys"
        emit({"t": "pasted", "id": cmd.get("id"), "ok": ok, "reason": reason})
        if ok:
            if self.restore_timer:
                self.restore_timer.cancel()
            delay = cmd.get("restoreDelayMs", 700) / 1000
            self.restore_timer = threading.Timer(delay, self.after_paste, args=(previous,))
            self.restore_timer.daemon = True
            self.restore_timer.start()

    def after_paste(self, previous):
        if previous is not None:
            self.clipboard.write(previous, primary=False)
        # our text must not linger in PRIMARY, or command mode would take it for a selection
        self.clipboard.clear_primary()

    def selection(self, cmd):
        text = self.clipboard.read_primary() or ""
        if text:
            self.clipboard.clear_primary()
        emit({"t": "selection", "id": cmd.get("id"), "text": text})

    def run(self):
        threading.Thread(target=self.input_loop, daemon=True).start()
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
            except ValueError:
                continue
            kind = cmd.get("cmd")
            if kind == "paste":
                threading.Thread(target=self.paste, args=(cmd,), daemon=True).start()
            elif kind == "selection":
                threading.Thread(target=self.selection, args=(cmd,), daemon=True).start()
            elif kind == "combo":
                self.vkbd.combo(parse_keys(cmd.get("keys", "")))
            elif kind == "quit":
                break
        self.vkbd.close()
        os._exit(0)


if __name__ == "__main__":
    Helper().run()
