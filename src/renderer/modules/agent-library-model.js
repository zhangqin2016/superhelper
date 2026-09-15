/**
 * Pure model for the 智能体 (agent) tab of the library dialog. No IPC, DOM,
 * or timers — it turns the `agents:list` + `agents:get-session` payloads
 * (src/main/ipc-agents.js) into bounded renderer card items and answers the
 * small read-only questions the view asks (labels, groups, capability chips).
 *
 * Three catalog sources merge into one list, deduped by the local entity:
 *   - installed local agents (`agents[]`, libraryItem shape)
 *   - the official catalog (`official[]`, installedAgentId when installed)
 *   - server-distributed packages (`distributed[]`, installedAgentId when synced)
 * An official/distributed row that is already installed takes the installed
 * entity's id so activation, badges and the session binding all agree.
 */

const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 1024;
const MAX_LIST = 32;
const MAX_ITEM_CHARS = 160;
const MAX_STARTERS = 3;
const ICON_MAX_CHARS = 4;

export const AGENT_DRAFT_SOURCE_KIND = "agent_draft";
export const AGENT_DISTRIBUTED_SOURCE_KIND = "distributed";
export const AGENT_AUTONOMY_KEYS = Object.freeze({
  inherit: "character.agent.autonomy.inherit",
  plan: "character.agent.autonomy.plan",
  ask: "character.agent.autonomy.ask",
  full: "character.agent.autonomy.full",
});
export const AGENT_DIMENSION_KEYS = Object.freeze({
  role: "character.agent.dimension.role",
  skills: "character.agent.dimension.skills",
  autonomy: "character.agent.dimension.autonomy",
  knowledge: "character.agent.dimension.knowledge",
  model: "character.agent.dimension.model",
  tools: "character.agent.dimension.tools",
  automations: "character.agent.dimension.automations",
});

function text(value, max = MAX_TEXT_CHARS) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function strings(value, maxItems = MAX_LIST, maxChars = MAX_ITEM_CHARS) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim()).slice(0, maxItems)
    .map((entry) => entry.trim().slice(0, maxChars));
}

/** Only a short glyph (emoji) is treated as an icon; anything else is a monogram. */
export function agentIconGlyph(icon) {
  const value = typeof icon === "string" ? icon.trim() : "";
  if (!value) return "";
  return Array.from(value).length <= ICON_MAX_CHARS && !/^[\w\s.-]+$/u.test(value) ? value : "";
}

export function agentMonogram(name) {
  return Array.from(String(name || "").trim())[0]?.toUpperCase() || "A";
}

function normalizeSummary(summary, packNames = new Map()) {
  const s = summary && typeof summary === "object" ? summary : {};
  const skills = s.skills && typeof s.skills === "object" ? s.skills : {};
  const knowledge = s.knowledge && typeof s.knowledge === "object" ? s.knowledge : {};
  const tools = s.tools && typeof s.tools === "object" ? s.tools : {};
  const autonomyId = text(s.autonomy?.permissionModeId, 32) || "inherit";
  const packs = strings(knowledge.packs).map((id) => ({ id, name: packNames.get(id) || id }));
  return {
    description: text(s.description),
    icon: text(s.icon, 64),
    tags: strings(s.tags),
    starters: strings(s.starters, MAX_STARTERS, 240),
    skills: { required: strings(skills.required), enabled: strings(skills.enabled) },
    knowledge: { packs, guidance: text(knowledge.guidance) },
    model: { presetId: text(s.model?.presetId, 128) },
    tools: { mcpAllow: strings(tools.mcpAllow), connectors: strings(tools.connectors), disallow: strings(tools.disallow) },
    autonomy: { permissionModeId: Object.hasOwn(AGENT_AUTONOMY_KEYS, autonomyId) ? autonomyId : "inherit" },
    automationsCount: Array.isArray(s.automations) ? s.automations.length : 0,
    dimensions: strings(s.dimensions, 8, 32),
    cold: s.cold === true,
  };
}

function baseItem({ id, name, summary, packNames }) {
  const normalized = normalizeSummary(summary, packNames);
  const safeName = text(name, MAX_NAME_CHARS) || text(summary?.name, MAX_NAME_CHARS);
  return {
    id: text(id, MAX_ID_CHARS),
    kind: "agent",
    name: safeName,
    icon: agentIconGlyph(normalized.icon),
    description: normalized.description,
    summary: normalized,
    tags: normalized.tags,
    categoryId: "uncategorized",
    source: "local",
    official: false,
    officialId: "",
    distributed: false,
    packageId: "",
    installedAgentId: "",
    installed: false,
    currentRevisionId: "",
    sourceKind: "",
    featured: false,
    isDefault: false,
    updateAvailable: false,
    archived: false,
    active: false,
    inUse: 0,
    editorialOrder: Number.MAX_SAFE_INTEGER,
    recentlyUsedAt: "",
    searchText: "",
  };
}

