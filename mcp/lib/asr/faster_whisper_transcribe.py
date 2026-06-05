#!/usr/bin/env python3
"""faster-whisper ASR driver for video-vob.

Usage:
    faster_whisper_transcribe.py <audio.wav> <out.json> [model] [language]

Writes a CANONICAL word-level transcript to <out.json> — a JSON array of
{"text", "start", "end"} entries, exactly the shape vob's clean-cut /
segment-overlap / transcript-summary code consumes (see mcp/lib/clean-cut.js).
Prints a single-line JSON envelope {ok, wordCount, transcriptPath, ...} to
stdout as the LAST line so the Node caller can parse it regardless of any
library logging that lands on stdout/stderr first.

Env knobs (all optional):
    VOB_ASR_MODEL          default model name/path (default "small.en")
    VOB_ASR_LANGUAGE       force a language code ("en"); "auto"/"" => detect
    VOB_ASR_DEVICE         ctranslate2 device (default "cpu")
    VOB_ASR_COMPUTE_TYPE   ctranslate2 compute type (default "int8")
"""
import json
import os
import sys


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        _emit({"ok": False, "error": "usage: <audio> <out> [model] [language]"})
        return 2
    audio = sys.argv[1]
    out = sys.argv[2]
    model_name = (sys.argv[3] if len(sys.argv) > 3 and sys.argv[3]
                  else os.environ.get("VOB_ASR_MODEL") or "small.en")
    language = (sys.argv[4] if len(sys.argv) > 4 and sys.argv[4]
                else os.environ.get("VOB_ASR_LANGUAGE") or None)
    if language in ("", "auto", None):
        language = None

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "faster_whisper_import_failed: %s" % exc})
        return 3

    device = os.environ.get("VOB_ASR_DEVICE", "cpu")
    compute_type = os.environ.get("VOB_ASR_COMPUTE_TYPE", "int8")

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio, language=language, word_timestamps=True, vad_filter=False
        )
        words = []
        for seg in segments:
            seg_words = getattr(seg, "words", None)
            if seg_words:
                for w in seg_words:
                    text = (w.word or "").strip()
                    if not text:
                        continue
                    words.append({
                        "text": text,
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                    })
            else:
                text = (seg.text or "").strip()
                if text:
                    words.append({
                        "text": text,
                        "start": round(float(seg.start), 3),
                        "end": round(float(seg.end), 3),
                    })
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "transcribe_failed: %s" % exc})
        return 4

    try:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(words, fh, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "write_failed: %s" % exc})
        return 5

    _emit({
        "ok": True,
        "wordCount": len(words),
        "transcriptPath": out,
        "model": model_name,
        "language": getattr(info, "language", None),
        "backend": "faster-whisper",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
