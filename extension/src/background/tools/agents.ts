// Which agent owns which tab, and the Chrome tab group that shows it. Every agent
// has a default tab (used when a call names none) and its tabs live in a group
// titled with the agent's name and a colour of its own, per window.
//
// Ownership is a lease: an agent that made no call for LEASE_MS (it exited, or its
// MCP server restarted under a new id) no longer holds its tabs, so another agent may
// take them. While the lease is live, other agents are refused.

import { setAgentTab } from '../state';
import { agentLabel, cleanName, pickColor, uniqueLabel } from './agent-id';
import { forgetAgentStop } from './agent-stop';
import { Scheduler } from './scheduler';
import { ToolError, TrustedError } from './types';

/** How long an agent keeps its tabs without making a call. */
export const LEASE_MS = 10 * 60_000;
/** Bookkeeping of agents silent this long is dropped. */
const FORGET_MS = 24 * 3600_000;
/** lastSeen is persisted at most this often per agent (it changes on every call). */
const SAVE_EVERY_MS = 15_000;

interface Store {
  /** agent -> default tab */
  defaults: Record<string, number>;
  /** tab -> owning agent */
  owners: Record<number, string>;
  /** agent -> window -> tab group */
  groups: Record<string, Record<number, number>>;
  /** agent -> group colour */
  colors: Record<string, string>;
  /** agent -> time of its latest call */
  lastSeen: Record<string, number>;
  /** agent -> its group title (unique among live agents) */
  names: Record<string, string>;
}

const KEY = 'agents';
const empty = (): Store => ({ defaults: {}, owners: {}, groups: {}, colors: {}, lastSeen: {}, names: {} });
let store: Store = empty();
const loaded = chrome.storage.session.get(KEY).then((v) => {
  store = { ...empty(), ...((v[KEY] as Partial<Store> | undefined) ?? {}) };
});
const save = () => chrome.storage.session.set({ [KEY]: store }).catch(() => {});
/** Resolves once the persisted store has been read after a service-worker start. */
export const agentsReady: Promise<void> = loaded;

/** When each agent's lastSeen was last persisted (memory only: after a restart the first call saves). */
const lastSaved = new Map<string, number>();
/** Calls each agent has running now: an agent waiting on a long call (the user's help, an approval) keeps its tabs. */
const inFlight = new Map<string, number>();

// Choosing a tab for an agent must not interleave with another agent doing the same. The lock is
// given up after CLAIM_LOCK_TIMEOUT_MS so a Chrome call that never answers under it (a tab stuck
// closing, a frozen renderer) cannot block every agent's tab choice forever.
const claims = new Scheduler(1);
const CLAIM_LOCK_TIMEOUT_MS = 20_000;
export const withClaimLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new TrustedError('Chrome did not answer while Helmsman was choosing or closing a tab (it may be busy or a page may be frozen). Try again in a moment.')),
    CLAIM_LOCK_TIMEOUT_MS,
  );
  return claims.run('claim', async () => {
    await loaded;
    return fn();
  }, undefined, deadline.signal).finally(() => clearTimeout(timer));
};

const isLive = (agent: string, now = Date.now()) => (inFlight.get(agent) ?? 0) > 0 || now - (store.lastSeen[agent] ?? 0) < LEASE_MS;
const liveOthers = (agent: string) => Object.keys(store.lastSeen).filter((a) => a !== agent && isLive(a));

/** The agent holding `tabId` right now: its owner, unless that owner's lease ran out. */
export const ownerOf = (tabId: number): string | undefined => {
  const owner = store.owners[tabId];
  return owner && isLive(owner) ? owner : undefined;
};
/** The agent whose tab this was, even when its lease has run out (whose agent bar the tab shows). */
export const lastOwnerOf = (tabId: number): string | undefined => store.owners[tabId];
/** The agent's default tab, if it still holds it. */
export const defaultTabOf = (agent: string): number | undefined => {
  const tabId = store.defaults[agent];
  return tabId !== undefined && store.owners[tabId] === agent ? tabId : undefined;
};
/** Every tab `agent` owns. */
export async function tabsOf(agent: string): Promise<number[]> {
  await loaded;
  return Object.entries(store.owners).filter(([, owner]) => owner === agent).map(([tabId]) => Number(tabId));
}

/** The agent's group title: the name it chose, else its folder or client, made unique among live agents. */
export function nameOf(agent: string): string {
  return store.names[agent] ?? agentLabel(agent);
}

/**
 * Records the start of a call by `agent`: renews its lease and gives a newcomer its starting group
 * title. The agent holds its tabs until the returned function is called (when the call ends) and
 * for LEASE_MS after.
 */
export async function beginCall(agent: string): Promise<() => void> {
  await touch(agent);
  inFlight.set(agent, (inFlight.get(agent) ?? 0) + 1);
  return () => {
    const left = (inFlight.get(agent) ?? 1) - 1;
    // The lease restarts now, synchronously, so there is no moment between the call ending and the
    // save below when the agent looks expired.
    store.lastSeen[agent] = Date.now();
    if (left > 0) inFlight.set(agent, left);
    else inFlight.delete(agent);
    void touch(agent);
  };
}

/** Renews the agent's lease (see beginCall). */
export async function touch(agent: string): Promise<void> {
  await loaded;
  const now = Date.now();
  const before = store.lastSeen[agent] ?? 0;
  store.lastSeen[agent] = now;
  if (!store.names[agent] || (now - before >= LEASE_MS && !inFlight.get(agent))) {
    // A newcomer, or one returning after its lease ran out: its title may have been taken meanwhile.
    const previous = store.names[agent];
    store.names[agent] = uniqueLabel(cleanName(previous) || agentLabel(agent), liveOthers(agent).map(nameOf));
    if (previous && previous !== store.names[agent]) await retitle(agent);
  }
  // Persisted every SAVE_EVERY_MS at most, so a restarted service worker still knows the agent is active.
  if (now - (lastSaved.get(agent) ?? 0) >= SAVE_EVERY_MS) {
    lastSaved.set(agent, now);
    forgetSilent(now);
    await save();
  }
}

