// Tool registry and the entry point the service worker calls for every tool call.
//
// Scheduling: calls on different tabs run in parallel (up to MAX_PARALLEL at once);
// calls on the same tab run one after another in arrival order, so mouse and keyboard
// input on a tab never interleave. Calls without a tab queue per agent.

import type { ToolContent } from '../../../../shared/protocol';
import { finish, failureText, seal } from '../policy/guard';
import type { ActivityEntry } from '../../messages';
import { protectContent } from '../output/protect';
import { outputTools } from '../output/tools';
import { assertSecretsAllowed, secretsTools } from '../secrets/tools';
import { setRunningAgent } from '../snapshot/session';
import { pausedLoaded, state } from '../state';
import { beginStep } from '../workflows/recorder';
import { workflowTools } from '../workflows/tools';
import { DEFAULT_AGENT } from './agent-id';
import { agentJustStopped, agentSignal } from './agent-stop';
import { beginCall } from './agents';
import { answerSitePermissionPrompts } from '../site-permission-prompts-auto-answer';
import { browserDataTools } from './browser-data';
import { captureTools } from './capture';
import { devtoolsLogTools } from './devtools-logs';
import { dialogFileTools } from './dialogs-files';
import { emulationTools } from './emulation';
import { formTools } from './forms';
import { handbackTools } from './handback';
import { keyboardTools } from './keyboard';
import { mouseTools } from './mouse';
import { navigationTools } from './navigation';
import { pageDataTools } from './page-data';
import { Scheduler } from './scheduler';
import { selectionTools } from './selection';
import { sessionTools } from './session';
import { snapshotTools } from './snapshot';
import { tabsTools } from './tabs';
import { resolveTab } from './tab';
import { justStopped, PAUSED, STOPPED, text, ToolError, TrustedError, type Args, type ToolCtx, type ToolSpec } from './types';
import { waitTools } from './wait';

export { hideAgentBar, showAgentBar } from './overlay';

const MAX_PARALLEL = 6;
/** The extension gives up on a call this long before the relay does, so its own error text reaches the agent. */
const DEADLINE_SLACK_MS = 2000;

const TOOLS: Record<string, ToolSpec> = {
  ...tabsTools,
  ...navigationTools,
  ...snapshotTools,
  ...mouseTools,
  ...keyboardTools,
  ...formTools,
  ...captureTools,
  ...pageDataTools,
  ...waitTools,
  ...selectionTools,
  ...dialogFileTools,
  ...devtoolsLogTools,
  ...emulationTools,
  ...browserDataTools,
  ...handbackTools,
  ...outputTools,
  ...secretsTools,
  ...sessionTools,
  // Replays call tools like any agent would, but must not be recorded as steps themselves.
  ...workflowTools((tool, args, agent, giveUp) => execute(tool, args, agent, false, { signal: giveUp })),
};

export const TOOL_NAMES = Object.keys(TOOLS);

const scheduler = new Scheduler(MAX_PARALLEL);

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** What the safety layer saw, for the audit log. */
  audit: Pick<ActivityEntry, 'host' | 'outcome' | 'approval'>;
}

