import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scanner = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/scan_web_system.py");

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.warn("web-system-auth-wall-detection: python not found; skipped");
  process.exit(0);
}

const probe = `
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("scan_web_system", ${JSON.stringify(scanner)})
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

cfg = mod.ScanConfig(
    base_url="https://erp.example.com/signin",
    allowed_domains=["example.com"],
    max_pages=40,
    timeout_ms=15000,
    headful=False,
    storage_state="/tmp/session.json",
    interactive_readonly=True,
    learning_mode="read-only",
    test_environment="",
    allow_mutating_learning=False,
    har_path=None,
    frontend_source=None,
    route_hint_urls=[],
    route_hint_count=0,
)
no_state_cfg = mod.ScanConfig(
    base_url=cfg.base_url,
    allowed_domains=cfg.allowed_domains,
    max_pages=cfg.max_pages,
    timeout_ms=cfg.timeout_ms,
    headful=cfg.headful,
    storage_state=None,
    interactive_readonly=cfg.interactive_readonly,
    learning_mode=cfg.learning_mode,
    test_environment=cfg.test_environment,
    allow_mutating_learning=cfg.allow_mutating_learning,
    har_path=cfg.har_path,
    frontend_source=cfg.frontend_source,
    route_hint_urls=cfg.route_hint_urls,
    route_hint_count=cfg.route_hint_count,
)

password_login = {
    "url": "https://erp.example.com/signin",
    "title": "Sign in",
    "textSample": "Sign in to continue",
    "inputs": [{"type": "password", "label": "Password", "name": "password"}],
    "buttons": [{"text": "Sign in"}],
    "forms": [],
    "headings": [{"text": "Sign in"}],
    "navItems": [],
    "metrics": {"tables": 0, "networkContracts": 0},
}
assert mod.detect_auth_wall(password_login, cfg)["code"] == "AUTH_NOT_RESTORED"
assert mod.detect_auth_wall(password_login, no_state_cfg) is None

sso_login = {
    "url": "https://erp.example.com/login",
    "title": "Login",
    "textSample": "Use Microsoft SSO to login",
    "inputs": [{"type": "email", "label": "Email", "name": "email"}],
    "buttons": [{"text": "Sign in with Microsoft"}],
    "forms": [],
    "headings": [{"text": "Login"}],
    "navItems": [],
    "metrics": {"tables": 0, "networkContracts": 0},
}
assert mod.detect_auth_wall(sso_login, cfg)["code"] == "AUTH_NOT_RESTORED"

business_page = {
    "url": "https://erp.example.com/security/login-audit",
    "title": "Login Audit",
    "textSample": "Login audit table for enterprise users",
    "inputs": [],
    "buttons": [{"text": "Search"}],
    "forms": [],
    "headings": [{"text": "Login Audit"}],
    "navItems": [{"text": "Dashboard"}, {"text": "Users"}, {"text": "Security"}],
    "metrics": {"tables": 1, "networkContracts": 1},
}
assert mod.detect_auth_wall(business_page, cfg) is None
`;

const result = spawnSync(python, ["-c", probe], { cwd: ROOT, encoding: "utf8" });
assert(result.status === 0, result.stderr || result.stdout || "auth wall probe failed");
console.log("PASS: test-web-system-auth-wall-detection");
