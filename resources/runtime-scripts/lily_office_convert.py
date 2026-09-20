"""LibreOffice conversion that cannot fail silently.

`soffice --convert-to` exits 0 when it has no export filter for the requested
target: it writes nothing and prints the reason only on stderr. A caller that
checks the return code reports success and hands back a path that does not
exist. Acceptance 2026-09-17 DEF-04 caught exactly that — HTML to DOCX returned
rc=0 with `no export filter ... found, aborting` and no file.

Three rules, all general:

1. Success is a non-empty output FILE, never a return code.
2. When a conversion produces nothing and the source format is one LibreOffice
   can load through more than one module, retry once with an explicit input
   filter. HTML is the case that bites: Writer/Web loads it by default and only
   knows how to export PDF, while Writer proper exports the whole Office family.
3. A conversion never destroys a file it did not produce. LibreOffice names its
   output after the source's BASENAME, so `报告.docx` and `报告.pptx` both want
   `报告.pdf` — the second call silently overwrote the first and both returned
   success. Acceptance 2026-09-17 P21. Output now lands through a staging
   directory and keeps the plain name only while it is free or already this
   source's own; anything else is disambiguated by the source extension and the
   caller is told.

[gate: office-conversion-no-silent-failure]
"""

import json
import os
import re
import sys
import tempfile
import shutil
import subprocess
from pathlib import Path

# Input filters to retry with when the default module cannot reach the target.
# A hint table, not a routing table: a source not listed here simply gets one
# attempt, and the error it raises still carries LibreOffice's own reason.
RETRY_INPUT_FILTERS = {
    ".html": "HTML (StarWriter)",
    ".htm": "HTML (StarWriter)",
    ".xhtml": "HTML (StarWriter)",
}

DEFAULT_TIMEOUT_SECONDS = 180


# The host runs this through an Electron binary in Node mode, so Chromium's own
# logger writes a line into every child's stderr before soffice says anything:
#   [0917/080937.774442:ERROR:electron/.../codesign_util.cc:79] task_name_for_pid...
# It is harmless and constant, but it is also the first thing a reader sees in a
# failure message, and "stderr is not empty" is how most callers judge a
# conversion. Acceptance 2026-09-17 DEF-04. Narrow on purpose: only the host
# logger's own line format matches, so real soffice output is never hidden.
# [gate: office-conversion-no-silent-failure]
_HOST_DIAGNOSTIC_RE = re.compile(r"^\[\d{4}/\d{6}\.\d+:(?:ERROR|WARNING|INFO|VERBOSE\d*|FATAL):[^\]]+\]")


def _without_host_noise(text):
    """Drop host-logger lines from captured output. Never raises."""
    try:
        lines = [line for line in str(text or "").splitlines() if not _HOST_DIAGNOSTIC_RE.match(line.lstrip())]
        return "\n".join(lines).strip()
    except Exception:
        return str(text or "").strip()


class ConversionError(RuntimeError):
    """A conversion that produced no usable file, carrying LibreOffice's reason."""


def soffice_command():
    program = os.environ.get("LILY_LIBREOFFICE_PROGRAM")
    if program:
        names = ("soffice.exe", "soffice", "soffice.bin") if os.name == "nt" else ("soffice", "soffice.bin")
        for name in names:
            candidate = os.path.join(program, name)
            if os.path.exists(candidate):
                return candidate
    if os.name == "nt":
        return shutil.which("soffice.exe") or shutil.which("soffice") or "soffice.exe"
    return shutil.which("soffice") or "soffice"


def _env():
    env = os.environ.copy()
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")
    env.setdefault("SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION", "1")
    if os.name == "nt":
        # File conversion needs no physical printer. These are the shared VCL
        # gates in LO 25.2 vcl/source/gdi/print.cxx, unlike the Unix sync flag.
        # Scope them to this child; never alter the user's printing environment.
        env["SAL_DISABLE_PRINTERLIST"] = "1"
        env["SAL_DISABLE_DEFAULTPRINTER"] = "1"
    return env


def _subprocess_options():
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


def _profile_uri(path):
    return Path(path).absolute().as_uri()


def _run(source, out_dir, target, infilter, timeout):
    # LO creates deeply nested profile files; nesting its profile in a Windows
    # deliverable directory can crash the process even when the output fits.
    with tempfile.TemporaryDirectory(prefix="lily-lo-") as profile:
        return _run_with_profile(source, out_dir, target, infilter, timeout, profile)


def _run_with_profile(source, out_dir, target, infilter, timeout, profile):
    args = [soffice_command(), "--headless", "--invisible", "--nologo", "--nodefault",
            "--nofirststartwizard", "--nolockcheck", "--norestore"]
    if infilter:
        args.append("--infilter=%s" % infilter)
    args += ["--convert-to", target, "--outdir", out_dir,
             "-env:UserInstallation=%s" % _profile_uri(profile), source]
    # check=False on purpose: the interesting failure exits 0. The output file is
    # the verdict, and stderr is the explanation.
    return subprocess.run(args, check=False, capture_output=True, timeout=timeout,
                          env=_env(), **_subprocess_options())