function withSearchText(item) {
  const bag = [item.name, item.description, ...item.tags, ...item.summary.skills.required,
    ...item.summary.skills.enabled, ...item.summary.knowledge.packs.map((pack) => pack.name)];
  return { ...item, searchText: bag.filter(Boolean).join(" ").slice(0, MAX_TEXT_CHARS * 2).toLowerCase() };
}

/**
 * Merge the three catalog sources into card items. `activeAgentId` (from the
 * session binding) marks the row that is bound to the current conversation.
 */
export function buildAgentLibraryItems(rawPayload = {}, { activeAgentId = "" } = {}) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const packNames = new Map(
    (Array.isArray(payload.knowledgePacks) ? payload.knowledgePacks : [])
      .filter((pack) => pack && typeof pack.id === "string")
      .map((pack) => [pack.id, text(pack.name, 128) || pack.id]),
  );
  const local = new Map();
  for (const entry of Array.isArray(payload.agents) ? payload.agents : []) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    const item = baseItem({ id: entry.id, name: entry.name, summary: entry.summary, packNames });
    local.set(entry.id, {
      ...item,
      source: entry.official ? "official" : "local",
      official: Boolean(entry.official),
      officialId: text(entry.officialId, MAX_ID_CHARS),
      installedAgentId: item.id,
      installed: true,
      currentRevisionId: text(entry.currentRevisionId, MAX_ID_CHARS),
      sourceKind: text(entry.sourceKind, 64),
      distributed: entry.sourceKind === AGENT_DISTRIBUTED_SOURCE_KIND,
      archived: Boolean(entry.archivedAt),
      inUse: Number.isSafeInteger(entry.inUse) ? entry.inUse : 0,
      recentlyUsedAt: text(entry.updatedAt, 64),
    });
  }
  const consumed = new Set();
  const items = [];
  for (const entry of Array.isArray(payload.official) ? payload.official : []) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    const installed = entry.installedAgentId ? local.get(entry.installedAgentId) : null;
    if (installed) consumed.add(installed.id);
    const row = installed || baseItem({ id: `official:${entry.id}`, name: entry.summary?.name, summary: entry.summary, packNames });
    items.push({
      ...row,
      source: "official",
      official: true,
      officialId: entry.id,
      categoryId: text(entry.categoryId, 96) || "uncategorized",
      featured: Boolean(entry.featured),
      editorialOrder: Number.isSafeInteger(entry.editorialOrder) ? entry.editorialOrder : Number.MAX_SAFE_INTEGER,
      updateAvailable: Boolean(installed && entry.updateAvailable),
      // The catalog copy is the freshest description for a not-yet-installed row.
      description: row.description || text(entry.summary?.description),
    });
  }
  for (const entry of Array.isArray(payload.distributed) ? payload.distributed : []) {
    if (!entry || typeof entry.packageId !== "string" || !entry.packageId) continue;
    const installed = entry.installedAgentId ? local.get(entry.installedAgentId) : null;
    if (installed) consumed.add(installed.id);
    const row = installed || baseItem({ id: `distributed:${entry.packageId}`, name: entry.summary?.name, summary: entry.summary, packNames });
    items.push({
      ...row,
      source: "distributed",
      official: false,
      distributed: true,
      packageId: entry.packageId,
      featured: Boolean(entry.featured),
      isDefault: Boolean(entry.isDefault),
    });
  }
  for (const [id, item] of local) if (!consumed.has(id)) items.push(item);
  return items
    .filter((item) => item.id)
    .map((item) => withSearchText({ ...item, active: Boolean(activeAgentId) && item.installedAgentId === activeAgentId }));
}

export const AGENT_GROUP_IDS = Object.freeze(["featured", "all", "official", "distributed", "my", "recent", "archived"]);
export const AGENT_GROUP_LABEL_KEYS = Object.freeze({
  featured: "character.library.groupFeatured",
  all: "character.library.groupAll",
  official: "character.library.groupOfficial",
  distributed: "character.library.groupDistributed",
  my: "character.library.groupMy",
  recent: "character.library.groupRecent",
  archived: "character.library.groupArchived",
});

function isRecent(item) {
  return Boolean(item.installed && item.recentlyUsedAt && !Number.isNaN(Date.parse(item.recentlyUsedAt)));
}

