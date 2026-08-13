#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  initWorkspaceSwitcher,
  latestSession,
  relativeTimeValue,
  recentSessions,
  searchWorkspaceTargets,
  sortSessionsByRecency,
} from "../src/renderer/modules/workspace-switcher.js";

if (process.argv.includes("--tz-probe")) {
  const probeNow = Date.parse("2026-07-25T10:00:00.000Z");
  assert.equal(relativeTimeValue("2026-07-25T10:00:00", probeNow), null);
  assert.deepEqual(relativeTimeValue("2026-07-25T14:00:00+04:00", probeNow), {
    value: 0,
    unit: "second",
  });
  assert.deepEqual(
    recentSessions({
      sessions: [
        { id: "naive", updatedAt: "2026-07-25T10:00:00" },
        { id: "utc", updatedAt: "2026-07-24T10:00:00.000Z" },
      ],
    }).map((session) => session.id),
    ["utc", "naive"],
  );
  process.exit(0);
}

const projects = [
  {
    id: "finance",
    name: "Finance",
    path: "/work/finance",
    sessions: [
      { id: "old", title: "June report", updatedAt: "2026-07-01T10:00:00.000Z" },
      { id: "new", title: "July report", updatedAt: "2026-07-24T10:00:00.000Z" },
      { id: "created", title: "Created fallback", createdAt: "2026-07-20T10:00:00.000Z" },
      {
        id: "invalid-update-created",
        title: "Recovery report",
        updatedAt: "not-a-date",
        createdAt: "2026-07-22T10:00:00.000Z",
      },
      { id: "naive", title: "Naive report", updatedAt: "2026-07-25T10:00:00" },
      { id: "invalid-a", title: "Invalid A", updatedAt: "not-a-date" },
      { id: "invalid-b", title: "Invalid B" },
    ],
  },
  {
    id: "brand",
    name: "Brand",
    path: "/work/brand",
    sessions: [
      { id: "copy", title: "Homepage copy", updatedAt: "2026-07-23T10:00:00.000Z" },
      { id: "tie-brand", title: "Shared result", updatedAt: "2026-07-22T10:00:00.000Z" },
    ],
  },
  {
    id: "chinese",
    name: "财务空间",
    path: "/工作/年度",
    sessions: [
      { id: "cn-report", title: "七月报告", updatedAt: "2026-07-21T10:00:00.000Z" },
    ],
  },
];

const projectsSnapshot = structuredClone(projects);

assert.equal(latestSession(projects[0]).id, "new");
assert.equal(latestSession({ sessions: [] }), null);
assert.equal(latestSession(null), null);

assert.deepEqual(
  recentSessions(projects[0]).map((session) => session.id),
  ["new", "invalid-update-created", "created"],
);
assert.deepEqual(recentSessions(projects[0], 1).map((session) => session.id), ["new"]);
assert.deepEqual(
  recentSessions(projects[0], 2.9).map((session) => session.id),
  ["new", "invalid-update-created"],
);
assert.deepEqual(recentSessions(projects[0], -1), []);
assert.equal(recentSessions(projects[0], Number.NaN).length, 3);
assert.equal(recentSessions(projects[0], Number.POSITIVE_INFINITY).length, 3);
assert.equal(recentSessions(projects[0], "1").length, 3);
assert.deepEqual(
  recentSessions(projects[0], 10).map((session) => session.id),
  [
    "new",
    "invalid-update-created",
    "created",
    "old",
    "naive",
    "invalid-a",
    "invalid-b",
  ],
);
assert.deepEqual(recentSessions({}, 3), []);
assert.deepEqual(projects, projectsSnapshot);

