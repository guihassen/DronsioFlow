"""Generates the short start/stop chimes used by DronsioFlow."""
import math, struct, sys, wave

def chime(path, freqs, dur=0.09, rate=44100, vol=0.28):
    frames = bytearray()
    for f in freqs:
        n = int(dur * rate)
        for i in range(n):
            t = i / rate
            env = min(1, i / (0.008 * rate)) * math.exp(-5 * t / dur)
            s = vol * env * (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(4 * math.pi * f * t))
            frames += struct.pack("<h", int(max(-1, min(1, s)) * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(frames))

out = sys.argv[1]
chime(f"{out}/start.wav", [660, 990])
chime(f"{out}/stop.wav", [880, 587])