export function agentGroupMatches(item, groupId) {
  if (!item) return false;
  switch (groupId) {
    case "featured": return !item.archived && (item.featured || item.active || item.isDefault || (item.source === "local" && isRecent(item)));
    case "all": return !item.archived;
    case "official": return item.official && !item.archived;
    case "distributed": return item.distributed && !item.archived;
    case "my": return item.source === "local" && !item.archived;
    case "recent": return isRecent(item) && !item.archived;
    case "archived": return item.archived;
    default: return !item.archived;
  }
}

export function deriveAgentGroups(items) {
  const values = Array.isArray(items) ? items : [];
  return AGENT_GROUP_IDS.map((id) => ({
    id,
    kind: id,
    labelKey: id,
    count: values.filter((item) => agentGroupMatches(item, id)).length,
  }));
}

/** Search matches name/description/skills; the tag filter matches tags only. */
export function filterAgentItems(items, { query = "", tag = "", groupId = "all" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const tagQuery = String(tag || "").trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!agentGroupMatches(item, groupId)) return false;
    if (q && !String(item.searchText || item.name || "").includes(q)) return false;
    if (tagQuery && !(item.tags || []).some((entry) => entry.toLowerCase().includes(tagQuery))) return false;
    return true;
  });
}

/** Active first, then featured/default, then editorial order, then name. */
export function sortAgentItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.editorialOrder !== b.editorialOrder) return a.editorialOrder - b.editorialOrder;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

/** Which primary action the detail pane offers for an item. */
export function agentPrimaryAction(item) {
  if (!item) return "none";
  if (item.active) return "deactivate";
  if (item.installed) return "use";
  if (item.official) return "install";
  if (item.distributed) return "pending";
  return "use";
}

/**
 * Popover order (no cap by default — the user must see every agent, not a
 * shortlist): the active agent, then installed agents (most recently used
 * first), then official catalog entries not yet installed, then distributed
 * packages still pending sync. `limit` is only honoured when finite.
 */
export function shortlistAgents(items, limit = Infinity) {
  const list = (items || []).filter((item) => item && !item.archived);
  const installed = list.filter((item) => item.installed)
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (Date.parse(b.recentlyUsedAt) || 0) - (Date.parse(a.recentlyUsedAt) || 0);
    });
  const official = sortAgentItems(list.filter((item) => !item.installed && item.official));
  const pending = sortAgentItems(list.filter((item) => !item.installed && !item.official && item.distributed));
  const ordered = [...installed, ...official, ...pending];
  return Number.isFinite(limit) ? ordered.slice(0, Math.max(0, limit)) : ordered;
}

/**
 * Compact capability chips for a popover row, built from the normalized
 * summary. Only dimensions with substance produce a chip (an inherited
 * autonomy/model or an empty list never shows), so the row says what the
 * agent actually bundles: "技能 3 · 知识 legal-cn · 确认后执行".
 */
export function agentCapabilityChips(item, translate) {
  const summary = item?.summary;
  if (!summary || typeof translate !== "function") return [];
  const chips = [];
  const skills = new Set([...(summary.skills?.required || []), ...(summary.skills?.enabled || [])]);
  if (skills.size) chips.push({ key: "skills", text: `${translate("character.agent.capSkills")} ${skills.size}` });
  const packs = (summary.knowledge?.packs || []).map((pack) => pack?.name || pack?.id).filter(Boolean);
  if (packs.length) chips.push({ key: "knowledge", text: `${translate("character.agent.capKnowledge")} ${packs.slice(0, 2).join(" / ")}${packs.length > 2 ? ` +${packs.length - 2}` : ""}` });
  const tools = new Set([...(summary.tools?.mcpAllow || []), ...(summary.tools?.connectors || [])]);
  if (tools.size) chips.push({ key: "tools", text: `${translate("character.agent.capTools")} ${tools.size}` });
  const autonomyId = summary.autonomy?.permissionModeId;
  if (autonomyId && autonomyId !== "inherit" && AGENT_AUTONOMY_KEYS[autonomyId]) {
    chips.push({ key: "autonomy", text: translate(AGENT_AUTONOMY_KEYS[autonomyId]) });
  }
  if (summary.model?.presetId) chips.push({ key: "model", text: `${translate("character.agent.capModel")} ${summary.model.presetId}` });
  return chips;
}

/** Localized degraded-dimension list for the activation notice. */
export function degradedDimensionLabels(receipt, translate) {
  const list = Array.isArray(receipt?.degraded) ? receipt.degraded : [];
  const seen = new Set();
  const labels = [];
  for (const entry of list) {
    const dimension = typeof entry?.dimension === "string" ? entry.dimension : "";
    if (!dimension || seen.has(dimension)) continue;
    seen.add(dimension);
    const key = AGENT_DIMENSION_KEYS[dimension];
    labels.push(key ? translate(key) : dimension);
  }
  return labels;
}
