# Windows Store EXE Release Readiness Design

## Goal

Add a repeatable, evidence-producing Windows pre-submission check for the current
Lily Workbench x64 NSIS installer. The check must cover the three outstanding
release tasks:

1. prove that the final EXE installs and uninstalls silently;
2. prove that a fresh Windows user can launch the installed app without a crash;
3. run the certification checks that Microsoft currently documents for direct
   MSI/EXE submissions, while clearly marking Windows App Certification Kit
   (WACK) as not applicable to the current unpackaged NSIS EXE.

The scripts are prepared now and run later against the exact signed, versioned
installer that will be submitted to Partner Center.

## Context and decisions

The existing release path builds an Electron Builder 26.8.1 x64 NSIS EXE. It has
static configuration guards and verifies `dist/win-unpacked`, but it never runs
the final installer. The current installer supports NSIS's case-sensitive `/S`
switch, defaults to a per-user install, and emits a `QuietUninstallString` that
must be discovered from the registry rather than reconstructed from a presumed
path.

Three approaches were considered:

1. **Manual checklist only.** Smallest change, but it produces inconsistent
   evidence and can miss transient UI, startup crashes, registry metadata, or
   uninstall remnants.
2. **GitHub Actions release gate.** Useful later, but a hosted runner does not
   provide a dependable interactive desktop for Electron window validation, and
   the current release workflow does not yet own the Windows signing secret.
3. **Local clean-Windows runner plus Windows Sandbox launcher.** Recommended.
   It exercises the exact signed installer in an active desktop session, can run
   offline, records machine-readable evidence, and does not change production
   packaging or release behavior.

This design implements approach 3. CI integration is explicitly deferred until
the runner has been proven on a real Windows machine and the signed release path
is established.

## Scope

### In scope

- A single PowerShell lifecycle runner for preflight, silent install, installed
  state validation, first launch, silent uninstall, residue inspection, and
  report generation.
- A Windows Sandbox launcher that stages the chosen installer and test scripts,
  disables networking, and preserves the generated reports on the host.
- Authenticode reporting for the installer and installed PE files. Strict
  signature enforcement is enabled for the final Store-gate command but can be
  disabled while tasks 5 and 6 are tested before the certificate is ready.
- A Chinese operator guide with exact commands, acceptance criteria, evidence to
  retain, and links to Microsoft's current MSI/EXE requirements.
- An auto-discovered repository guard that locks in the safety and coverage
  contracts of the Windows scripts.
- A link from the existing release/deploy SOP to the new Windows readiness guide.

### Out of scope

- Buying or provisioning the code-signing certificate.
- Changing the Windows installer target, signing the release, uploading the
  installer, deploying the privacy policy, or generating Store artwork.
- Enabling deletion of Lily user data during uninstall. That is a separate,
  potentially destructive product decision.
- Adding an MSIX target or claiming that WACK passed for an unpackaged EXE.
- Modifying GitHub Actions or making this a publication blocker in this phase.
- Testing upgrades from an older Lily version or the auto-update feed.

## File structure

### `scripts/smoke-windows-store-installer.ps1`

The Windows-only lifecycle runner. Its public inputs are:

- `-Installer` (required): exact `.exe` being tested;
- `-OutputDirectory`: durable evidence directory;
- `-ExpectedPublisher`: expected Add/Remove Programs publisher and signer text;
- `-ExpectedVersion`: optional exact version assertion;
- `-RequireSignature`: makes any invalid or missing required PE signature fatal;
- `-AllowUserDataRemnants`: records intentional user-data retention as a warning
  instead of failing the clean-uninstall gate;
- bounded install, launch, and uninstall timeouts.

The default install scope is explicitly current-user. The runner invokes the
installer with `/S /currentuser`, never relies on an upstream default, and never
hardcodes the uninstall executable path.

### `scripts/start-windows-store-sandbox.ps1`

The host-side convenience entry point. It:

1. verifies that Windows Sandbox is available;
2. creates a timestamped staging directory under `.lily-work/`;
3. copies the selected installer and lifecycle runner into that directory;
4. generates a temporary `.wsb` file with networking disabled and the staging
   directory mapped read/write;
5. starts Windows Sandbox and runs the lifecycle check automatically;
6. leaves JSON, Markdown, transcript, Chromium, and registry evidence in the
   mapped host directory.

The sandbox remains open after the run and displays the Markdown summary so a
tester can inspect a failure before closing it.

### `scripts/test-windows-store-readiness.mjs`

An auto-discovered static contract test. It does not pretend to replace a real
Windows run. It fails if future edits remove the important safety or coverage
properties, including explicit `/S /currentuser`, registry-derived
`QuietUninstallString`, renderer readiness probing, crash-event inspection,
signature inspection, bounded waits, nonzero failure exits, and non-destructive
cleanup.

### `docs/windows-store-release-readiness.md`

The operator-facing runbook. It documents prerequisites, the unsigned rehearsal
command, the final signed Store-gate command, Sandbox use, report interpretation,
Microsoft submission fields, WACK applicability, and the manual evidence that
cannot be inferred from a macOS development machine.

### `docs/release-and-deploy-sop.md`

