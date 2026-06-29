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
  console.warn("web-system-interaction-explorer: python not found; skipped");
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
    base_url="https://erp.example.com/dashboard",
    allowed_domains=["example.com"],
    max_pages=20,
    timeout_ms=15000,
    headful=True,
    storage_state="/tmp/session.json",
    interactive_readonly=True,
    learning_mode="read-only",
    test_environment="",
    allow_mutating_learning=False,
    har_path=None,
    frontend_source=None,
    route_hint_urls=[],
    route_hint_count=0,
    output_path=None,
)

class Locator:
    def __init__(self, page):
        self.page = page
    @property
    def first(self):
        return self
    def click(self, **kwargs):
        self.page.clicks += 1
        self.page.state = 1
        self.page.url = "https://erp.example.com/meeting/groups/dashboard"

class FakePage:
    def __init__(self):
        self.state = 0
        self.url = "https://erp.example.com/dashboard"
        self.clicks = 0
    def goto(self, *args, **kwargs):
        raise AssertionError("interactive exploration must not reload the source page for every candidate")
    def locator(self, selector):
        return Locator(self)

class Recorder:
    def clear(self):
        pass
    def snapshot(self):
        return []

def fake_wait(page, timeout_ms):
    pass

def fake_extract(page, current_url, allowed_domains, config=None):
    if page.state == 0:
        return {
            "id": "dashboard",
            "url": page.url,
            "urlPattern": "https://erp.example.com/dashboard",
            "title": "Dashboard",
            "fingerprint": "dashboard-open",
            "interactionCandidates": [
                {"scanId": "i0", "text": "Meeting Management", "role": "menuitem", "reason": "menuitem", "riskHint": "read", "insideForm": False, "url": ""},
            ],
            "metrics": {"buttons": 1, "forms": 0, "networkContracts": 0},
            "_nextUrls": [],
        }
    return {
        "id": "meeting",
        "url": page.url,
        "urlPattern": "https://erp.example.com/meeting/groups/dashboard",
        "title": "Meeting Management",
        "fingerprint": "meeting-page",
        "interactionCandidates": [],
        "metrics": {"buttons": 2, "forms": 0, "networkContracts": 0},
        "_nextUrls": ["https://erp.example.com/meeting/groups/list"],
    }

mod.wait_for_spa_ready = fake_wait
mod.extract_page = fake_extract
page = FakePage()
source_page = fake_extract(page, page.url, cfg.allowed_domains, cfg)
discovered = mod.explore_readonly_interactions(page, source_page, cfg, cfg.timeout_ms, 4, Recorder())
assert len(discovered) == 1
assert page.clicks == 1
assert discovered[0]["url"] == "https://erp.example.com/meeting/groups/dashboard"
assert discovered[0]["source"] == "interactive-readonly"
assert discovered[0]["sourceInteraction"]["fromUrl"] == "https://erp.example.com/dashboard"
`;

const result = spawnSync(python, ["-c", probe], { cwd: ROOT, encoding: "utf8" });
assert(result.status === 0, result.stderr || result.stdout || "interaction explorer probe failed");
console.log("PASS: test-web-system-interaction-explorer");