const sidebarSource = [
  { id: "created", createdAt: "2026-07-20T10:00:00.000Z" },
  { id: "old", updatedAt: "2026-07-21T10:00:00.000Z" },
  { id: "recent", updatedAt: "2026-07-25T10:00:00.000Z" },
  { id: "invalid-a", updatedAt: "invalid" },
  { id: "invalid-b" },
];
assert.deepEqual(
  sortSessionsByRecency(sidebarSource).map((session) => session.id),
  ["recent", "old", "created", "invalid-a", "invalid-b"],
  "the conversation sidebar must show most recently used sessions first",
);
assert.deepEqual(
  sidebarSource.map((session) => session.id),
  ["created", "old", "recent", "invalid-a", "invalid-b"],
  "sidebar sorting must not mutate persisted project session order",
);

const now = Date.parse("2026-07-25T10:00:00.000Z");
assert.deepEqual(relativeTimeValue("2026-07-25T09:59:31.000Z", now), {
  value: 0,
  unit: "second",
});
assert.deepEqual(relativeTimeValue("2026-07-25T10:00:29.000Z", now), {
  value: 0,
  unit: "second",
});
assert.deepEqual(relativeTimeValue("2026-07-25T09:55:00.000Z", now), {
  value: -5,
  unit: "minute",
});
assert.deepEqual(relativeTimeValue("2026-07-25T12:00:00.000Z", now), {
  value: 2,
  unit: "hour",
});
assert.deepEqual(relativeTimeValue(now - 90 * 60 * 1_000, now), {
  value: -2,
  unit: "hour",
});
assert.deepEqual(relativeTimeValue(now + 90 * 60 * 1_000, now), {
  value: 2,
  unit: "hour",
});
assert.deepEqual(relativeTimeValue(now - 90 * 1_000, now), {
  value: -2,
  unit: "minute",
});
assert.deepEqual(relativeTimeValue(now + 90 * 1_000, now), {
  value: 2,
  unit: "minute",
});
const relativePromotionCases = [
  { magnitude: 59.5 * 60 * 1_000, value: 1, unit: "hour" },
  { magnitude: 23.5 * 60 * 60 * 1_000, value: 1, unit: "day" },
  { magnitude: 29.5 * 24 * 60 * 60 * 1_000, value: 1, unit: "month" },
  { magnitude: 11.5 * 30 * 24 * 60 * 60 * 1_000, value: 1, unit: "year" },
];
for (const { magnitude, value, unit } of relativePromotionCases) {
  assert.deepEqual(relativeTimeValue(now - magnitude, now), { value: -value, unit });
  assert.deepEqual(relativeTimeValue(now + magnitude, now), { value, unit });
}
assert.deepEqual(relativeTimeValue("2026-07-24T10:00:00.000Z", now), {
  value: -1,
  unit: "day",
});
assert.deepEqual(relativeTimeValue("2026-05-26T10:00:00.000Z", now), {
  value: -2,
  unit: "month",
});
assert.deepEqual(relativeTimeValue("2027-07-25T10:00:00.000Z", now), {
  value: 1,
  unit: "year",
});
assert.deepEqual(relativeTimeValue(now + 60 * 60 * 1_000, now), {
  value: 1,
  unit: "hour",
});
assert.deepEqual(relativeTimeValue(now + 24 * 60 * 60 * 1_000, now), {
  value: 1,
  unit: "day",
});
assert.deepEqual(relativeTimeValue(now + 30 * 24 * 60 * 60 * 1_000, now), {
  value: 1,
  unit: "month",
});
assert.deepEqual(relativeTimeValue(now + 365 * 24 * 60 * 60 * 1_000, now), {
  value: 1,
  unit: "year",
});
assert.deepEqual(relativeTimeValue("2026-07-25T14:00:00+04:00", now), {
  value: 0,
  unit: "second",
});
assert.equal(relativeTimeValue("2026-02-30T10:00:00Z", now), null);
assert.equal(relativeTimeValue("2025-02-29T10:00:00Z", now), null);
assert.deepEqual(
  relativeTimeValue("2024-02-29T10:00:00Z", Date.parse("2024-02-29T10:00:00Z")),
  { value: 0, unit: "second" },
);
assert.equal(relativeTimeValue("2026-13-01T10:00:00Z", now), null);
assert.equal(relativeTimeValue("2026-01-01T24:00:00Z", now), null);
assert.equal(relativeTimeValue("2026-01-01T10:60:00Z", now), null);
assert.equal(relativeTimeValue("2026-01-01T10:00:60Z", now), null);
assert.equal(relativeTimeValue("2026-01-01T10:00:00+24:00", now), null);
assert.equal(relativeTimeValue("2026-01-01T10:00:00+04:60", now), null);
assert.deepEqual(relativeTimeValue(new Date(now - 5 * 60 * 1_000), now), {
  value: -5,
  unit: "minute",
});
assert.equal(relativeTimeValue("2026-07-25T10:00:00", now), null);
assert.equal(relativeTimeValue("not-a-date", now), null);
assert.equal(relativeTimeValue(null, now), null);
assert.equal(relativeTimeValue("2026-07-25T10:00:00.000Z", Number.NaN), null);
assert.equal(Object.is(relativeTimeValue("2026-07-25T09:59:59.000Z", now).value, -0), false);

