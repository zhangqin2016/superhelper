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
    const { mountTurnArticle, reconcileLiveArticles } = await import(${JSON.stringify(moduleUrl)});
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
      const liveArticles = new Map();
      mountTurnArticle(el, live, { kind: "live", liveArticles });
      liveArticles.set("t2", live);
      mountTurnArticle(el, make("t3", "sealed", "newer"), { kind: "sealed" });
      mountTurnArticle(el, make("t2", "sealed", "committed"), { kind: "sealed", liveArticles });
      expect("sealed replaces live in place", ids(el).join(",") === "t1:older,t2:committed,t3:newer", ids(el).join(","));
      expect("and the live map drops the detached node", liveArticles.has("t2") === false);
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

    // --- the stale-live-article cases, from the real event order ---

    // 11. A turn that ENDS: the committed card lands while the live article is
    //     still the current one. That is the "结束的时候也多一个" report.
    {
      const el = list();
      const live = make("t1", "live", "live");
      const liveArticles = new Map([["t1", live]]);
      el.appendChild(live);
      const sealed = make("t1", "sealed", "answer");
      el.appendChild(sealed);
      const dropped = reconcileLiveArticles(el, liveArticles);
      expect("a finished turn's live article goes once its committed card is shown",
        dropped === 1 && ids(el).join(",") === "t1:answer", ids(el).join(","));
      expect("and the map forgets it", liveArticles.size === 0);
    }

    // 12. The orphan: turn A ended, turn B took the live slot, A's article was
    //     left behind under B's user message. Nothing ever looked at it again.
    {
      const el = list();
      const a = make("tA", "live", "orphan");
      const b = make("tB", "live", "current");
      const liveArticles = new Map([["tA", a], ["tB", b]]);
      el.append(make("tA", "sealed", "A-answer"), a, b);
      const dropped = reconcileLiveArticles(el, liveArticles);
      expect("the orphan from the previous turn is swept even though B holds the slot",
        dropped === 1 && ids(el).join(",") === "tA:A-answer,tB:current", ids(el).join(","));
      expect("and the running turn's article is untouched", liveArticles.get("tB") === b);
    }

    // 13. Never a disappearing answer: with no committed card, a live article is
    //     the turn's only copy and must survive, live slot or not.
    {
      const el = list();
      const running = make("t1", "live", "running");
      const finished = make("t2", "live", "only-copy");
      const liveArticles = new Map([["t1", running], ["t2", finished]]);
      el.append(running, finished);
      expect("nothing is dropped while no committed card exists",
        reconcileLiveArticles(el, liveArticles) === 0 && el.children.length === 2, ids(el).join(","));
      expect("and both stay in the map", liveArticles.size === 2);
    }

    // 14. A live article for a turn whose only other card is ALSO live is not a
    //     committed duplicate — precedence must not be inferred from presence.
    {
      const el = list();
      const one = make("t1", "live", "one");
      const two = make("t1", "live", "two");
      el.append(one, two);
      const liveArticles = new Map([["t1", two]]);
      expect("a live sibling is not grounds for removal", reconcileLiveArticles(el, liveArticles) === 0, ids(el).join(","));
    }

    // 15. Detached entries are forgotten without touching the DOM.
    {
      const el = list();
      const gone = make("t1", "live", "detached");
      const liveArticles = new Map([["t1", gone]]);
      expect("a detached article leaves the map", reconcileLiveArticles(el, liveArticles) === 0 && liveArticles.size === 0);
    }

    // 16. Bad input never throws inside a render pass.
    {
      expect("null list sweeps nothing", reconcileLiveArticles(null, new Map()) === 0);
      expect("null map sweeps nothing", reconcileLiveArticles(list(), null) === 0);
    }

    return { ok: ok.length, failures };
  })()`);

  clearTimeout(hardTimeout);
  for (const failure of result.failures) console.error("FAIL -", failure);
  console.log(`${result.ok} checks passed (one turn, one article — real DOM)`);
  win.destroy();
  app.exit(result.failures.length ? 1 : 0);
}).catch((error) => {
  console.error("test-one-turn-one-article:", error?.message || error);
  app.exit(1);
});
