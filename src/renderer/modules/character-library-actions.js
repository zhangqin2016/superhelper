/**
 * Facade-calling operations for the character library manager (Character
 * Worlds Phase 2B, Task P2B-4). Extracted from ./character-library.js to keep
 * every renderer module inside the architecture line budget. All dependencies
 * (state access, dispatch, notices, DOM field reads) are injected by the
 * controller — this module holds no renderer state of its own, and every
 * operation fails open with a quiet localized notice.
 */

import { kindForTab, initialFormValues } from "./character-library-model.js";
import { installOfficialCharacter } from "./official-character-picker.js";

function isRevisionConflict(error) {
  return typeof error === "string" && error.endsWith("REVISION_CONFLICT");
}

export function createLibraryActions(ctx) {
  const {
    facade,
    getState,
    dispatch,
    setNotice,
    settle,
    syncFormValues,
    readFormValues,
    focusNameField,
    getActiveSessionId,
  } = ctx;

  async function loadCurrentTab() {
    const api = facade();
    if (!api) return;
    const tab = getState().tab;
    const current = () => getState().open && getState().tab === tab;
    try {
      let items = [];
      if (tab === "characters") {
        const [res, officialRes] = await Promise.all([
          api.listCharacters(),
          typeof api.listOfficialCharacters === "function"
            ? api.listOfficialCharacters().catch(() => ({ ok: false }))
            : Promise.resolve({ ok: false }),
        ]);
        if (!res?.ok && !officialRes?.ok) throw new Error("list failed");
        const installedIds = new Set(
          (officialRes?.characters || []).map((c) => c.installedCharacterId).filter(Boolean),
        );
        const officialRows = (officialRes?.characters || []).map((c) => ({
          ...c,
          id: `official:${c.id}`,
          officialId: c.id,
          name: c.displayName,
          source: "official",
          installed: Boolean(c.installedCharacterId),
          currentRevisionId: c.currentRevisionId || "",
        }));
        const base = (res?.characters || []).filter((c) => !c?.archivedAt && !installedIds.has(c.id));
        // Tags ride on the revision canonical; fetch per row so tag filtering
        // works. A failed read degrades that row's tags, never the list.
        // (Known N+1 — deferred per review; libraries are small and local.)
        items = await Promise.all(base.map(async (c) => {
          let tags = [];
          let sourceKind = "";
          try {
            const rev = await api.getCharacterRevision(c.currentRevisionId);
            if (rev?.ok && Array.isArray(rev.revision?.canonical?.tags)) {
              tags = rev.revision.canonical.tags.filter((entry) => typeof entry === "string" && entry);
            }
            // Agent-draft provenance (Phase 2C) rides the same read so the row
            // can badge agent-authored revisions; a failed read degrades both.
            if (rev?.ok && typeof rev.revision?.source?.kind === "string") {
              sourceKind = rev.revision.source.kind;
            }
          } catch { /* tag-less row */ }
          const canonical = rev?.ok ? rev.revision?.canonical || {} : {};
          const source = rev?.ok ? rev.revision?.source || {} : {};
          return {
            id: c.id,
            name: c.displayName,
            summary: typeof canonical.description === "string" ? canonical.description : "",
            currentRevisionId: c.currentRevisionId,
            tags,
            sourceKind,
            source: source.kind === "official" ? "official" : "local",
            officialId: typeof source.officialId === "string" ? source.officialId : "",
          };
        }));
        items = [...officialRows, ...items];
      } else if (tab === "personas") {
        const res = await api.listPersonas();
        if (!res?.ok) throw new Error("list failed");
        items = (res.personas || []).filter((p) => !p?.archivedAt);
      } else {
        const res = await api.listWorldBooks();
        if (!res?.ok) throw new Error("list failed");
        items = (res.worldBooks || []).filter((b) => !b?.archivedAt);
      }
      if (current()) dispatch({ type: "items.loaded", tab, items });
    } catch {
      if (current()) setNotice("load_failed");
    }
  }

  async function openDetail(item) {
    const api = facade();
    if (!api || !item?.id) return;
    dispatch({ type: "detail.selected", itemId: item.id });
    try {
      let detail;
      if (item.official && item.officialId && typeof api.getOfficialCharacter === "function") {
        const res = await api.getOfficialCharacter(item.officialId);
        detail = res?.ok ? res.character : null;
      } else if (getState().tab === "characters") {
        const res = await api.getCharacterRevision(item.currentRevisionId);
        const canonical = res?.ok ? res.revision?.canonical || {} : null;
        detail = canonical ? {
          ...item,
          summary: canonical.description || item.summary || "",
          description: canonical.description || "",
          personality: canonical.personality || "",
          scenario: canonical.scenario || "",
          tags: Array.isArray(canonical.tags) ? canonical.tags : item.tags,
          sourceKind: res.revision?.source?.kind || item.sourceKind,
        } : null;
      } else if (getState().tab === "personas") {
        const res = await api.getPersona(item.id);
        detail = res?.ok ? res.persona : null;
      } else {
        const res = await api.getWorldBook(item.id);
        detail = res?.ok ? res.worldBook : null;
      }
      if (getState().selectedItemId === item.id) {
        if (detail) dispatch({ type: "detail.loaded", itemId: item.id, detail });
        else dispatch({ type: "detail.failed", itemId: item.id });
      }
    } catch {
      if (getState().selectedItemId === item.id) dispatch({ type: "detail.failed", itemId: item.id });
    }
  }

  async function activateItem(item) {
    const api = facade();
    const sessionId = getActiveSessionId?.();
    if (!api || !sessionId || !item || getState().activation.status === "running") return;
    dispatch({ type: "activation.started", itemId: item.id });
    try {
      let target = item;
      if (item.kind === "character" && item.official) {
        target = await installOfficialCharacter(api, item);
      }
      if (!target?.currentRevisionId) {
        dispatch({ type: "activation.failed", itemId: item.id, error: "NOT_INSTALLED" });
        setNotice("action_failed");
        return;
      }
      const current = await api.getSessionCharacterBinding(sessionId);
      if (!current?.ok || !Number.isInteger(current.binding?.bindingVersion)) {
        dispatch({ type: "activation.failed", itemId: item.id, error: "BINDING_UNAVAILABLE" });
        setNotice("action_failed");
        return;
      }
      const res = await api.activateLibraryItem({
        sessionId,
        kind: item.kind,
        revisionId: target.currentRevisionId,
        scope: item.kind === "worldBook" ? "chat" : undefined,
        mergeStrategy: item.kind === "worldBook" ? "constant" : undefined,
        expectedBindingVersion: current.binding.bindingVersion,
      });
      if (res?.ok) {
        dispatch({ type: "activation.settled", itemId: item.id });
        setNotice("activated", { name: target.displayName || target.name || item.name });
        if (item.kind === "character") await loadCurrentTab();
      } else {
        dispatch({ type: "activation.failed", itemId: item.id, error: res?.error || "ACTIVATION_FAILED" });
        setNotice(res?.error === "CHARACTER_BINDING_CONFLICT" ? "conflict" : "action_failed");
      }
    } catch {
      dispatch({ type: "activation.failed", itemId: item.id, error: "ACTIVATION_FAILED" });
      setNotice("action_failed");
    }
  }

  // A save is always an explicit revision-creating mutation: create for a new
  // entity, otherwise update-revision with CAS on the base revision the form
  // was opened from. Existing conversations stay pinned (spec §8).
  async function saveForm() {
    const api = facade();
    const form = getState().form;
    if (!api || !form || getState().busy) return;
    const values = readFormValues();
    const name = (values.name || "").trim();
    if (!name) {
      setNotice("name_required");
      return;
    }
    const tags = (values.tags || "").split(/[,，]/)
      .map((entry) => entry.trim()).filter(Boolean);
    // Sync state before the busy-toggle re-render so the rebuild shows the
    // same values the user just typed (and a failed save loses nothing).
    syncFormValues();
    dispatch({ type: "busy.set", busy: true });
    try {
      let result;
      if (form.kind === "character") {
        const edited = {
          name,
          description: values.description,
          personality: values.personality,
          scenario: values.scenario,
          tags,
        };
        result = form.mode === "create"
          ? await api.createCharacter({ canonical: edited })
          : await api.updateCharacterRevision({
            characterId: form.entityId,
            expectedBaseRevisionId: form.baseRevisionId,
            canonical: { ...(form.canonical || {}), ...edited },
          });
      } else if (form.kind === "persona") {
        const canonical = {
          ...(form.mode === "edit" ? form.canonical || {} : {}),
          name,
          description: values.description,
        };
        result = form.mode === "create"
          ? await api.createPersona({ canonical })
          : await api.updatePersonaRevision({
            personaId: form.entityId,
            expectedBaseRevisionId: form.baseRevisionId,
            canonical,
          });
      } else {
        result = await api.createWorldBook({ canonical: { name, entries: [] } });
      }
      if (result?.ok) {
        settle("mutation.settled", form.mode === "create" ? "created" : "saved_revision",
          form.mode === "create" ? { name } : { number: result.revision?.revisionNumber ?? "" });
        await loadCurrentTab();
      } else {
        // A revision conflict is actionable differently than a transient
        // failure: another edit landed, so the form's base is stale.
        settle("mutation.failed", isRevisionConflict(result?.error) ? "conflict" : "action_failed");
      }
    } catch {
      settle("mutation.failed", "action_failed");
    }
  }

  async function openEdit(item) {
    const api = facade();
    if (!api) return;
    const kind = kindForTab(getState().tab);
    try {
      const res = kind === "character"
        ? await api.getCharacterRevision(item.currentRevisionId)
        : await api.getPersonaRevision(item.currentRevisionId);
      if (!res?.ok || !res.revision?.canonical) {
        setNotice("action_failed");
        return;
      }
      const initialValues = initialFormValues("edit", res.revision.canonical);
      dispatch({
        type: "form.opened",
        form: {
          mode: "edit",
          kind,
          entityId: item.id,
          baseRevisionId: item.currentRevisionId,
          revisionNumber: res.revision.revisionNumber,
          canonical: res.revision.canonical,
          initialValues,
          values: { ...initialValues },
        },
      });
      focusNameField();
    } catch {
      setNotice("action_failed");
    }
  }

  async function openHistory(item) {
    const api = facade();
    if (!api) return;
    const kind = kindForTab(getState().tab);
    try {
      const res = kind === "character"
        ? await api.getCharacterHistory(item.id)
        : kind === "persona"
          ? await api.getPersonaHistory(item.id)
          : await api.getWorldBookHistory(item.id);
      if (!res?.ok) {
        setNotice("action_failed");
        return;
      }
      dispatch({
        type: "history.opened",
        history: { kind, entityId: item.id, name: item.name, revisions: res.revisions || [] },
      });
    } catch {
      setNotice("action_failed");
    }
  }

  async function duplicateItem(item) {
    const api = facade();
    if (!api || getState().busy) return;
    dispatch({ type: "busy.set", busy: true });
    try {
      const res = await api.duplicateCharacter(item.id);
      if (res?.ok) {
        settle("mutation.settled", "duplicated", { name: item.name });
        await loadCurrentTab();
      } else {
        settle("mutation.failed", "action_failed");
      }
    } catch {
      settle("mutation.failed", "action_failed");
    }
  }

  // Export delegates to the existing flow: a main-process save dialog plus an
  // opaque broker reservation — the renderer never supplies a path (§15).
  async function exportItem(item) {
    const api = facade();
    if (!api) return;
    try {
      const res = await api.exportCharacter(item.currentRevisionId);
      if (res?.ok) setNotice("exported", { name: item.name });
      else if (!res?.canceled) setNotice("action_failed");
    } catch {
      setNotice("action_failed");
    }
  }

  async function confirmAction() {
    const api = facade();
    const confirm = getState().confirm;
    if (!api || !confirm || getState().busy) return;
    dispatch({ type: "busy.set", busy: true });
    try {
      if (confirm.action === "archive") {
        const res = confirm.kind === "character"
          ? await api.archiveCharacter(confirm.entityId)
          : confirm.kind === "persona"
            ? await api.archivePersona(confirm.entityId)
            : await api.archiveWorldBook(confirm.entityId);
        if (res?.ok) {
          settle("mutation.settled", "archived", { name: confirm.name });
          await loadCurrentTab();
          return;
        }
      } else if (confirm.action === "restore") {
        // CAS base must be the entity's CURRENT revision at confirm time,
        // not the pre-history list snapshot: re-fetch, then fall back to the
        // history view's own (fresher) newest row, then the list snapshot.
        const item = (getState().items[getState().tab] || [])
          .find((entry) => entry.id === confirm.entityId);
        let baseRevisionId = getState().history?.revisions?.[0]?.revisionId
          || item?.currentRevisionId;
        try {
          const fresh = await api.getCharacter(confirm.entityId);
          if (fresh?.ok && fresh.character?.currentRevisionId) {
            baseRevisionId = fresh.character.currentRevisionId;
          }
        } catch { /* fall back to the history view's data */ }
        const res = await api.restoreCharacterRevision({
          characterId: confirm.entityId,
          revisionId: confirm.revisionId,
          expectedBaseRevisionId: baseRevisionId,
        });
        if (res?.ok) {
          settle("mutation.settled", "restored", { number: res.revision?.revisionNumber ?? "" });
          await loadCurrentTab();
          return;
        }
        settle("mutation.failed", isRevisionConflict(res?.error) ? "conflict" : "action_failed");
        return;
      }
      settle("mutation.failed", "action_failed");
    } catch {
      settle("mutation.failed", "action_failed");
    }
  }

  // Import through the existing preview/commit flow, then report preserved vs
  // unsupported inert counts (§13.2). The file picker stays main-side.
  async function startImport() {
    const api = facade();
    if (!api || getState().busy) return;
    dispatch({ type: "busy.set", busy: true });
    try {
      const preview = await api.previewCharacterImport();
      if (preview?.ok && preview.kind === "characterCard") {
        const payload = { previewToken: preview.previewToken };
        if (preview.duplicates?.canonical) payload.duplicateResolution = "create_copy";
        const res = await api.commitCharacterImport(payload);
        dispatch({ type: "busy.set", busy: false });
        if (res?.ok) {
          const counts = preview.compatibility?.counts || {};
          setNotice("import_report", {
            name: res.entity?.displayName || preview.canonical?.name || "",
            supported: counts.supported ?? 0,
            inert: counts.preservedInert ?? 0,
          });
          await loadCurrentTab();
        } else {
          setNotice("import_failed");
        }
      } else {
        dispatch({ type: "busy.set", busy: false });
        if (preview?.canceled) return;
        setNotice(preview?.error === "NOT_A_CHARACTER_CARD" ? "ordinary_attachment" : "import_failed");
      }
    } catch {
      dispatch({ type: "busy.set", busy: false });
      setNotice("import_failed");
    }
  }

  return {
    loadCurrentTab,
    saveForm,
    openEdit,
    openHistory,
    duplicateItem,
    exportItem,
    confirmAction,
    startImport,
    openDetail,
    activateItem,
  };
}