Receives only a short link to the new Windows-specific gate. The existing desktop
build and publishing flow remains unchanged.

## Lifecycle and checks

### 1. Preflight

The runner fails before mutation unless it is on Windows, the installer exists
and is an EXE, no Lily process is running, and no existing Lily uninstall entry
is present. It records OS/build information, current privilege level, installer
size and SHA-256, and installer Authenticode status.

For the final gate, `-RequireSignature` requires a valid trusted Authenticode
signature. If `-ExpectedPublisher` is supplied, both the signer subject and the
installed publisher metadata must match it.

### 2. Silent install

The exact invocation is `installer.exe /S /currentuser`. While it runs, the
runner polls the installer process tree for visible top-level windows. UAC is not
treated as an installer UI failure because Microsoft explicitly permits a UAC
prompt, although the current-user path should not normally need one.

The install passes only if it exits successfully within the timeout and no
installer-owned visible window is detected.

### 3. Installed state

The runner queries current-user and machine-wide uninstall roots and requires
exactly one Lily Workbench product entry. It verifies non-empty and relevant
DisplayName, Publisher, DisplayVersion, InstallLocation, UninstallString, and
QuietUninstallString fields; confirms the main EXE and expected shortcuts; and
flags extra Lily product entries as bundleware risk.

It discovers the real install directory from the uninstall entry. It scans files
for the PE `MZ` signature rather than trusting filename extensions, records every
Authenticode result, and makes missing/invalid signatures fatal only when
`-RequireSignature` is active.

### 4. First launch

The installed `LilyWorkbench.exe` is started with Chromium logging and a temporary
localhost remote-debugging port. Success requires all of the following within a
bounded timeout:

- the process remains alive;
- a visible main window appears;
- Chromium's debugging endpoint exposes a page titled `Lily Workbench` whose URL
  is the packaged renderer page;
- no matching Application Error or Windows Error Reporting crash event appears.

The app is then asked to close through its main window. Failure to close normally
is recorded; forced termination is only test cleanup and never turns the check
into a pass.

### 5. Silent uninstall and residue inspection

The runner executes the registry-provided `QuietUninstallString`, monitors for
visible uninstaller windows, and then polls until the asynchronous NSIS cleanup
finishes. It requires the uninstall entry, install directory, program shortcuts,
and product-owned machine registry entries to disappear.

Lily currently preserves user data. The runner therefore inventories AppData and
Documents remnants but never deletes them. By default those remnants fail the
Microsoft clean-uninstall gate. `-AllowUserDataRemnants` may downgrade only that
specific finding to a warning for an internal rehearsal; the final Store report
must show which paths remain and cannot silently suppress them.

## Reports and exit behavior

Every run produces:

- `readiness-report.json`: stable structured metadata and a list of checks with
  `pass`, `warning`, `fail`, or `not_applicable` status;
- `readiness-summary.md`: concise human-readable outcome and remediation list;
- `readiness-transcript.log`: command progress without secrets;
- Chromium and Windows event-log excerpts relevant to startup;
- installed/uninstalled registry snapshots and a PE signature inventory.

The process exits `0` only when every required check passes. Warnings and
not-applicable checks remain visible in the reports. Timeouts, malformed registry
commands, missing tools, or cleanup failures are explicit failures.

If a failure occurs after installation, `finally` attempts the normal registered
uninstaller once. It never invokes the repository's aggressive full-uninstall
utility and never deletes user data automatically. If normal cleanup fails, the
report names the remaining installation and the operator action required.

## WACK applicability

The current Microsoft WACK command-line documentation accepts an installed
package full name or an AppX/MSIX package path. The older
`-apptype desktop -setuppath setup.exe` flow belongs to previous-version Windows
8.1 documentation and is not a supported 2026 gate for Lily's unpackaged NSIS
EXE.

Accordingly, this readiness check follows Microsoft's current direct MSI/EXE
validation requirements instead of fabricating a WACK result. The runbook links
to:

- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements>
- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation>
- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process>
- <https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-app-certification-kit>

If Lily later ships MSIX, WACK becomes a separate package-level gate and must be
designed against the then-current SDK and report format.

## Verification strategy

Implementation follows test-first development:

1. add the static contract test and observe it fail because the runner is absent;
2. add the minimum lifecycle runner and make the contract test pass;
3. add the Sandbox launcher contract and observe the new assertion fail;
4. implement the launcher and documentation;
5. run the focused tests and the repository unit suite;
6. on Windows, run an unsigned rehearsal to validate tasks 5 and 6;
7. after the certificate is ready, run the exact final signed installer with
   strict signatures in a fresh offline Sandbox and retain the report directory.

macOS verification can prove script structure and repository integration, but it
cannot prove the installer lifecycle. Until a report from a real Windows run is
available, the work must be described as “test tooling prepared,” not “Windows
certification passed.”

## Capability-gate impact

The new tooling is outside the runtime capability path and does not change how
Lily answers, routes, executes, learns, or remembers. Its failure mode is
fail-loud: it cannot publish, sign, delete user data, or weaken the existing app.
The auto-discovered guard prevents later edits from silently turning skipped or
unknown checks into passes.
