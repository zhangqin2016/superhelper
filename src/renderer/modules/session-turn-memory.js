/**
 * What a session remembers about turns that already finished.
 *
 * A late or replayed event must not resurrect a completed turn, so the runtime
 * keeps the ids it has already seen end. Two properties matter and neither was
 * true when this lived as a module-global Set:
 *
 *   - it belongs to ONE session, so it dies with that session instead of being
 *     swept out by a prefix scan over every turn the process ever saw;
 *   - it is bounded, because events arrive late by seconds, not by thousands of
 *     turns. Without a bound the set grows for the life of the application.
 */

export const TERMINAL_TURN_MEMORY = 200;

/** The per-session fields; spread into the empty runtime session. */
export function createTurnMemory() {
  return { terminalTurns: new Set(), recoveryTurns: new Set() };
}

/** Remember a finished turn, forgetting the oldest first. */
export function rememberTerminalTurn(runtime, turnId) {
  if (!runtime?.terminalTurns || !turnId) return;
  runtime.terminalTurns.add(turnId);
  while (runtime.terminalTurns.size > TERMINAL_TURN_MEMORY) {
    runtime.terminalTurns.delete(runtime.terminalTurns.values().next().value);
  }
}

/** Whether this turn has already reached a terminal event in this session. */
export function isTerminalTurn(runtime, turnId) {
  return Boolean(turnId && runtime?.terminalTurns?.has(turnId));
}
