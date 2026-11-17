// Stop for one agent. The on-page Stop button ends the task of the agent working in that
// tab only, so other agents running in parallel carry on. (The popup's controls and a Stop
// on a tab nobody holds still stop every agent, through state.abort.)

const controllers = new Map<string, AbortController>();
const stoppedUntil = new Map<string, number>();

/** Aborted when the user stops this agent; a fresh signal is handed out after each Stop. */
export function agentSignal(agent: string): AbortSignal {
  let controller = controllers.get(agent);
  if (!controller) {
    controller = new AbortController();
    controllers.set(agent, controller);
  }
  return controller.signal;
}

/** Aborts the agent's running calls and refuses its new ones for `graceMs`, so its lined-up steps are dropped. */
export function stopAgent(agent: string, graceMs: number): void {
  stoppedUntil.set(agent, Date.now() + graceMs);
  controllers.get(agent)?.abort();
  controllers.delete(agent);
}

export const agentJustStopped = (agent: string): boolean => Date.now() < (stoppedUntil.get(agent) ?? 0);

/** Drops the state of an agent that has been gone for long. */
export function forgetAgentStop(agent: string): void {
  controllers.delete(agent);
  stoppedUntil.delete(agent);
}

/** "Resume" from the popup: every agent may work again at once. */
export const clearAgentStops = (): void => stoppedUntil.clear();
