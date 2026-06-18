#!/usr/bin/env python3
"""openai-whisper ASR driver for video-vob.

Usage:
    openai_whisper_transcribe.py <audio.wav> <out.json> [model] [language]

Fallback ASR backend used when faster-whisper is not installed but the
reference `openai-whisper` package is. Writes the same canonical word-level
transcript ([{"text","start","end"}]) and prints a JSON envelope as the last
stdout line. See faster_whisper_transcribe.py for the shared contract.
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
                  else os.environ.get("VOB_ASR_MODEL") or "small")
    language = (sys.argv[4] if len(sys.argv) > 4 and sys.argv[4]
                else os.environ.get("VOB_ASR_LANGUAGE") or None)
    if language in ("", "auto", None):
        language = None

    try:
        import whisper
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "whisper_import_failed: %s" % exc})
        return 3

    try:
        model = whisper.load_model(model_name)
        result = model.transcribe(audio, language=language, word_timestamps=True)
        detected_language = result.get("language")
        words = []
        for seg in result.get("segments", []):
            seg_words = seg.get("words")
            if seg_words:
                for w in seg_words:
                    text = (w.get("word") or "").strip()
                    if not text:
                        continue
                    entry = {
                        "text": text,
                        "start": round(float(w["start"]), 3),
                        "end": round(float(w["end"]), 3),
                    }
                    # OPTIONAL word confidence "p" in [0,1]; consumers treat a
                    # missing p as "confidence unknown", never as 0.
                    p = w.get("probability")
                    if isinstance(p, (int, float)):
                        entry["p"] = round(float(p), 3)
                    words.append(entry)
            else:
                text = (seg.get("text") or "").strip()
                if text:
                    words.append({
                        "text": text,
                        "start": round(float(seg["start"]), 3),
                        "end": round(float(seg["end"]), 3),
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
        "language": detected_language or None,
        "backend": "openai-whisper",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
