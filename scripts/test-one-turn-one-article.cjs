#!/usr/bin/env node
"use strict";

/**
 * One turn, one article — against a real DOM.
 *
 * The field report: an answer that had already ended kept growing extra blocks,
 * and the extra blocks vanished after a quit and restart. That last fact is the
 * diagnosis: a reload builds exactly one article per stored record, so the
 * duplicates were never in the data. In the running window two independent
 * paths mounted articles — a live one keyed by turnId through a Map, and a
 * committed one that called createElement("article") and appended it without
 * looking at what was already there. Collapsing the pair depended on a separate
 * heuristic choosing to remove the live card; anything else, or simply running
 * the committed path twice, left the same turn standing more than once.
 *
 * These checks pin the invariant that replaced that decision. They run in a
 * real Electron renderer DOM because the bug is a DOM bug: a jsdom stand-in
 * that got replaceChild or :scope wrong would prove nothing.
 * [gate: one-turn-one-article]
 *
 * Run: npx electron scripts/test-one-turn-one-article.cjs
 */

const electron = require("electron");
const { app, BrowserWindow } = electron;
const path = require("node:path");

if (!app?.whenReady || !BrowserWindow) {
  console.error("must run under Electron: npx electron scripts/test-one-turn-one-article.cjs");
  process.exit(2);
}