/** How long the relay waits for this call, and its cancel signal. */
export interface CallLimits {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One signal that fires when the relay cancels the call or its deadline passes. A call given up on
 * frees its tab's queue and its slot even when a Chrome API under it never answers.
 */
function callSignal(tool: string, limits: CallLimits): { signal?: AbortSignal; clear: () => void } {
  const signals = limits.signal ? [limits.signal] : [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (limits.timeoutMs) {
    const deadline = new AbortController();
    const seconds = Math.round(limits.timeoutMs / 1000);
    timer = setTimeout(
      () => deadline.abort(new TrustedError(`Chrome did not finish "${tool}" within ${seconds}s, so Helmsman gave up on it: the page may be frozen or showing a dialog. Take a snapshot (or browser_tabs "list") to see the current state.`)),
      Math.max(1000, limits.timeoutMs - DEADLINE_SLACK_MS),
    );
    signals.push(deadline.signal);
  }
  return { signal: signals.length ? AbortSignal.any(signals) : undefined, clear: () => clearTimeout(timer) };
}

const failure = (message: string, audit: ToolResult['audit'] = {}): Executed => ({ content: text(message), isError: true, audit: { outcome: 'error', ...audit }, seal: false, notes: [] });

/** Runs a tool call and applies what every result gets on the way out: secrets hidden, output budget enforced. */

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  agent: string = DEFAULT_AGENT,
  limits: CallLimits = {},
): Promise<ToolResult> {
  const result = await execute(name, args, agent, true, limits);
  // Redact and apply the output budget to the page content first, then seal it in the untrusted envelope so a truncated result still ends with its closing tag.
  const protectedContent = await protectContent(result.content, agent, args ?? {});
  return { content: result.seal ? seal(protectedContent, result.notes) : protectedContent, isError: result.isError, audit: result.audit };
}

interface Executed extends ToolResult {
  /** Success results carry page content: they are sealed in the untrusted envelope after protection. */
  seal: boolean;
  notes: string[];
}

async function execute(
  name: string,
  args: Record<string, unknown>,
  agent: string,
  record: boolean,
  limits: CallLimits = {},
): Promise<Executed> {
  await pausedLoaded;
  if (state.paused) return failure(PAUSED);
  if (justStopped() || agentJustStopped(agent)) return failure(STOPPED);
  const spec = TOOLS[name];
  if (!spec) return failure(`Unknown tool ${name}.`);
  const endCall = await beginCall(agent);
  // Pressing Stop drops the calls still waiting their turn (every agent's, or only the stopped
  // agent's); the running ones notice at their next step.
  const everyone = state.abort.signal;
  const mine = agentSignal(agent);
  const call = callSignal(name, limits);
  const signal = AbortSignal.any(call.signal ? [everyone, mine, call.signal] : [everyone, mine]);
  const onStopAll = () => scheduler.cancelPending(new ToolError(STOPPED));
  const onStopMine = () => scheduler.cancelPending(new ToolError(STOPPED), agent);
  everyone.addEventListener('abort', onStopAll, { once: true });
  mine.addEventListener('abort', onStopMine, { once: true });
  const ctx: ToolCtx = { agent, tabId: -1, signal, giveUp: call.signal, audit: {}, notes: [] };
  try {
    const input = (args ?? {}) as Args;
    assertSecretsAllowed(name, input);
    let lane = `${spec.lane ?? 'agent'}:${agent}`;
    if (spec.scope === 'tab') {
      const tab = await resolveTab(agent, input.tabId);
      ctx.tabId = tab.id!;
      // A tab the agent just took over may already be on a site that will ask for permissions.
      void answerSitePermissionPrompts(tab.url ?? '');
      lane = `tab:${tab.id}`;
    }
    const content = await scheduler.run(lane, async () => {
      if (state.paused) throw new ToolError(PAUSED);
      if (signal.aborted || agentJustStopped(agent)) throw new ToolError(STOPPED);
      if (spec.scope === 'tab') setRunningAgent(ctx.tabId, agent);
      const recorded = record ? await beginStep(agent, name, input, ctx) : undefined;
      const result = await spec.run(input, ctx);
      recorded?.();
      return finish(ctx, name, result);
    }, agent, call.signal);
    // Helmsman's own bookkeeping (secret names, the workflow list) is machine-read JSON, not page content.
    const own = name === 'browser_secrets_list' || (name === 'browser_workflow' && input.action !== 'run');
    return { content, audit: { outcome: 'ok', ...ctx.audit }, seal: !own, notes: ctx.notes };
  } catch (e) {
    return failure(failureText(e), ctx.audit);
  } finally {
    call.clear();
    endCall();
    everyone.removeEventListener('abort', onStopAll);
    mine.removeEventListener('abort', onStopMine);
  }
}
