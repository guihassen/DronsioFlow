#!/usr/bin/env python3
"""DronsioFlow local dictation formatter (token classification model, runs on CPU).

Removes fillers, restarts and self-corrections and adds , . ? and capitals, deciding word by word, so
it never invents or changes a word. Model: https://huggingface.co/guihassen/formatter (~470 MB,
downloaded on first use). Needs torch and transformers in the venv.

Protocol (JSON lines):
  stdin:  {"cmd": "load"}
          {"cmd": "format", "id": "...", "text": "raw whisper text"}
          {"cmd": "quit"}
  stdout: {"t": "model", "state": "downloading" | "loading" | "ready" | "error", "progress": 0.4, "error": "..."}
          {"t": "result", "id": "...", "text": "...", "ms": 42}
          {"t": "result", "id": "...", "error": "..."}
"""

import json
import os
import sys
import time
import urllib.request

# --- Settings -----------------------------------------------------------------

REPO = "guihassen/formatter"
FILES = ["config.json", "tokenizer_config.json", "tokenizer.json", "model.safetensors"]
MODELS_DIR = os.environ.get(
    "DRONSIO_MODELS_DIR",
    os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "dronsioflow", "models"),
)
MODEL_DIR = os.path.join(MODELS_DIR, "formatter")

LABELS = ["KEEP_NONE", "KEEP_COMMA", "KEEP_PERIOD", "KEEP_QUESTION", "DELETE"]
PUNCT = {"KEEP_COMMA": ",", "KEEP_PERIOD": ".", "KEEP_QUESTION": "?"}
MAX_PIECES = 126           # 128 minus <s> and </s>
MARGIN_WORDS = 15          # context words on each side of a window whose labels are not used
DELETE_MARGIN = 1.0        # DELETE must beat the best KEEP_ logit by this much


# --- Messages -----------------------------------------------------------------

