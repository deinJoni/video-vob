#!/usr/bin/env python3
"""whisperx ASR driver for video-vob.

Usage:
    whisperx_transcribe.py <audio.wav> <out.json> [model] [language]

Transcribes with the faster-whisper engine (via the `whisperx` package) and
then runs wav2vec2 forced alignment for KARAOKE-grade word timing: each word's
start/end comes from frame-accurate forced alignment, with a real per-word
alignment score. Diarization is DISABLED (no pyannote, no HF token, no
`speaker` field, ever).

Writes the same CANONICAL word-level transcript the rest of the pipeline
consumes ([{"text","start","end","p"}], see mcp/lib/clean-cut.js) and prints a
single-line JSON envelope as the LAST stdout line. The envelope adds an
`aligned` flag: true only when forced alignment actually ran and produced word
timings; false when alignment was disabled. See
faster_whisper_transcribe.py for the shared contract.

Env knobs (all optional):
    VOB_ASR_MODEL          default model name/path (default "small.en")
    VOB_ASR_LANGUAGE       force a language code ("en"); "auto"/"" => detect
    VOB_ASR_DEVICE         compute device (default "cpu")
    VOB_ASR_COMPUTE_TYPE   ctranslate2 compute type (default "int8")
    VOB_WHISPERX_BATCH     transcribe batch_size (int, default 8)
    VOB_ALIGN              forced alignment on unless "0"/"off"/"false"/"no"
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
    audio_path = sys.argv[1]
    out = sys.argv[2]
    model_name = (sys.argv[3] if len(sys.argv) > 3 and sys.argv[3]
                  else os.environ.get("VOB_ASR_MODEL") or "small.en")
    language = (sys.argv[4] if len(sys.argv) > 4 and sys.argv[4]
                else os.environ.get("VOB_ASR_LANGUAGE") or None)
    if language in ("", "auto", None):
        language = None

    align_enabled = (os.environ.get("VOB_ALIGN", "").strip().lower()
                     not in ("0", "off", "false", "no"))

    try:
        import whisperx
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "whisperx_import_failed: %s" % exc})
        return 3

    device = os.environ.get("VOB_ASR_DEVICE", "cpu")
    compute_type = os.environ.get("VOB_ASR_COMPUTE_TYPE", "int8")
    try:
        batch = int(os.environ.get("VOB_WHISPERX_BATCH", "8"))
    except Exception:  # noqa: BLE001
        batch = 8

    try:
        model = whisperx.load_model(
            model_name, device, compute_type=compute_type, language=language
        )
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "model_load_failed: %s" % exc})
        return 4

    try:
        audio = whisperx.load_audio(audio_path)
        result = model.transcribe(audio, batch_size=batch)
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": "transcribe_failed: %s" % exc})
        return 4

    detected_language = result.get("language") or language
    if not detected_language and model_name.endswith(".en"):
        detected_language = "en"

    words = []
    aligned = False

    if align_enabled:
        # Forced alignment was REQUESTED. If it can't run (no language to pick
        # an alignment model, or the align step throws), fail with return 6 so
        # the Node caller falls through to faster-whisper — which yields native
        # word timings, strictly better than coarse segment-level whisperx.
        try:
            if not detected_language:
                raise RuntimeError("no language for alignment model selection")
            align_model, metadata = whisperx.load_align_model(
                language_code=detected_language, device=device
            )
            result = whisperx.align(
                result["segments"], align_model, metadata, audio, device,
                return_char_alignments=False,
            )
        except Exception as exc:  # noqa: BLE001
            _emit({"ok": False, "error": "alignment_failed: %s" % exc})
            return 6

        aligned = True
        for seg in result.get("segments", []):
            for w in (seg.get("words") or []):
                text = ((w.get("word") if isinstance(w, dict) else None) or "").strip()
                if not text:
                    continue
                entry = {
                    "text": text,
                    "start": w.get("start"),
                    "end": w.get("end"),
                }
                # For aligned words, "p" is the alignment score. Attach it only
                # when numeric; consumers treat a missing p as "unknown".
                score = w.get("score")
                if isinstance(score, (int, float)):
                    entry["p"] = round(float(score), 3)
                words.append(entry)

        # Fill-pass: aligned words for numerals/symbols whisperx couldn't map
        # can have start/end == None. Don't drop them — borrow from neighbours.
        n = len(words)
        for i in range(n):
            if words[i]["start"] is None:
                prev_end = words[i - 1]["end"] if i > 0 else None
                if prev_end is not None:
                    words[i]["start"] = prev_end
                elif i + 1 < n and words[i + 1]["start"] is not None:
                    words[i]["start"] = words[i + 1]["start"]
                else:
                    words[i]["start"] = 0.0
            if words[i]["end"] is None:
                nxt_start = words[i + 1]["start"] if i + 1 < n else None
                if nxt_start is not None:
                    words[i]["end"] = nxt_start
                elif words[i]["start"] is not None:
                    words[i]["end"] = words[i]["start"]
                else:
                    words[i]["end"] = 0.0

        # Enforce monotonic non-decreasing start and end >= start, then round.
        prev_start = 0.0
        for entry in words:
            start = float(entry["start"])
            if start < prev_start:
                start = prev_start
            prev_start = start
            end = float(entry["end"])
            if end < start:
                end = start
            entry["start"] = round(start, 3)
            entry["end"] = round(end, 3)
    else:
        # Alignment explicitly disabled (a caller forced whisperx with
        # VOB_ALIGN off). Emit coarse SEGMENT-LEVEL entries; no per-word p.
        aligned = False
        for seg in result.get("segments", []):
            text = ((seg.get("text") if isinstance(seg, dict) else None) or "").strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": round(float(seg["start"]), 3),
                "end": round(float(seg["end"]), 3),
            })

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
        "backend": "whisperx",
        "aligned": aligned,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
