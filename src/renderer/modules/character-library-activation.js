const ACTIVATED_EVENT = "lily:character-library-activated";

export function createCharacterLibraryActivationHandler(onActivated) {
  return (detail) => {
    onActivated?.(detail);
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(ACTIVATED_EVENT, { detail }));
  };
}
