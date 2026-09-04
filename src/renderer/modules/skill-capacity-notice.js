/**
 * Tells the user how close their skill set is to the model instruction budget.
 *
 * The agent guide's skill index is the only thing that tells the model which
 * skills exist, and past the budget entries are dropped — the model simply
 * stops knowing about them. That used to be invisible: no UI, no message, only
 * a main-process log. This is the visible half.
 *
 * Silent below the notice threshold: a capacity line that is always on becomes
 * furniture, and nothing is wrong at 60%.
 */
import { t, getLocale } from "../i18n/index.js";

/** Show nothing below this share of the budget. Above it, one more sizeable
 *  skill set could start costing entries, which is worth knowing before it
 *  happens rather than after. */
const NOTICE_SHARE = 0.8;

export function renderSkillCapacityNotice(node, budget) {
  if (!node) return;
  if (!budget || !Number.isFinite(budget.share)) {
    node.hidden = true;
    return;
  }

  const messages = [];
  let danger = false;

  if (budget.omittedCount > 0) {
    danger = true;
    messages.push(t("skills.capacityFull", { count: String(budget.omittedCount) }));
  } else if (budget.share >= NOTICE_SHARE) {
    // headroomSkills is null when nothing is indexed yet, so there is no
    // meaningful "how many more fit" to report.
    const count = Number.isFinite(budget.headroomSkills) ? budget.headroomSkills : 0;
    messages.push(t("skills.capacityNear", {
      percent: String(Math.round(budget.share * 100)),
      count: String(count),
    }));
  }

  // A skill with no description never reaches the index at any budget, so this
  // is worth saying whether or not the budget is tight.
  if (budget.undescribedCount > 0) {
    messages.push(t("skills.capacityUndescribed", { count: String(budget.undescribedCount) }));
  }

  if (!messages.length) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.textContent = messages.join(" ");
  node.classList.toggle("is-danger", danger);
  node.hidden = false;
}

/** The catalog summary line that sits directly above the capacity line. */
export function updateRegistryHint(catalog) {
  const hint = document.getElementById("skillsRegistryHint");
  if (!hint) return;

  if (catalog?.bundledCatalog) {
    const parts = [t("skills.registryHintBundled")];
    if (catalog.publisher) parts.push(catalog.publisher);
    if (catalog.fetchedAt) {
      parts.push(
        t("skills.registryChecked", {
          time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
        }),
      );
    }
    if (catalog.updatesCount > 0) {
      parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
    }
    if (catalog.available?.length) {
      parts.push(t("skills.registryAvailable", { count: catalog.available.length }));
    }
    hint.textContent = parts.join(" · ");
    return;
  }

  const parts = [];
  if (catalog.publisher) parts.push(catalog.publisher);
  if (catalog.fetchedAt) {
    parts.push(
      t("skills.registryChecked", {
        time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
      }),
    );
  }
  if (catalog.updatesCount > 0) {
    parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
  }
  if (catalog.available?.length) {
    parts.push(t("skills.registryAvailable", { count: catalog.available.length }));
  }
  hint.textContent = parts.join(" · ") || t("skills.registryConfigured");
}
