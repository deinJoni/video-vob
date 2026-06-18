#!/usr/bin/env python3
"""Optional face-presence detector for INSPECT take-quality scoring (v3.9).

Reads a JSON list of keyframe image paths, runs OpenCV's bundled Haar frontal-face
cascade over each, and writes a JSON array of per-image face reads to the output
path. Prints a one-line JSON envelope to stdout for the Node caller.

This is an ADVISORY signal. It degrades, never blocks INSPECT: if OpenCV is not
installed the Node side simply records face:null and the take-quality score is
computed from the other components (delivery + exposure + sharpness). OpenCV Haar
is chosen for the lowest possible friction — `pip install opencv-python-headless`
ships the cascade XML (cv2.data.haarcascades), no model download, CPU, fast on the
512w keyframes INSPECT already extracted.

Usage:  python3 face_detect.py <input_list.json> <output.json>
  input_list.json : ["/abs/seg_0.jpg", "/abs/seg_1.jpg", ...]
  output.json     : [{"path","present","count","area_frac","centered"}, ...]
Envelope (stdout, last line): {"ok": true, "backend": "...", "images": N, "faces": M}
"""

import json
import sys


def emit(obj):
    """Print the single-line result envelope the Node caller parses."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        emit({"ok": False, "reason": "usage: face_detect.py <input_list.json> <output.json>"})
        return 2

    in_path, out_path = sys.argv[1], sys.argv[2]
    try:
        with open(in_path, "r") as fh:
            image_paths = json.load(fh)
        if not isinstance(image_paths, list):
            raise ValueError("input must be a JSON array of image paths")
    except Exception as exc:  # noqa: BLE001 — degrade on any read/parse failure
        emit({"ok": False, "reason": "bad_input: %s" % exc})
        return 1

    try:
        import cv2  # type: ignore
    except Exception as exc:  # noqa: BLE001 — OpenCV absent is the expected degrade path
        emit({"ok": False, "reason": "opencv_unavailable: %s" % exc})
        return 1

    try:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            emit({"ok": False, "reason": "cascade_load_failed: %s" % cascade_path})
            return 1
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "reason": "cascade_init_failed: %s" % exc})
        return 1

    results = []
    total_faces = 0
    for p in image_paths:
        rec = {"path": p, "present": False, "count": 0, "area_frac": None, "centered": None}
        try:
            img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
            if img is None:
                rec["error"] = "unreadable"
                results.append(rec)
                continue
            h, w = img.shape[:2]
            if h <= 0 or w <= 0:
                rec["error"] = "empty"
                results.append(rec)
                continue
            # minSize ~6% of the frame filters cascade noise (texture false-positives)
            # while keeping real talking-head faces, which dominate the frame.
            min_side = max(16, int(round(0.06 * min(w, h))))
            faces = cascade.detectMultiScale(
                img, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side)
            )
            n = len(faces)
            rec["present"] = bool(n > 0)
            rec["count"] = int(n)
            if n > 0:
                # Largest face drives area/centered (the subject, not a bystander).
                fx, fy, fw, fh = max(faces, key=lambda b: int(b[2]) * int(b[3]))
                rec["area_frac"] = round((float(fw) * float(fh)) / (float(w) * float(h)), 4)
                cx = (float(fx) + float(fw) / 2.0) / float(w)
                cy = (float(fy) + float(fh) / 2.0) / float(h)
                rec["centered"] = bool(0.18 <= cx <= 0.82 and 0.12 <= cy <= 0.88)
                total_faces += int(n)
        except Exception as exc:  # noqa: BLE001 — one bad frame never kills the batch
            rec["error"] = "detect_failed: %s" % exc
        results.append(rec)

    try:
        with open(out_path, "w") as fh:
            json.dump(results, fh)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "reason": "write_failed: %s" % exc})
        return 1

    emit({"ok": True, "backend": "opencv-haar", "images": len(image_paths), "faces": total_faces})
    return 0


if __name__ == "__main__":
    sys.exit(main())
