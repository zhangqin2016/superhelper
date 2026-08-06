const ACTIVATED_EVENT = "lily:character-library-activated";

export function createCharacterLibraryActivationHandler(onActivated) {
  return (detail) => {
    onActivated?.();
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(ACTIVATED_EVENT, { detail }));
  };
}