const root = path.join(__dirname, "..");
let win;
const hardTimeout = setTimeout(() => {
  console.error("test-one-turn-one-article: timed out");
  try { win?.destroy?.(); } catch { /* best effort */ }
  process.exit(1);
}, Number(process.env.TEST_ONE_TURN_TIMEOUT_MS || 60000));

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  // A real page from the renderer tree, so the module imports from its own
  // origin exactly as it does in the app. The checks below build their own
  // lists and never touch the app's DOM.
  await win.loadFile(path.join(root, "src", "renderer", "index.html"));

  const moduleUrl = "./modules/turn-article-mount.js";
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { mountTurnArticle, findLiveArticle, hasLiveArticle } = await import(${JSON.stringify(moduleUrl)});
    const failures = [];
    const ok = [];
    const expect = (name, condition, detail) => {
      if (condition) ok.push(name);
      else failures.push(name + (detail ? " — " + detail : ""));
    };

    const list = () => {
      const el = document.createElement("div");
      document.body.replaceChildren(el);
      return el;
    };
    const make = (turnId, kind, mark) => {
      const a = document.createElement("article");
      a.className = "assistant-turn-article " + (kind === "sealed" ? "is-sealed" : "is-live");
      a.dataset.turnId = turnId;
      if (mark) a.dataset.mark = mark;
      return a;
    };
    const ids = (el) => [...el.children].map((c) => c.dataset.turnId + ":" + (c.dataset.mark || ""));

    // 1. The reported shape: one turn, committed three times.
    {
      const el = list();
      for (const n of ["a", "b", "c"]) mountTurnArticle(el, make("t1", "sealed", n), { kind: "sealed" });
      expect("three commits of one turn leave one article", el.children.length === 1, ids(el).join(","));
      expect("and it is the newest", el.children[0].dataset.mark === "c", el.children[0].dataset.mark);
    }

    // 2. A committed card replaces the live one IN PLACE — order must hold, or
    //    a finished answer would jump to the bottom of the conversation.
    {
      const el = list();
      mountTurnArticle(el, make("t1", "sealed", "older"), { kind: "sealed" });
      const live = make("t2", "live", "live");
      mountTurnArticle(el, live, { kind: "live" });
      mountTurnArticle(el, make("t3", "sealed", "newer"), { kind: "sealed" });
      mountTurnArticle(el, make("t2", "sealed", "committed"), { kind: "sealed" });
      expect("sealed replaces live in place", ids(el).join(",") === "t1:older,t2:committed,t3:newer", ids(el).join(","));
      expect("and nothing is left claiming to be live for it", findLiveArticle(el, "t2") === null);
    }

    // 3. Precedence: a late live event must not cover the committed answer with
    //    an emptier shell.
    {
      const el = list();
      mountTurnArticle(el, make("t1", "sealed", "answer"), { kind: "sealed" });
      const refused = mountTurnArticle(el, make("t1", "live", "shell"), { kind: "live" });
      expect("a live shell is refused over a committed card", refused === null);
      expect("and the committed card survives untouched", ids(el).join(",") === "t1:answer", ids(el).join(","));
    }

    // 4. Live over live still reconciles to one.
    {
      const el = list();
      mountTurnArticle(el, make("t1", "live", "first"), { kind: "live" });
      mountTurnArticle(el, make("t1", "live", "second"), { kind: "live" });
      expect("two live shells for one turn collapse", el.children.length === 1 && el.children[0].dataset.mark === "second", ids(el).join(","));
    }

    // 5. Deliberately narrow: things with no turn identity are not merged.
    {
      const el = list();
      for (const n of ["n1", "n2", "n3"]) {
        const notice = document.createElement("article");
        notice.dataset.mark = n;
        mountTurnArticle(el, notice, { kind: "sealed" });
      }
      expect("articles without a turn id are never reconciled together", el.children.length === 3, ids(el).join(","));
      const empty = document.createElement("article");
      empty.dataset.turnId = "";
      mountTurnArticle(el, empty, { kind: "sealed" });
      expect("an empty turn id counts as no identity", el.children.length === 4);
    }

    // 6. beforeNode ordering still works for a turn that is genuinely new.
    {
      const el = list();
      const tail = make("t9", "sealed", "tail");
      mountTurnArticle(el, tail, { kind: "sealed" });
      mountTurnArticle(el, make("t5", "sealed", "inserted"), { kind: "sealed", beforeNode: tail });
      expect("a new turn honours beforeNode", ids(el).join(",") === "t5:inserted,t9:tail", ids(el).join(","));
    }

    // 7. Re-mounting the very same element is a no-op, not a move.
    {
      const el = list();
      const a = make("t1", "sealed", "same");
      mountTurnArticle(el, a, { kind: "sealed" });
      mountTurnArticle(el, make("t2", "sealed", "after"), { kind: "sealed" });
      mountTurnArticle(el, a, { kind: "sealed" });
      expect("re-mounting the same element does not move it", ids(el).join(",") === "t1:same,t2:after", ids(el).join(","));
    }

    // 8. Reconciliation is scoped to one list: two sessions showing the same
    //    turn must not fight over it.
    {
      const elA = list();
      const elB = document.createElement("div");
      document.body.appendChild(elB);
      mountTurnArticle(elA, make("t1", "sealed", "A"), { kind: "sealed" });
      mountTurnArticle(elB, make("t1", "sealed", "B"), { kind: "sealed" });
      expect("each session keeps its own article", elA.children.length === 1 && elB.children.length === 1);
    }

    // 9. A turn id that would break a CSS selector is matched anyway.
    {
      const el = list();
      const weird = 'turn "x" #1 [a]';
      mountTurnArticle(el, make(weird, "live", "one"), { kind: "live" });
      mountTurnArticle(el, make(weird, "sealed", "two"), { kind: "sealed" });
      expect("turn ids are matched without CSS escaping", el.children.length === 1 && el.children[0].dataset.mark === "two", ids(el).join(","));
    }

    // 10. Bad input is never a reason to throw inside a render pass.
    {
      expect("null list", mountTurnArticle(null, document.createElement("article")) === null);
      expect("null article", mountTurnArticle(list(), null) === null);
      const el = list();
      expect("a beforeNode from another list is ignored, not thrown on",
        mountTurnArticle(el, make("t1", "sealed", "x"), { kind: "sealed", beforeNode: document.createElement("div") }) !== null);
    }

    // --- the cases the deleted runtime sweep used to clean up, now prevented ---

    // 11. A turn that ENDS: the committed card lands while the live article is
    //     still the current one. That was the "结束的时候也多一个" report.
    {
      const el = list();
      mountTurnArticle(el, make("t1", "live", "live"), { kind: "live" });
      mountTurnArticle(el, make("t1", "sealed", "answer"), { kind: "sealed" });
      expect("a finished turn never leaves its live article beside the answer",
        ids(el).join(",") === "t1:answer", ids(el).join(","));
      expect("and nothing claims to be live for it", findLiveArticle(el, "t1") === null);
    }

    // 12. The handover: turn A ends and turn B takes the live slot. A's article
    //     used to be orphaned under B's user message with nothing looking at it.
    {
      const el = list();
      mountTurnArticle(el, make("tA", "live", "A-live"), { kind: "live" });
      mountTurnArticle(el, make("tA", "sealed", "A-answer"), { kind: "sealed" });
      mountTurnArticle(el, make("tB", "live", "B-live"), { kind: "live" });
      expect("the previous turn leaves one card and the new one starts clean",
        ids(el).join(",") === "tA:A-answer,tB:B-live", ids(el).join(","));
      expect("and B is the one that is live", findLiveArticle(el, "tB") !== null && findLiveArticle(el, "tA") === null);
    }

    // 13. Never a disappearing answer: a turn whose live article is its only
    //     copy keeps it, because no committed card ever replaced it.
    {
      const el = list();
      mountTurnArticle(el, make("t1", "live", "only-copy"), { kind: "live" });
      mountTurnArticle(el, make("t2", "live", "running"), { kind: "live" });
      expect("two different turns each keep their own live card",
        ids(el).join(",") === "t1:only-copy,t2:running", ids(el).join(","));
    }

    // --- identity is (turn id AND turn article), never the id alone ---

    // 17. The user's own bubble carries the same turn id, stamped there for the
    //     minimap. Treating that as "this turn already has a card" refused the
    //     assistant shell outright — no answer rendered at all.
    {
      const el = list();
      const bubble = document.createElement("article");
      bubble.className = "runtime-user-message";
      bubble.dataset.turnId = "t1";
      bubble.textContent = "question";
      el.appendChild(bubble);
      const live = make("t1", "live", "answer");
      expect("a user bubble never blocks its own turn's answer", mountTurnArticle(el, live, { kind: "live" }) === live);
      expect("and both stand, question above answer",
        [...el.children].map((c) => c.className.split(" ")[0]).join(",") === "runtime-user-message,assistant-turn-article",
        [...el.children].map((c) => c.className).join(" | "));

      const sealed = make("t1", "sealed", "final");
      mountTurnArticle(el, sealed, { kind: "sealed" });
      expect("the committed card replaces the live one, not the question",
        el.children.length === 2 && el.children[0] === bubble && el.children[1] === sealed,
        [...el.children].map((c) => c.className).join(" | "));
      expect("the question's text is untouched", bubble.textContent === "question");
    }

    // 18. Any non-live article that stands for the turn outranks the shell —
    //     a scheduled-draft card is not named anywhere as a special case.
    {
      const el = list();
      const draft = document.createElement("article");
      draft.className = "assistant-turn-article scheduled-draft-article";
      draft.dataset.turnId = "t1";
      el.appendChild(draft);
      expect("a live shell yields to a scheduled-draft card for the same turn",
        mountTurnArticle(el, make("t1", "live", "shell"), { kind: "live" }) === null && el.children.length === 1);
    }

    // 19. Eviction takes the whole turn, including the article that has no
    //     message key — the stranded-card case.
    {
      const keys = await import("./modules/message-render-keys.js");
      const el = list();
      const committed = make("tOld", "sealed", "old-answer");
      committed.dataset.messageKey = "assistant:tOld";
      const live = make("tOld", "live", "old-live");
      const keptCommitted = make("tNew", "sealed", "new-answer");
      keptCommitted.dataset.messageKey = "assistant:tNew";
      const keptLive = make("tNew", "live", "new-live");
      el.append(committed, live, keptCommitted, keptLive);
      keys.removeCommittedArticlesByKeys(el, ["assistant:tOld"]);
      expect("an evicted turn leaves nothing behind, keyed or not",
        ids(el).join(",") === "tNew:new-answer,tNew:new-live", ids(el).join(","));
    }

    return { ok: ok.length, failures };
  })()`);

  // --- the rule that makes the runtime sweep unnecessary ---
  //
  // A reconciliation pass that repairs duplicates at runtime is remedial: it
  // lets the wrong state exist and tidies it afterwards, which also hides the
  // producer that created it. The invariant is structural instead — every
  // article that stands for a turn enters the list through mountTurnArticle,
  // which replaces by identity — and this rule is what keeps it that way when
  // someone adds the next producer.
  const fs = require("node:fs");
  const modules = path.join(root, "src/renderer/modules");
  const sourceFailures = [];
  const BUILDS_TURN_ARTICLE = /className\s*=\s*[`"'][^`"']*assistant-turn-article/;
  for (const file of fs.readdirSync(modules).filter((name) => name.endsWith(".js"))) {
    if (file === "turn-article-mount.js") continue;
    const src = fs.readFileSync(path.join(modules, file), "utf8");
    if (!BUILDS_TURN_ARTICLE.test(src)) continue;
    // A pure factory builds the article and hands it back; it never sees a list,
    // so it cannot put anything in the wrong place.
    if (!/listEl/.test(src)) continue;
    if (!/mountTurnArticle\(/.test(src)) {
      sourceFailures.push(`${file} builds a turn article and touches the list without going through mountTurnArticle`);
    }
  }
  const mount = fs.readFileSync(path.join(modules, "turn-article-mount.js"), "utf8");
  if (/reconcileLiveArticles/.test(mount)) {
    sourceFailures.push("turn-article-mount.js still ships a runtime sweep; the mount point is the invariant, not a repair pass");
  }
  for (const failure of sourceFailures) console.error("FAIL -", failure);

  clearTimeout(hardTimeout);
  for (const failure of result.failures) console.error("FAIL -", failure);
  console.log(`${result.ok + 1} checks passed (one turn, one article — real DOM + the mounting rule)`);
  win.destroy();
  app.exit(result.failures.length || sourceFailures.length ? 1 : 0);
}).catch((error) => {
  console.error("test-one-turn-one-article:", error?.message || error);
  app.exit(1);
});
