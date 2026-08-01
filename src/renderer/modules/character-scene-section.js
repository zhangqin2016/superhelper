/**
 * §12 scene/group settings inside the character popover (extracted for the
 * session-control ratchet). Reads the current session scene (participants,
 * speaker strategy, prompt mode) and pushes validated edits via scene:update.
 */
export function createSceneSectionController({ getState, getFacade, getElement, t: translate }) {
  let scene = null;
  let loadSeq = 0;

  async function load() {
    const api = getFacade();
    const section = getElement("characterSceneSection");
    const state = getState();
    if (!api || !section || !state.sessionId) return;
    const seq = ++loadSeq;
    try {
      const res = await api.getScene(state.sessionId);
      if (seq !== loadSeq) return;
      scene = res?.ok ? (res.scene || null) : null;
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
  }

  return { bind, load, render };
}
