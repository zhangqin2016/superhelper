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
import sys
import tempfile
import shutil
import subprocess

# Input filters to retry with when the default module cannot reach the target.
# A hint table, not a routing table: a source not listed here simply gets one
# attempt, and the error it raises still carries LibreOffice's own reason.
RETRY_INPUT_FILTERS = {
    ".html": "HTML (StarWriter)",
    ".htm": "HTML (StarWriter)",
    ".xhtml": "HTML (StarWriter)",
}

DEFAULT_TIMEOUT_SECONDS = 180


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
    return env


def _subprocess_options():
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


def _profile_uri(path):
    return "file://" + os.path.abspath(path).replace(os.sep, "/")


def _run(source, out_dir, target, infilter, timeout):
    args = [soffice_command(), "--headless", "--invisible", "--nologo", "--nodefault",
            "--nofirststartwizard", "--nolockcheck", "--norestore"]
    if infilter:
        args.append("--infilter=%s" % infilter)
    args += ["--convert-to", target, "--outdir", out_dir,
             "-env:UserInstallation=%s" % _profile_uri(os.path.join(out_dir, ".lo-profile")), source]
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


def convert(source, out_dir, target, timeout=DEFAULT_TIMEOUT_SECONDS, infilter=None):
    """Convert one file and return the output path, or raise ConversionError.

    Never returns a path that does not exist. `infilter` forces a specific input
    filter and disables the retry."""
    if not os.path.isfile(source):
        raise ConversionError("source file does not exist: %s" % source)
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
            detail = (result.stderr or b"").decode("utf-8", "replace").strip() \
                or (result.stdout or b"").decode("utf-8", "replace").strip()
            reasons.append("%s -> rc=%s %s" % (attempt or "default filter", result.returncode, detail or "no output, no message"))
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    raise ConversionError(
        "LibreOffice produced no %s for %s. %s" % (target, os.path.basename(source), " | ".join(reasons))
    )


def _selftest():
    import tempfile

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


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
