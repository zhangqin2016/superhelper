// The web side of paying and seeing your bills, held to what the server
// guarantees: money is integer cents on digits (never floats), the page only
// asks whether an order is paid (never decides it), a refund needs an explicit
// confirmation, fake payment is offered only when the server says so, and the
// buyer's bills and the operator's orders/reconciliation are reachable.
import assert from "node:assert/strict";
import fs from "node:fs";

const fmt = await import("../web/lib/billing-format.mjs");
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// --- money --------------------------------------------------------------------
assert.equal(fmt.formatMoney(990), "¥9.90");
assert.equal(fmt.formatMoney(-5), "-¥0.05");
assert.equal(fmt.formatMoney(1), "¥0.01");
assert.equal(fmt.yuanToCents("9.9"), 990);
assert.equal(fmt.yuanToCents("0.29"), 29, "0.29 is 29 cents, not 28.999…");
assert.equal(fmt.yuanToCents("19.99"), 1999);
for (const bad of ["", "1.234", "-1", "abc", "1e3", "1,000"]) assert.equal(fmt.yuanToCents(bad), null, `"${bad}" is not an amount`);
assert.equal(fmt.centsToYuan(1230), "12.30");
assert.equal(fmt.yuanToCents(fmt.centsToYuan(123456)), 123456, "round-trips");
assert.match(fmt.paymentErrorMessage("ORDER_EXPIRED"), /超时/);
assert.ok(!/[A-Z_]{6,}/.test(fmt.paymentErrorMessage("SOMETHING_NEW")), "an unknown code is never shown raw to a buyer");

// --- the buyer pays -------------------------------------------------------------
const actions = read("web/app/account/actions.js");
assert.match(actions, /nextUrl = `\/account\/orders\/\$\{encodeURIComponent\([^`]*\)\}\?pay=1`/, "creating an order goes straight to paying it");
const panel = read("web/components/account/order-pay-panel.js");
assert.match(panel, /\/status`/, "the pay page polls the order's status");
assert.match(panel, /visibilitychange/, "and asks again when the buyer comes back to the tab");
assert.ok(!/setOrder\(\{[^}]*status:\s*"paid"/.test(panel), "the page never marks an order paid by itself");
const orders = read("web/app/account/orders/page.js");
assert.match(orders, /order\.status === "pending" && fakePaymentsEnabled/, "fake pay is offered only when the server allows it");
assert.match(orders, /\?pay=1/, "a pending order can be paid again from the list");

// --- the buyer's bills ------------------------------------------------------------
assert.match(read("web/app/account/layout.js"), /\["账单", "\/account\/bills"\]/);
const bills = read("web/app/account/bills/page.js");
for (const api of ["/api/billing/statement", "/api/billing/balance", "/api/billing/usage-summary"]) assert.ok(bills.includes(api), `bills read ${api}`);
assert.match(bills, /before=\$\{encodeURIComponent\(nextBefore\)\}/, "older lines page by the server's cursor");

// --- the operator -----------------------------------------------------------------
assert.match(read("web/app/admin/billing/page.js"), /redirect\("\/admin\/billing\/orders"\)/);
for (const [page, tab] of [["orders/page.js", "orders"], ["products/page.js", "products"], ["pricing/page.js", "pricing"], ["reconciliation/page.js", "reconciliation"]]) {
  assert.match(read(`web/app/admin/billing/${page}`), new RegExp(`<BillingAdminTabs active="${tab}" />`), `${page} shows the billing tabs`);
}
const detail = read("web/app/admin/billing/orders/[orderId]/page.js");
assert.match(detail, /name="confirm" value="yes" required/, "a refund needs an explicit confirmation");
const adminActions = read("web/app/admin/billing/actions.js");
assert.match(adminActions, /text\(formData, "confirm"\) !== "yes"/, "and the action checks it too");
assert.match(adminActions, /yuanToCents\(raw\)/, "refund amounts are parsed on digits");
assert.ok(!/Math\.round\([^)]*amountYuan/.test(adminActions), "no float math on refund amounts");
const settings = read("web/components/config-basics-panel.js");
for (const name of ["alipayCheckoutMode", "wechatPlatformPublicKey", "wechatPlatformPublicKeyId"]) {
  assert.ok(settings.includes(`name="${name}"`), `settings form has ${name}`);
  assert.ok(read("web/app/admin/actions.js").includes(`"${name}"`), `settings action sends ${name}`);
}
assert.match(settings, /disabled=\{!fakeAllowedHere\}/, "fake payments cannot be switched on where the server forbids them");

console.log("web-billing-flow: ok");
