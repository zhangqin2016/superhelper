#!/usr/bin/env python3
"""Install / remove optional runtime packs from the agent.

No UI: the user just asks ("装一下专业 PDF 引擎"), the agent maps that to a pack
id and runs this. Self-contained (stdlib only) so it works whether the app is
unpackaged or packaged — it never imports app internals. It shares the on-disk
contract with the main process (src/main/runtime-packs.js): pack files extract
to <userData>/runtime-packs/<id>/ and state lives in
<userData>/runtime-packs.json, so the main process picks installed packs up on
PYTHONPATH automatically.

Release builds may also ship read-only packs under app resources. The app injects
LILY_BUNDLED_RUNTIME_PACK_ROOTS so this script can report those packs as already
available instead of downloading duplicates.

The download is China-friendly: the artifact URL + sha256 come from our server
(which points at a Qiniu CDN object), never from PyPI.

Usage:
  python manage_runtime_pack.py list
  python manage_runtime_pack.py status  <pack_id>
  python manage_runtime_pack.py install <pack_id>
  python manage_runtime_pack.py uninstall <pack_id>

Emits one JSON object on stdout. Errors: {"ok": false, "error": "..."}.

Env:
  LILY_USER_DATA_DIR          required — the app's userData dir (injected by the app)
  LILY_BUNDLED_RUNTIME_PACK_ROOTS optional path-list of bundled pack roots
  LILY_SERVICE_API_BASE_URL   server base (default https://lily.lanrensoft.cn)
"""

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

DEFAULT_API_BASE = "https://lily.lanrensoft.cn"
STATE_SCHEMA_VERSION = 1
# Known installable packs (id → human label). Keep in sync with
# src/main/runtime-pack-specs.js. Available artifacts per platform are decided
# server-side; this is just so `list` can name what the agent may install.
KNOWN_PACKS = {
    "pro-pdf": "Pro PDF engine (Docling): layout/table analysis for complex PDFs (~230MB download)",
    "libreoffice": "LibreOffice runtime: local Office/PDF conversion and spreadsheet recalculation (~500MB download on Windows)",
    "web-automation": "Web automation runtime (Playwright): browser automation modules and browser binaries",
    "ffmpeg": "FFmpeg media tools: local audio/video probing, conversion, clipping, and packaging",
    "pandoc": "Pandoc document converter: Markdown, HTML, LaTeX, EPUB, and related conversions",
}


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    return code


def user_data_dir():
    d = os.environ.get("LILY_USER_DATA_DIR")
    if not d:
        raise RuntimeError("LILY_USER_DATA_DIR not set (run inside the app)")
    return d


def packs_root():
    return os.path.join(user_data_dir(), "runtime-packs")


def pack_dir(pack_id):
    return os.path.join(packs_root(), pack_id)


def bundled_roots():
    raw = os.environ.get("LILY_BUNDLED_RUNTIME_PACK_ROOTS", "")
    return [item for item in raw.split(os.pathsep) if item]


def bundled_pack_dir(pack_id):
    for root in bundled_roots():
        candidate = os.path.join(root, pack_id)
        if os.path.isdir(candidate):
            return candidate
    return None


def state_path():
    return os.path.join(user_data_dir(), "runtime-packs.json")