/** Sets the group title `agent` chose for itself and returns it (with a `·N` suffix when a live agent has it). */
export async function rename(agent: string, name: unknown): Promise<string> {
  const base = cleanName(name);
  if (!base) throw new ToolError('name must contain some visible text.');
  await loaded;
  store.names[agent] = uniqueLabel(base, liveOthers(agent).map(nameOf));
  await retitle(agent);
  await save();
  return store.names[agent];
}

/** Applies the agent's title to its groups in every window. */
async function retitle(agent: string): Promise<void> {
  if (!chrome.tabGroups) return;
  const title = nameOf(agent);
  await Promise.all(Object.values(store.groups[agent] ?? {}).map((g) => chrome.tabGroups.update(g, { title }).catch(() => {})));
}

/** Drops the bookkeeping of agents that have been silent for a day and own no tab. */
function forgetSilent(now: number) {
  const owning = new Set(Object.values(store.owners));
  for (const agent of Object.keys(store.lastSeen)) {
    if (now - store.lastSeen[agent] < FORGET_MS || owning.has(agent)) continue;
    delete store.lastSeen[agent];
    delete store.names[agent];
    delete store.colors[agent];
    delete store.groups[agent];
    delete store.defaults[agent];
    lastSaved.delete(agent);
    forgetAgentStop(agent);
  }
}

/** Refuses when another agent holds the tab; minutes are rounded up so "0 minutes" never shows. */
export function assertNotHeld(agent: string, tabId: number): void {
  const owner = ownerOf(tabId);
  if (!owner || owner === agent) return;
  const left = Math.max(1, Math.ceil((LEASE_MS - (Date.now() - store.lastSeen[owner])) / 60_000));
  throw new ToolError(
    `Tab ${tabId} belongs to another agent (tab group "${nameOf(owner)}"), which is still working in it. ` +
      `Do not use it: open a tab of your own with browser_tabs action "new". ` +
      `It is released if that agent makes no call for ${left} more minute${left === 1 ? '' : 's'}.`,
  );
}

/** Makes `tab` belong to `agent` (and optionally its default) and puts it in the agent's tab group. Call inside the claim lock. */
export async function adopt(agent: string, tab: chrome.tabs.Tab, makeDefault: boolean): Promise<void> {
  const tabId = tab.id!;
  assertNotHeld(agent, tabId);
  const previous = store.owners[tabId];
  if (previous && previous !== agent && store.defaults[previous] === tabId) delete store.defaults[previous];
  store.owners[tabId] = agent;
  if (makeDefault) {
    store.defaults[agent] = tabId;
    await setAgentTab(tabId); // legacy single-tab key still read by the service worker entry
  }
  await ensureGrouped(agent, tab).catch(() => {});
  await save();
}

async function liveGroup(groupId: number | undefined): Promise<chrome.tabGroups.TabGroup | null> {
  if (groupId === undefined) return null;
  return chrome.tabGroups.get(groupId).catch(() => null);
}

/** Group id -> agent, for every group Helmsman made. */
const agentOfGroup = (groupId: number) =>
  Object.entries(store.groups).find(([, windows]) => Object.values(windows).includes(groupId))?.[0];

async function ensureGrouped(agent: string, tab: chrome.tabs.Tab): Promise<void> {
  if (!chrome.tabGroups) return;
  const windowId = tab.windowId;
  const inWindow = (store.groups[agent] ??= {});
  const fresh = await chrome.tabs.get(tab.id!);
  // A tab the user keeps in a group of their own stays where it is; one in another agent's group
  // can only get here once that agent's lease ran out, so it moves to the new owner's group.
  const from = fresh.groupId === -1 ? undefined : agentOfGroup(fresh.groupId);
  if (fresh.groupId !== -1 && fresh.groupId !== inWindow[windowId] && (!from || from === agent)) return;
  let group = await liveGroup(inWindow[windowId]);
  if (!group) {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id!], createProperties: { windowId } });
    const taken = liveOthers(agent).map((a) => store.colors[a]).filter(Boolean);
    const color = (store.colors[agent] ??= pickColor(agent, taken));
    group = (await chrome.tabGroups.update(groupId, { title: nameOf(agent), color: color as `${chrome.tabGroups.Color}` })) ?? null;
    inWindow[windowId] = groupId;
  } else if (fresh.groupId !== group.id) {
    await chrome.tabs.group({ tabIds: [tab.id!], groupId: group.id });
  }
}

/** Short description for tab listings and results, e.g. `owned by "ChatGPT"`. */
export function ownerLabel(tabId: number): string | undefined {
  const owner = ownerOf(tabId);
  return owner ? nameOf(owner) : undefined;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void loaded.then(() => {
    const owner = store.owners[tabId];
    delete store.owners[tabId];
    if (owner && store.defaults[owner] === tabId) delete store.defaults[owner];
    void save();
  });
});

if (chrome.tabGroups) {
  chrome.tabGroups.onRemoved.addListener((group) => {
    void loaded.then(() => {
      for (const windows of Object.values(store.groups)) {
        for (const [w, id] of Object.entries(windows)) if (id === group.id) delete windows[Number(w)];
      }
      void save();
    });
  });
}