def _expected_output(source, out_dir, target):
    # --convert-to accepts "pdf" and "docx:writer_filter"; the extension is the
    # part before the first colon.
    extension = str(target).split(":")[0].strip()
    base = os.path.splitext(os.path.basename(source))[0]
    return os.path.join(out_dir, "%s.%s" % (base, extension))


# Which source produced which output, so re-converting the SAME file overwrites
# its own result (what a caller expects) while a different source never does.
MANIFEST_NAME = ".lily-convert.json"


def _read_manifest(out_dir):
    try:
        with open(os.path.join(out_dir, MANIFEST_NAME), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _record_manifest(out_dir, name, source):
    try:
        data = _read_manifest(out_dir)
        data[name] = os.path.abspath(source)
        tmp = os.path.join(out_dir, MANIFEST_NAME + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.replace(tmp, os.path.join(out_dir, MANIFEST_NAME))
    except Exception:
        pass  # provenance is a safeguard, never a reason to fail a conversion


def _publish_path(source, out_dir, target):
    """Where this conversion may safely land, and whether the name was changed.

    The plain `<basename>.<target>` is used while it is free or already belongs to
    this same source. Otherwise the source extension disambiguates it, so a
    deliverable is never destroyed by a differently-typed sibling."""
    extension = str(target).split(":")[0].strip()
    base = os.path.splitext(os.path.basename(source))[0]
    source_key = os.path.abspath(source)
    manifest = _read_manifest(out_dir)

    preferred = os.path.join(out_dir, "%s.%s" % (base, extension))
    if not os.path.exists(preferred) or manifest.get(os.path.basename(preferred)) == source_key:
        return preferred, False

    source_ext = os.path.splitext(os.path.basename(source))[1].lstrip(".").lower() or "src"
    for suffix in ["", *["-%d" % n for n in range(2, 50)]]:
        candidate = os.path.join(out_dir, "%s.%s%s.%s" % (base, source_ext, suffix, extension))
        if not os.path.exists(candidate) or manifest.get(os.path.basename(candidate)) == source_key:
            return candidate, True
    return preferred, True


def _produced(path):
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except OSError:
        return False


def _resolve_source(source):
    """Resolve a source path the way the caller meant it.

    A relative path was resolved against the process cwd, which is not the
    workspace, so a file that plainly exists was reported as missing and the
    agent concluded the file was gone. Relative paths are resolved against the
    workspace root when one is known (LILY_WORKSPACE, set for runtime scripts),
    and the error names every root that was searched instead of only the string
    it was handed — "does not exist" is a claim about the filesystem, so it has
    to say where it looked.
    """
    raw = str(source or "")
    if os.path.isabs(raw):
        return raw, [raw]
    roots = [r for r in (os.environ.get("LILY_WORKSPACE"), os.getcwd()) if r]
    tried = []
    for root in roots:
        candidate = os.path.normpath(os.path.join(root, raw))
        tried.append(candidate)
        if os.path.isfile(candidate):
            return candidate, tried
    return (tried[0] if tried else raw), tried


def convert(source, out_dir, target, timeout=DEFAULT_TIMEOUT_SECONDS, infilter=None):
    """Convert one file and return the output path, or raise ConversionError.

    Never returns a path that does not exist. `infilter` forces a specific input
    filter and disables the retry."""
    source, tried = _resolve_source(source)
    if not os.path.isfile(source):
        raise ConversionError(
            "source file does not exist: %s (looked in: %s)" % (source, ", ".join(tried) or "-")
        )
    os.makedirs(out_dir, exist_ok=True)

    # Convert into a private staging directory so LibreOffice can never land on
    # top of an existing deliverable, then publish under a name that is free.
    staging = tempfile.mkdtemp(prefix=".lily-convert-", dir=out_dir)
    expected = _expected_output(source, staging, target)

    attempts = [infilter] if infilter else [None]
    if infilter is None:
        retry = RETRY_INPUT_FILTERS.get(os.path.splitext(source)[1].lower())
        if retry:
            attempts.append(retry)

    reasons = []
    try:
        for attempt in attempts:
            result = _run(source, staging, target, attempt, timeout)
            if _produced(expected):
                final, renamed = _publish_path(source, out_dir, target)
                os.replace(expected, final)
                _record_manifest(out_dir, os.path.basename(final), source)
                if renamed:
                    sys.stderr.write(
                        "lily_office_convert: %s would have overwritten a different source's output; "
                        "wrote %s instead\n" % (os.path.basename(source), os.path.basename(final))
                    )
                return final
            detail = _without_host_noise((result.stderr or b"").decode("utf-8", "replace")) \
                or _without_host_noise((result.stdout or b"").decode("utf-8", "replace"))
            reasons.append("%s -> rc=%s %s" % (attempt or "default filter", result.returncode, detail or "no output, no message"))
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    raise ConversionError(
        "LibreOffice produced no %s for %s. %s" % (target, os.path.basename(source), " | ".join(reasons))
    )


def _selftest():
    import tempfile
    from urllib.parse import unquote, urlsplit

    profile = os.path.abspath(os.path.join(tempfile.gettempdir(), "profile space #\u4e2d\u6587"))
    uri = urlsplit(_profile_uri(profile))
    assert uri.scheme == "file" and not uri.netloc
    assert unquote(uri.path).lstrip("/") == profile.replace(os.sep, "/").lstrip("/")
    assert not uri.fragment and " " not in uri.path

    work = tempfile.mkdtemp()
    html = os.path.join(work, "page.html")
    with open(html, "w", encoding="utf-8") as handle:
        handle.write("<html><body><h1>标题</h1><p>正文 body text</p></body></html>")

    # The regression itself: HTML to DOCX exits 0 and writes nothing through the
    # default module, and must still produce a file here.
    docx = convert(html, os.path.join(work, "a"), "docx")
    assert os.path.getsize(docx) > 0, "HTML to DOCX must produce a real file"

    # The path that always worked must keep working, and unchanged.
    pdf = convert(html, os.path.join(work, "b"), "pdf")
    assert os.path.getsize(pdf) > 0, "HTML to PDF must keep working"

    # A conversion that produces nothing must RAISE and carry LibreOffice's own
    # reason, never return a phantom path. Forcing a filter that cannot load this
    # source reproduces the rc=0-with-no-output shape and disables the retry.
    try:
        convert(html, os.path.join(work, "c"), "docx", infilter="Impress MS PowerPoint 2007 XML")
        raise AssertionError("a conversion that produces nothing must raise")
    except ConversionError as error:
        assert "produced no docx" in str(error), str(error)
        assert "rc=" in str(error), "the error must carry what LibreOffice actually said"

    assert not os.path.exists(_expected_output(html, os.path.join(work, "c"), "docx"))

    # Two sources with the same basename must both survive. Acceptance 2026-09-17
    # P21: the second conversion silently overwrote the first and both returned
    # success, so a Word deliverable disappeared without a word.
    collide = os.path.join(work, "collide")
    os.makedirs(collide, exist_ok=True)
    for extension in ("html", "htm"):
        with open(os.path.join(collide, "report.%s" % extension), "w", encoding="utf-8") as handle:
            handle.write("<html><body><p>%s 版本</p></body></html>" % extension)
    first = convert(os.path.join(collide, "report.html"), os.path.join(work, "e"), "pdf")
    second = convert(os.path.join(collide, "report.htm"), os.path.join(work, "e"), "pdf")
    assert first != second, "a differently-typed sibling must not take the same output path"
    assert os.path.exists(first) and os.path.getsize(first) > 0, "the first deliverable must survive"
    assert os.path.exists(second) and os.path.getsize(second) > 0
    assert os.path.basename(first) == "report.pdf", "the first one keeps the plain name"
    assert "htm" in os.path.basename(second), "the second is disambiguated by its source extension"
    again = convert(os.path.join(collide, "report.html"), os.path.join(work, "e"), "pdf")
    assert again == first, "re-converting the SAME source reuses its own output name"

    # A missing source is refused before LibreOffice is ever started.
    try:
        convert(os.path.join(work, "gone.docx"), os.path.join(work, "d"), "pdf")
        raise AssertionError("a missing source must raise")
    except ConversionError as error:
        assert "does not exist" in str(error)

    print("lily_office_convert selftest ok")


def main(argv=None):
    """Convert one file from the command line.

    The module was importable but had no CLI, so a caller outside Python had to
    write a wrapper to reach it — while the neighbouring runtime scripts all
    speak the same JSON-on-stdout contract. Failures print the same JSON shape
    with ok=false rather than a traceback, so a caller never has to parse a
    Python stack to learn what went wrong.
    """
    import argparse
    import json

    parser = argparse.ArgumentParser(prog="lily_office_convert", description="Convert a document with LibreOffice.")
    parser.add_argument("source", help="file to convert; a relative path resolves against LILY_WORKSPACE")
    parser.add_argument("--out-dir", required=True, help="directory to write the converted file into")
    parser.add_argument("--to", required=True, help="target extension, e.g. pdf, docx, html")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--infilter", default=None, help="force a specific input filter and disable the retry")
    parser.add_argument("--selftest", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.selftest:
        _selftest()
        return 0
    try:
        output = convert(args.source, args.out_dir, args.to, timeout=args.timeout, infilter=args.infilter)
    except ConversionError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    # convert() never returns a path that does not exist, so ok=true already
    # means the file is there; the size is reported because "produced a file"
    # and "produced a usable file" are different claims.
    print(json.dumps({"ok": True, "output": output, "bytes": os.path.getsize(output)}))
    return 0


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv and len(sys.argv) == 2:
        _selftest()
        sys.exit(0)
    sys.exit(main())