def emit(obj):
    """Write one JSON line to stdout and flush it right away."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# --- Text (no model) ----------------------------------------------------------

SENTENCE_END = ".!?…"
PAUSE = ",;:"
QUOTES = "\"'“”‘’()[]{}«»"
DASHES = "-–—"


def normalize_whisper(text):
    """Rewrite Whisper punctuation with only the marks the model knows: ? . ,

    "!", "..." and "…" become ".", ";" and ":" become ",". Quotes and brackets around words are
    dropped, and words made only of punctuation are skipped.
    """
    words = []
    for word in text.split():
        core = word.strip(QUOTES)
        stripped = core.rstrip(SENTENCE_END + PAUSE)
        trailing = core[len(stripped):]
        stripped = stripped.strip(QUOTES)  # quotes inside the marks: 'oi".' -> 'oi"' -> 'oi'
        if not stripped.strip(SENTENCE_END + PAUSE + DASHES):
            continue
        if "?" in trailing:
            stripped += "?"
        elif any(mark in trailing for mark in SENTENCE_END):
            stripped += "."
        elif trailing:
            stripped += ","
        words.append(stripped)
    return " ".join(words)


def split_marked(text):
    """(word, trailing mark) pairs of a normalized text; the mark is "," "." "?" or ""."""
    pairs = []
    sentence_start = True
    for word in text.split():
        mark = word[-1] if word[-1] in ",.?" else ""
        if mark:
            word = word[:-1]
        if not word:
            continue
        if sentence_start:
            word = word[0].lower() + word[1:]
        pairs.append((word, mark))
        sentence_start = mark in (".", "?")
    return pairs


def split_words(text):
    """Words of a normalized text, written the way the model saw them in training.

    The trailing , . or ? is removed and the first letter of each sentence is lowercased (the rest of
    the word is kept, so "README" or "Maria" mid-sentence stay as they are).
    "Oi, tudo bem? Sim." -> ["oi", "tudo", "bem", "sim"]. Inner punctuation stays: "readme.md", "R$3.50".
    """
    return [word for word, _ in split_marked(text)]


def keep_whisper_questions(marks, labels):
    """Where Whisper heard a question ("?") and the model ends the sentence with ".", use "?" instead.

    Whisper hears the intonation, the model only sees the words ("você vem amanhã" can be either).
    The model still decides where sentences end and what to delete.
    """
    return ["KEEP_QUESTION" if mark == "?" and label == "KEEP_PERIOD" else label
            for mark, label in zip(marks, labels)]


def apply_labels(words, labels):
    """Final text from words and labels.

    DELETE words are dropped, the others get the punctuation of their label. The first word and every
    word after . or ? are capitalized, and the text ends with "." if nothing closes it.
    """
    if len(words) != len(labels):
        raise ValueError("words and labels must have the same length")
    out = []
    capitalize = True
    for word, label in zip(words, labels):
        if label == "DELETE":
            continue
        if capitalize:
            word = word[0].upper() + word[1:]
        mark = PUNCT.get(label, "")
        out.append(word + mark)
        capitalize = mark in (".", "?")
    if out and out[-1][-1] not in ".?":
        out[-1] = out[-1].rstrip(",") + "."
    return " ".join(out)


# --- Windows (no model) -------------------------------------------------------

def windows(pieces_per_word):
    """Split the words into overlapping windows of at most MAX_PIECES pieces.

    Returns [(start, end, keep_from, keep_to)]: the window covers words[start:end] but only its labels for
    words[keep_from:keep_to] are used, so every word is labeled with context on both sides.
    """
    total = len(pieces_per_word)
    result = []
    start, kept = 0, 0
    while kept < total:
        end, used = start, 0
        while end < total and used + pieces_per_word[end] <= MAX_PIECES:
            used += pieces_per_word[end]
            end += 1
        end = max(end, kept + 1)  # a word longer than a whole window must not stall the loop
        keep_to = end if end == total else max(end - MARGIN_WORDS, kept + 1)
        result.append((start, end, kept, keep_to))
        kept = keep_to
        start = max(kept - MARGIN_WORDS, start + 1) if kept < total else start
    return result


# --- Model --------------------------------------------------------------------

def download():
    """Download the model files from Hugging Face into MODEL_DIR, skipping the ones already there.

    Emits {"t": "model", "state": "downloading", "progress": ...} while it goes, writes each file
    to "<name>.part" and renames it at the end, so a cut download is never taken as complete.
    """
    if all(os.path.exists(os.path.join(MODEL_DIR, f)) for f in FILES):
        return
    os.makedirs(MODEL_DIR, exist_ok=True)
    sizes = {}
    for f in FILES:
        req = urllib.request.Request(f"https://huggingface.co/{REPO}/resolve/main/{f}", method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            sizes[f] = int(r.headers.get("Content-Length") or 0)
    total = max(sum(sizes.values()), 1)
    done = 0
    last = 0.0
    for f in FILES:
        dest = os.path.join(MODEL_DIR, f)
        if os.path.exists(dest) and os.path.getsize(dest) == sizes[f]:
            done += sizes[f]
            continue
        tmp = dest + ".part"
        with urllib.request.urlopen(f"https://huggingface.co/{REPO}/resolve/main/{f}", timeout=60) as r, open(tmp, "wb") as out:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if time.time() - last > 0.5:
                    last = time.time()
                    emit({"t": "model", "state": "downloading", "progress": round(done / total, 3)})
        os.replace(tmp, dest)


def cautious_argmax(logits):
    """Label index per row of logits, but DELETE only wins with a DELETE_MARGIN lead over the best KEEP_.

    When unsure, the word stays with the best KEEP_ label: deleting a real word is the worst error.
    """
    import torch

    delete = LABELS.index("DELETE")
    winner = torch.argmax(logits, dim=-1)
    keep = logits.clone()
    keep[..., delete] = float("-inf")
    best_keep = torch.argmax(keep, dim=-1)
    gap = logits[..., delete] - keep.max(dim=-1).values
    unsure = (winner == delete) & (gap < DELETE_MARGIN)
    return torch.where(unsure, best_keep, winner)


class Formatter:
    """Holds the tokenizer and the model once loaded."""

    def __init__(self):
        """Start empty: nothing loaded."""
        self.tokenizer = None
        self.model = None

    def load(self):
        """Download if needed, load tokenizer and model in eval mode, emit loading/ready/error."""
        if self.model is not None:
            emit({"t": "model", "state": "ready"})
            return
        try:
            try:
                import torch
                from transformers import AutoModelForTokenClassification, AutoTokenizer
            except ImportError:
                raise RuntimeError("faltam o torch e o transformers; instale com DRONSIO_FORMATTER=1 ./install.sh")
            download()
            emit({"t": "model", "state": "loading"})
            from transformers.utils import logging

            logging.set_verbosity_error()   # stderr ends up in the app's console: keep it for real errors
            logging.disable_progress_bar()
            torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))
            self.tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
            self.model = AutoModelForTokenClassification.from_pretrained(MODEL_DIR)
            self.model.eval()
            emit({"t": "model", "state": "ready"})
        except Exception as e:
            self.tokenizer = None
            self.model = None
            emit({"t": "model", "state": "error", "error": str(e)})

    def label_window(self, words):
        """Labels for words that fit in one window: read the label of the first piece of each word."""
        import torch

        encoding = self.tokenizer(words, is_split_into_words=True, truncation=True,
                                  max_length=MAX_PIECES + 2, return_tensors="pt")
        with torch.no_grad():
            logits = self.model(**encoding).logits[0]
        piece_labels = cautious_argmax(logits).tolist()
        labels, previous = [], None
        for position, word_id in enumerate(encoding.word_ids()):
            if word_id is None or word_id == previous:
                continue
            labels.append(LABELS[piece_labels[position]])
            previous = word_id
        while len(labels) < len(words):  # cut off by truncation: keep the word
            labels.append("KEEP_NONE")
        return labels

    def label_words(self, words):
        """Labels for any number of words, window by window, keeping only each window's middle part."""
        pieces_per_word = [max(len(self.tokenizer.tokenize(w)), 1) for w in words]
        labels = []
        for start, end, keep_from, keep_to in windows(pieces_per_word):
            window_labels = self.label_window(words[start:end])
            labels.extend(window_labels[keep_from - start:keep_to - start])
        return labels

    def format(self, cmd):
        """Answer one {"cmd": "format"} request: normalize, split, label, apply; emit result with ms or error."""
        if self.model is None:
            emit({"t": "result", "id": cmd.get("id"), "error": "modelo não carregado"})
            return
        started = time.time()
        try:
            pairs = split_marked(normalize_whisper(cmd.get("text") or ""))
            words = [word for word, _ in pairs]
            text = ""
            if words:
                labels = keep_whisper_questions([mark for _, mark in pairs], self.label_words(words))
                text = apply_labels(words, labels)
            emit({"t": "result", "id": cmd.get("id"), "text": text, "ms": int((time.time() - started) * 1000)})
        except Exception as e:
            emit({"t": "result", "id": cmd.get("id"), "error": str(e)})


# --- Main loop ----------------------------------------------------------------

def main():
    """Read one JSON command per line from stdin and dispatch load / format / quit."""
    formatter = Formatter()
    for line in sys.stdin:
        try:
            cmd = json.loads(line)
        except ValueError:
            continue
        if cmd.get("cmd") == "load":
            formatter.load()
        elif cmd.get("cmd") == "format":
            formatter.format(cmd)
        elif cmd.get("cmd") == "quit":
            break


if __name__ == "__main__":
    main()