def read_state():
    try:
        with open(state_path(), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if isinstance(raw, dict) and isinstance(raw.get("installed"), dict):
            return {"schemaVersion": STATE_SCHEMA_VERSION, "installed": raw["installed"]}
    except Exception:  # noqa: BLE001
        pass
    return {"schemaVersion": STATE_SCHEMA_VERSION, "installed": {}}


def write_state(state):
    os.makedirs(os.path.dirname(state_path()), exist_ok=True)
    with open(state_path(), "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def platform_key():
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64" if machine in ("x86_64", "amd64") else machine
    if sys.platform == "darwin":
        os_name = "darwin"
    elif sys.platform.startswith("win"):
        os_name = "win32"
    else:
        os_name = "linux"
    return f"{os_name}-{arch}"


def api_base():
    return os.environ.get("LILY_SERVICE_API_BASE_URL", DEFAULT_API_BASE).rstrip("/")


def resolve_artifact(pack_id):
    url = f"{api_base()}/api/runtime-packs/artifact?pack={pack_id}&platform={platform_key()}"
    # curl (with retry) is steadier than urllib against a CDN/edge that may drop
    # or throttle; urllib is the fallback when curl is absent.
    if shutil.which("curl"):
        out = subprocess.run(
            ["curl", "-fsS", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "30", "--max-time", "90", url],
            check=True,
            capture_output=True,
        )
        data = json.loads(out.stdout.decode("utf-8"))
    else:
        with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 — our own https server
            data = json.loads(resp.read().decode("utf-8"))
    return data.get("artifact")


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url, dest):
    # Prefer curl for large CDN files: it follows redirects, retries, and (via
    # --speed-time) aborts+retries a stalled transfer — plain urllib hangs near
    # EOF on a slow/dropped connection for big artifacts. urllib is the fallback.
    if shutil.which("curl"):
        subprocess.run(
            [
                "curl", "-fSL",
                "--retry", "3", "--retry-delay", "2",
                "--connect-timeout", "30",
                "--speed-limit", "1024", "--speed-time", "60",
                "-o", dest, url,
            ],
            check=True,
        )
        return
    with urllib.request.urlopen(url, timeout=300) as resp, open(dest, "wb") as out:  # noqa: S310
        shutil.copyfileobj(resp, out, 1024 * 256)


def download_verify(url, sha256, dest):
    _download(url, dest)
    if sha256:
        got = _sha256_file(dest)
        if got.lower() != sha256.lower():
            raise RuntimeError(f"SHA256_MISMATCH expected={sha256} got={got}")


def _safe_extract_zip(archive_path, target):
    target_abs = os.path.abspath(target)
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            dest = os.path.abspath(os.path.join(target, member.filename))
            if not dest.startswith(target_abs + os.sep) and dest != target_abs:
                raise RuntimeError(f"UNSAFE_ZIP_MEMBER:{member.filename}")
        archive.extractall(target)


def extract_artifact(archive_path, target, artifact):
    archive_format = str(artifact.get("format") or "").lower().strip()
    url = str(artifact.get("url") or "").lower()
    if archive_format == "zip" or url.endswith(".zip"):
        _safe_extract_zip(archive_path, target)
        return "zip"
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(target, filter="data")  # filter=data blocks path traversal (py3.12)
    return "tar.gz"


def do_install(pack_id):
    if pack_id not in KNOWN_PACKS:
        return emit({"ok": False, "error": f"UNKNOWN_PACK:{pack_id}"}, 1)
    bundled = bundled_pack_dir(pack_id)
    if bundled:
        return emit({"ok": True, "installed": pack_id, "skipped": True, "source": "bundled", "path": bundled})
    artifact = resolve_artifact(pack_id)
    if not artifact or not artifact.get("url"):
        return emit({"ok": False, "error": f"NO_ARTIFACT for {pack_id}/{platform_key()}"}, 1)

    target = pack_dir(pack_id)
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target, exist_ok=True)
    os.makedirs(packs_root(), exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(prefix=f".{pack_id}-", suffix=".tar.gz", dir=packs_root(), delete=False)
    tmp.close()
    try:
        download_verify(artifact["url"], artifact.get("sha256"), tmp.name)
        archive_format = extract_artifact(tmp.name, target, artifact)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(target, ignore_errors=True)
        return emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 1)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    state = read_state()
    state["installed"][pack_id] = {
        "installedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "source": "artifact",
        "version": artifact.get("version"),
        "sha256": artifact.get("sha256"),
        "format": archive_format,
    }
    write_state(state)
    return emit({"ok": True, "installed": pack_id, "version": artifact.get("version"), "path": target})


def do_uninstall(pack_id):
    state = read_state()
    if pack_id not in state["installed"] and bundled_pack_dir(pack_id):
        return emit({"ok": False, "error": "BUNDLED_RUNTIME_PACK_READ_ONLY", "id": pack_id}, 1)
    shutil.rmtree(pack_dir(pack_id), ignore_errors=True)
    state["installed"].pop(pack_id, None)
    write_state(state)
    return emit({"ok": True, "uninstalled": pack_id})


def do_status(pack_id):
    state = read_state()
    rec = state["installed"].get(pack_id)
    bundled = bundled_pack_dir(pack_id)
    if rec:
        return emit({"ok": True, "id": pack_id, "installed": True, "source": rec.get("source"), "info": rec})
    if bundled:
        return emit({"ok": True, "id": pack_id, "installed": True, "source": "bundled", "path": bundled, "info": None})
    return emit({"ok": True, "id": pack_id, "installed": False, "info": None})


def do_list():
    state = read_state()
    packs = [
        {
            "id": pid,
            "label": label,
            "installed": pid in state["installed"] or bool(bundled_pack_dir(pid)),
            "source": state["installed"].get(pid, {}).get("source") or ("bundled" if bundled_pack_dir(pid) else None),
            "version": state["installed"].get(pid, {}).get("version"),
        }
        for pid, label in KNOWN_PACKS.items()
    ]
    return emit({"ok": True, "platform": platform_key(), "packs": packs})


def main(argv):
    if len(argv) < 2:
        return emit({"ok": False, "error": "USAGE"}, 1)
    cmd = argv[1]
    try:
        if cmd == "list":
            return do_list()
        if cmd == "status" and len(argv) == 3:
            return do_status(argv[2])
        if cmd == "install" and len(argv) == 3:
            return do_install(argv[2])
        if cmd == "uninstall" and len(argv) == 3:
            return do_uninstall(argv[2])
        return emit({"ok": False, "error": "USAGE"}, 1)
    except Exception as exc:  # noqa: BLE001 — surface, never crash silently
        return emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
