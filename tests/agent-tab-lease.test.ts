// Tab ownership between agents (extension/src/background/tools/agents.ts) against an in-memory
// stand-in for the few chrome.* APIs it uses, with a controllable clock: another agent's tab is
// refused while its owner is active and released after the lease, and group titles stay unique.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Tab = { id: number; windowId: number; groupId: number; url: string };
const tabs = new Map<number, Tab>();
const groups = new Map<number, { id: number; title?: string; color?: string; windowId: number }>();
let nextGroup = 100;
const noopEvent = { addListener: () => {} };

function installChrome() {
  const session: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).__GATEWAY_URL__ = 'http://localhost';
  (globalThis as Record<string, unknown>).__LOCAL_PORT__ = 47821;
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      session: {
        get: async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
        set: async (v: Record<string, unknown>) => void Object.assign(session, structuredClone(v)),
        remove: async (key: string) => void delete session[key],
      },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: { sendMessage: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      onRemoved: noopEvent,
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error('no tab');
        return { ...t };
      },
      group: async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { id, windowId: createProperties!.windowId });
        for (const t of tabIds) tabs.get(t)!.groupId = id;
        return id;
      },
    },
    tabGroups: {
      onRemoved: noopEvent,
      get: async (id: number) => {
        const g = groups.get(id);
        if (!g) throw new Error('no group');
        return { ...g };
      },
      update: async (id: number, props: { title?: string; color?: string }) => {
        Object.assign(groups.get(id)!, props);
        return { ...groups.get(id)! };
      },
    },
  };
}

let agents: typeof import('../extension/src/background/tools/agents');
const tab = (id: number): Tab => {
  const t = { id, windowId: 1, groupId: -1, url: `https://example.com/${id}` };
  tabs.set(id, t);
  return t;
};
const titleOf = (tabId: number) => groups.get(tabs.get(tabId)!.groupId)?.title;
const adopt = (agent: string, t: Tab) => agents.withClaimLock(() => agents.adopt(agent, t as chrome.tabs.Tab, true));

beforeAll(async () => {
  installChrome();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
  agents = await import('../extension/src/background/tools/agents');
});
afterAll(() => vi.useRealTimers());
beforeEach(() => vi.advanceTimersByTime(agents.LEASE_MS * 10)); // every test starts with all earlier agents expired

describe('tab ownership between agents', () => {
  it('refuses another agent\'s tab while its owner is active, then releases it after the lease', async () => {
    await agents.touch('local:claude-code/shop#a');
    const t = tab(1);
    await adopt('local:claude-code/shop#a', t);
    await agents.touch('local:claude-code/shop#b');

    expect(() => agents.assertNotHeld('local:claude-code/shop#b', 1)).toThrow(/belongs to another agent \(tab group "shop"\)/);
    await expect(adopt('local:claude-code/shop#b', t)).rejects.toThrow(/belongs to another agent/);
    expect(agents.ownerOf(1)).toBe('local:claude-code/shop#a');
    expect(() => agents.assertNotHeld('local:claude-code/shop#a', 1)).not.toThrow();

    // Owner a keeps working for most of the lease: still refused.
    vi.advanceTimersByTime(agents.LEASE_MS - 60_000);
    await agents.touch('local:claude-code/shop#a');
    vi.advanceTimersByTime(agents.LEASE_MS - 60_000);
    expect(() => agents.assertNotHeld('local:claude-code/shop#b', 1)).toThrow(/1 more minute\b/);

    // Silent past the lease (its session ended): b may take the tab, which moves into b's group.
    vi.advanceTimersByTime(120_000);
    await agents.touch('local:claude-code/shop#b');
    expect(agents.ownerOf(1)).toBeUndefined();
    await adopt('local:claude-code/shop#b', t);
    expect(agents.ownerOf(1)).toBe('local:claude-code/shop#b');
    expect(agents.defaultTabOf('local:claude-code/shop#b')).toBe(1);
    expect(agents.defaultTabOf('local:claude-code/shop#a')).toBeUndefined();
    expect(titleOf(1)).toBe('shop');
  });

  it('keeps an agent waiting on a long call (the user\'s help) holding its tab past the lease', async () => {
    const a = 'local:claude-code/login#a';
    const end = await agents.beginCall(a);
    await adopt(a, tab(20));
    await agents.touch('local:claude-code/login#b');
    vi.advanceTimersByTime(agents.LEASE_MS * 2); // the user takes 20 minutes to log in
    expect(() => agents.assertNotHeld('local:claude-code/login#b', 20)).toThrow(/belongs to another agent/);
    end();
    vi.advanceTimersByTime(agents.LEASE_MS - 60_000); // still held for a lease after the call ends
    expect(() => agents.assertNotHeld('local:claude-code/login#b', 20)).toThrow(/belongs to another agent/);
    vi.advanceTimersByTime(120_000);
    expect(agents.ownerOf(20)).toBeUndefined();
  });

  it('remembers an active agent across a service-worker restart, even with calls seconds apart', async () => {
    const a = 'local:claude-code/busy#a';
    await adopt(a, tab(30));
    // Thirty minutes of calls 5 seconds apart, then Chrome restarts the service worker.
    for (let i = 0; i < 360; i++) {
      vi.advanceTimersByTime(5_000);
      (await agents.beginCall(a))();
    }
    vi.resetModules();
    agents = await import('../extension/src/background/tools/agents');
    await agents.agentsReady;
    expect(agents.ownerOf(30)).toBe(a);
    expect(() => agents.assertNotHeld('local:claude-code/busy#b', 30)).toThrow(/belongs to another agent/);
  });

  it('titles groups by folder with a suffix for a second live session, and by the name an agent picks', async () => {
    const first = 'local:claude-code/sbb-dev#1';
    const second = 'local:claude-code/sbb-dev#2';
    await agents.touch(first);
    await agents.touch(second);
    expect(agents.nameOf(first)).toBe('sbb-dev');
    expect(agents.nameOf(second)).toBe('sbb-dev·2');
    await adopt(first, tab(10));
    await adopt(second, tab(11));
    expect(titleOf(10)).toBe('sbb-dev');
    expect(titleOf(11)).toBe('sbb-dev·2');
    expect(groups.get(tabs.get(10)!.groupId)!.color).not.toBe(groups.get(tabs.get(11)!.groupId)!.color);

    // An agent naming itself retitles its existing group; a name in use by a live agent gets a suffix.
    expect(await agents.rename(second, 'Checkout bug')).toBe('Checkout bug');
    expect(titleOf(11)).toBe('Checkout bug');
    expect(await agents.rename(first, '  Checkout   bug ')).toBe('Checkout bug·2');
    expect(titleOf(10)).toBe('Checkout bug·2');
    await expect(agents.rename(first, '   ')).rejects.toThrow(/visible text/);

    // Once the other agent's lease runs out, a newcomer may reuse its title.
    vi.advanceTimersByTime(agents.LEASE_MS + 1);
    await agents.touch('local:claude-code/sbb-dev#3');
    expect(agents.nameOf('local:claude-code/sbb-dev#3')).toBe('sbb-dev');
  });
});