assert.deepEqual(
  searchWorkspaceTargets(projects, " finance ").workspaces.map((project) => project.id),
  ["finance"],
);
assert.deepEqual(
  searchWorkspaceTargets(projects, "/WORK/BRAND").workspaces.map((project) => project.id),
  ["brand"],
);
assert.deepEqual(
  searchWorkspaceTargets(projects, "report").sessions.map((result) => result.session.id),
  ["new", "invalid-update-created", "old", "naive"],
);
assert.deepEqual(
  searchWorkspaceTargets(projects, "homepage").sessions.map((result) => result.project.id),
  ["brand"],
);
assert.deepEqual(
  searchWorkspaceTargets(projects, "财务").workspaces.map((project) => project.id),
  ["chinese"],
);
assert.deepEqual(
  searchWorkspaceTargets(projects, "报告").sessions.map((result) => result.session.id),
  ["cn-report"],
);
assert.deepEqual(searchWorkspaceTargets(projects, "missing"), { workspaces: [], sessions: [] });
assert.deepEqual(searchWorkspaceTargets(projects, "   "), { workspaces: [], sessions: [] });
assert.deepEqual(searchWorkspaceTargets([], "report"), { workspaces: [], sessions: [] });
assert.deepEqual(searchWorkspaceTargets(null, "report"), { workspaces: [], sessions: [] });

const tieProjects = [
  {
    id: "first",
    name: "First",
    sessions: [
      { id: "first-a", title: "Shared result", updatedAt: "2026-07-22T10:00:00.000Z" },
      { id: "first-b", title: "Shared result", updatedAt: "2026-07-22T10:00:00.000Z" },
    ],
  },
  {
    id: "second",
    name: "Second",
    sessions: [
      { id: "second-a", title: "Shared result", updatedAt: "2026-07-22T10:00:00.000Z" },
      { id: "second-invalid", title: "Shared result", updatedAt: "invalid" },
    ],
  },
];
assert.deepEqual(
  searchWorkspaceTargets(tieProjects, "shared").sessions.map((result) => result.session.id),
  ["first-a", "first-b", "second-a", "second-invalid"],
);
assert.deepEqual(projects, projectsSnapshot);

const controller = initWorkspaceSwitcher();
assert.equal(typeof controller.dispose, "function");
assert.doesNotThrow(() => controller.dispose());
assert.doesNotThrow(() => controller.dispose());

const testFile = fileURLToPath(import.meta.url);
for (const timezone of ["UTC", "Asia/Dubai"]) {
  const probe = spawnSync(process.execPath, [testFile, "--tz-probe"], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(
    probe.status,
    0,
    `timezone probe failed for ${timezone}: ${probe.error?.message || probe.stderr}`,
  );
}

console.log("workspace-switcher-model: ok");
