"""LibreOffice conversion that cannot fail silently.

`soffice --convert-to` exits 0 when it has no export filter for the requested
target: it writes nothing and prints the reason only on stderr. A caller that
checks the return code reports success and hands back a path that does not
exist. Acceptance 2026-09-17 DEF-04 caught exactly that — HTML to DOCX returned
rc=0 with `no export filter ... found, aborting` and no file.

Two rules, both general:

1. Success is a non-empty output FILE, never a return code.
2. When a conversion produces nothing and the source format is one LibreOffice
   can load through more than one module, retry once with an explicit input
   filter. HTML is the case that bites: Writer/Web loads it by default and only
   knows how to export PDF, while Writer proper exports the whole Office family.

[gate: office-conversion-no-silent-failure]
"""

import os
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
    expected = _expected_output(source, out_dir, target)

    attempts = [infilter] if infilter else [None]
    if infilter is None:
        retry = RETRY_INPUT_FILTERS.get(os.path.splitext(source)[1].lower())
        if retry:
            attempts.append(retry)

    reasons = []
    for attempt in attempts:
        result = _run(source, out_dir, target, attempt, timeout)
        if _produced(expected):
            return expected
        detail = (result.stderr or b"").decode("utf-8", "replace").strip() \
            or (result.stdout or b"").decode("utf-8", "replace").strip()
        reasons.append("%s -> rc=%s %s" % (attempt or "default filter", result.returncode, detail or "no output, no message"))

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
