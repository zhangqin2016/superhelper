#!/usr/bin/env node
// Platform admin creates an organization FOR a customer and hands it to its
// first owner. This is the one moment the admin acts inside an organization;
// after the handoff the §7.1 boundary holds and members are the owner's alone.
//
// The owner is named exactly one of two ways: a phone that is already
// registered, or an account the platform issues on the spot (login name +
// one-time password). An unregistered phone is refused with a clear code that
// points at the issued-account path — never a silently invented seat.

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

// ---------- owner issuance is a NARROW opening ----------
const accounts = await import(new URL("../server/src/services/enterprise-accounts.js", import.meta.url));
const service = read("../server/src/services/enterprise-accounts.js");
assert.match(service, /allowOwner = false/, "issuing an owner is off unless a caller explicitly opens it");
assert.match(
  service,
  /request\?\.role === "owner" && allowOwner \? "owner"/,
  "only with allowOwner does an owner request stay owner; every other caller is normalised to member/admin",
);
// The enterprise-side mutation must NOT open it: a company admin can never mint owners.
const mutations = read("../server/src/services/enterprise-mutations.js");
assert.doesNotMatch(
  mutations.slice(mutations.indexOf("provisionAccounts(options, input)")),
  /allowOwner: true/,
  "the enterprise-side provisioning path must never pass allowOwner — minting owners is the platform's handoff step only",
);

// ---------- the admin route ----------
const route = read("../server/src/routes/admin/enterprise.js");
assert.match(route, /"\/api\/admin\/enterprise\/organizations",\s*\{\s*schema:\s*\{\s*tags: \["admin:enterprise"\],\s*summary: "Create an organization and designate its first owner"/, "the create endpoint exists on the admin surface");
assert.match(route, /if \(!await assertAdmin\(request, reply\)\) return;/, "and is behind admin auth");
assert.match(route, /allowOwner: true,/, "it is the ONE caller allowed to issue an owner");
assert.match(route, /role: "owner"/, "and the account it issues is the owner");
assert.match(route, /code = "OWNER_NOT_REGISTERED"/, "an unregistered owner phone is refused by name — not turned into an invitation, which cannot carry owner");
assert.match(route, /\.where\("phone_e164", "=", phone\)/, "a phone owner must already exist");
assert.match(route, /audit\(request, "enterprise_org_create", "organization", organizationId/, "creating an organization is audited");
assert.match(route, /ownerIssued: owner\.issued/, "the audit records whether the platform minted the owner");
// Exactly one way to name the owner.
assert.match(route, /owner: z\.union\(\[/, "owner is a union — phone OR issue, never both nor neither");
assert.match(route, /issue: z\.literal\(true\)/, "issuing must be asked for explicitly");
// The initial password rides the response once; nothing writes it.
assert.doesNotMatch(route, /initialPassword[^\n]*insertInto|insertInto[^\n]*initialPassword/, "the initial password is never persisted by the route");

// After the handoff the admin still cannot touch members: the §7.1 boundary
// is preserved, not relaxed. The admin surface must have no member endpoints.
assert.doesNotMatch(route, /\/api\/admin\/enterprise\/organizations\/:id\/members/, "the admin surface must not gain member management — that stays the owner's");

// ---------- web ----------
const actions = read("../web/app/admin/enterprise/actions.js");
assert.match(actions, /apiPost\("\/api\/admin\/enterprise\/organizations", \{ name, plan, owner \}\)/, "the admin form calls the create endpoint");
assert.match(actions, /#issued=\$\{payload\}/, "an issued owner's one-time password travels via the URL hash, never the server");
const page = read("../web/app/admin/enterprise/page.js");
assert.match(page, /createOrganizationAction/, "the admin list page has the create form");
assert.match(page, /<option value="issue">/, "and offers issuing the owner");
assert.match(page, /<option value="phone">/, "or naming a registered phone");
const detail = read("../web/app/admin/enterprise/[id]/page.js");
assert.match(detail, /<IssuedCredentials \/>/, "the detail page reveals the issued owner credentials once");
assert.ok(fs.existsSync(new URL("../web/components/issued-credentials.js", import.meta.url)), "the reveal component is shared, not duplicated");

console.log("admin-enterprise-create: ok");
console.log("  admin creates + hands off; owner by registered phone or issued account; members stay the owner's");
