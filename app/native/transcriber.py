#!/usr/bin/env python3
"""DronsioFlow local transcription engine (faster-whisper, runs fully offline
once the model is downloaded).

Protocol (JSON lines):
  stdin:  {"cmd": "load", "model": "small"}
          {"cmd": "transcribe", "id": "...", "path": "/x.wav", "language": "pt", "prompt": "...",
           "task": "transcribe" | "translate", "paths": ["/mic.raw", "/system.raw"], "progress": false}
          {"cmd": "quit"}
  stdout: {"t": "model", "state": "downloading", "model": "small", "progress": 0.42}
          {"t": "model", "state": "loading" | "ready" | "error", "model": "small", "error": "..."}
          {"t": "progress", "id": "...", "progress": 0.4}
          {"t": "result", "id": "...", "text": "...", "ms": 812, "language": "pt"}
          {"t": "result", "id": "...", "error": "..."}
"""

import json
import os
import sys
import time
import urllib.request
import wave

MODELS_DIR = os.environ.get(
    "DRONSIO_MODELS_DIR",
    os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "dronsioflow", "models"),
)

CT2_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]
MODELS = {
    "tiny": ("Systran/faster-whisper-tiny", CT2_FILES),
    "base": ("Systran/faster-whisper-base", CT2_FILES),
    "small": ("Systran/faster-whisper-small", CT2_FILES),
    "medium": ("Systran/faster-whisper-medium", CT2_FILES),
    "large-v3-turbo": (
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        ["config.json", "model.bin", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"],
    ),
}

# Whisper tends to "hear" these on silence or noise.
HALLUCINATIONS = {
    "legendas pela comunidade amara.org",
    "obrigado.",
    "obrigado por assistir.",
    "obrigada.",
    "tchau.",
    "thank you.",
    "thanks for watching!",
    "you",
    "...",
}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_pcm(path):
    """16 kHz mono 16-bit WAV or raw PCM -> float32 samples (avoids PyAV decoding)."""
    import numpy as np

    if path.endswith(".raw"):
        with open(path, "rb") as f:
            data = np.frombuffer(f.read(), dtype=np.int16)
    else:
        with wave.open(path, "rb") as w:
            if w.getframerate() != 16000 or w.getsampwidth() != 2:
                raise ValueError("esperado WAV 16 kHz, 16 bits")
            data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            if w.getnchannels() > 1:
                data = data.reshape(-1, w.getnchannels()).mean(axis=1)
    return data.astype(np.float32) / 32768.0


def load_audio(paths):
    """Mixes one or more tracks (e.g. microphone + system audio) and boosts quiet speech."""
    import numpy as np

    tracks = [read_pcm(p) for p in paths]
    length = max((len(t) for t in tracks), default=0)
    audio = np.zeros(length, dtype=np.float32)
    for t in tracks:
        audio[: len(t)] += t
    peak = float(np.max(np.abs(audio))) if length else 0.0
    if peak > 1.0:
        audio /= peak
    elif 0.003 < peak < 0.5:
        audio *= min(0.9 / peak, 20.0)  # whispered/quiet speech
    return audio


def download(name):
    repo, files = MODELS[name]
    target = os.path.join(MODELS_DIR, name)
    if all(os.path.exists(os.path.join(target, f)) for f in files):
        return target
    os.makedirs(target, exist_ok=True)
    sizes = {}
    for f in files:
        req = urllib.request.Request(f"https://huggingface.co/{repo}/resolve/main/{f}", method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            sizes[f] = int(r.headers.get("Content-Length") or 0)
    total = max(sum(sizes.values()), 1)
    done = 0
    last = 0.0
    for f in files:
        dest = os.path.join(target, f)
        if os.path.exists(dest) and os.path.getsize(dest) == sizes[f]:
            done += sizes[f]
            continue
        tmp = dest + ".part"
        with urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/main/{f}", timeout=60) as r, open(tmp, "wb") as out:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if time.time() - last > 0.5:
                    last = time.time()
                    emit({"t": "model", "state": "downloading", "model": name, "progress": round(done / total, 3)})
        os.replace(tmp, dest)
    return target


class Engine:
    def __init__(self):
        self.model = None
        self.name = None

    def load(self, name):
        if name not in MODELS:
            emit({"t": "model", "state": "error", "model": name, "error": "modelo desconhecido"})
            return
        if self.name == name and self.model is not None:
            emit({"t": "model", "state": "ready", "model": name})
            return
        try:
            path = download(name)
            emit({"t": "model", "state": "loading", "model": name})
            from faster_whisper import WhisperModel

            threads = max(1, (os.cpu_count() or 4) - 2)
            self.model = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=threads)
            self.name = name
            emit({"t": "model", "state": "ready", "model": name})
        except Exception as e:
            self.model = None
            self.name = None
            emit({"t": "model", "state": "error", "model": name, "error": str(e)})

    def transcribe(self, cmd):
        if self.model is None:
            emit({"t": "result", "id": cmd.get("id"), "error": "modelo não carregado"})
            return
        started = time.time()
        try:
            language = cmd.get("language") or None
            if language == "auto":
                language = None
            audio = load_audio(cmd.get("paths") or [cmd["path"]])
            total = len(audio) / 16000
            segments, info = self.model.transcribe(
                audio,
                language=language,
                task=cmd.get("task", "transcribe"),
                initial_prompt=cmd.get("prompt") or None,
                beam_size=5 if total < 120 else 2,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False,
            )
            parts = []
            last = 0.0
            for s in segments:
                parts.append(s.text.strip())
                if cmd.get("progress") and time.time() - last > 1:
                    last = time.time()
                    emit({"t": "progress", "id": cmd.get("id"), "progress": round(min(s.end / max(total, 1), 1), 3)})
            text = " ".join(parts).strip()
            if text.lower() in HALLUCINATIONS:
                text = ""
            emit({
                "t": "result",
                "id": cmd.get("id"),
                "text": text,
                "ms": int((time.time() - started) * 1000),
                "language": info.language,
            })
        except Exception as e:
            emit({"t": "result", "id": cmd.get("id"), "error": str(e)})


def main():
    engine = Engine()
    for line in sys.stdin:
        try:
            cmd = json.loads(line)
        except ValueError:
            continue
        if cmd.get("cmd") == "load":
            engine.load(cmd.get("model", "small"))
        elif cmd.get("cmd") == "transcribe":
            engine.transcribe(cmd)
        elif cmd.get("cmd") == "quit":
            break


if __name__ == "__main__":
    main()
