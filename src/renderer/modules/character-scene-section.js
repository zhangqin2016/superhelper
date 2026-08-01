/**
 * §12 scene/group settings inside the character popover (extracted for the
 * session-control ratchet). Reads the current session scene (participants,
 * speaker strategy, prompt mode) and pushes validated edits via scene:update.
 */
export function createSceneSectionController({ getState, getFacade, getElement, t: translate }) {
  let scene = null;
  let memory = [];
  let greetings = [];
  let loadSeq = 0;

  async function load() {
    const api = getFacade();
    const section = getElement("characterSceneSection");
    const state = getState();
    if (!api || !section || !state.sessionId) return;
    const seq = ++loadSeq;
    try {
      const [res, gres] = await Promise.all([
        api.getScene(state.sessionId),
        api.getGreetings && state.characterRevisionId ? api.getGreetings(state.characterRevisionId) : Promise.resolve({ ok: true, greetings: [] }),
      ]);
      if (seq !== loadSeq) return;
      scene = res?.ok ? (res.scene || null) : null;
      greetings = gres?.ok ? (gres.greetings || []) : [];
      memory = [];
      if (scene && state.characterRevisionId && api.getSceneMemory) {
        const m = await api.getSceneMemory(state.sessionId, state.characterRevisionId);
        if (seq !== loadSeq) return;
        memory = m?.ok ? (m.memory || []) : [];
      }
      render();
    } catch {
      scene = null;
    }
  }

  function render() {
    const section = getElement("characterSceneSection");
    if (!section) return;
    section.hidden = !scene;
    if (!scene) return;
    getElement("characterSceneParticipants").textContent = (scene.participants || []).map((p) => p.name).join("、") || translate("character.unnamed");
    getElement("characterSceneStrategy").value = scene.replyStrategy || "natural";
    getElement("characterSceneMode").value = scene.promptMode || "swap";
    const greetRow = section.querySelector(".character-scene-greeting-row");
    const greetSel = getElement("characterSceneGreeting");
    if (greetRow && greetSel) {
      greetRow.hidden = greetings.length === 0;
      const prev = greetSel.value;
      greetSel.textContent = "";
      for (const g of greetings) {
        const opt = document.createElement("option");
        opt.value = String(g.index);
        opt.textContent = g.text || translate("character.sceneGreetingDefault");
        greetSel.appendChild(opt);
      }
      if (greetings.length) greetSel.value = prev || String(greetings[0].index);
    }
    const memEl = getElement("characterSceneMemory");
    if (memEl) {
      memEl.textContent = memory.length
        ? memory.map((m) => m.text).join(" | ").slice(0, 220)
        : translate("character.sceneNoMemory");
    }
  }

  async function updateGreeting() {
    const sel = getElement("characterSceneGreeting");
    const api = getFacade();
    const state = getState();
    if (!sel || !api || !state.sessionId || !state.characterRevisionId || !state.bindingVersion) return;
    const index = Number(sel.value);
    try {
      const res = await api.setSessionCharacterBinding({
        sessionId: state.sessionId,
        expectedBindingVersion: state.bindingVersion,
        mode: "character",
        characterRevisionId: state.characterRevisionId,
        greetingIndex: index,
      });
      if (!res?.ok) load();
    } catch {
      load();
    }
  }

  async function updateField(field, value) {
    const api = getFacade();
    const state = getState();
    if (!api || !scene || !state.sessionId) return;
    if (field === "strategy" && !["natural", "manual", "list_order", "pooled", "semantic"].includes(value)) return;
    if (field === "mode" && !["swap", "join"].includes(value)) return;
    try {
      await api.updateScene({
        sessionId: state.sessionId,
        ...(field === "strategy" ? { replyStrategy: value } : { promptMode: value }),
      });
      if (field === "strategy") scene.replyStrategy = value;
      if (field === "mode") scene.promptMode = value;
    } catch {
      render();
    }
  }

  function bind() {
    getElement("characterSceneStrategy")?.addEventListener("change", (event) => void updateField("strategy", event.target.value));
    getElement("characterSceneMode")?.addEventListener("change", (event) => void updateField("mode", event.target.value));
    getElement("characterSceneGreeting")?.addEventListener("change", () => void updateGreeting());
  }

  return { bind, load, render };
}
