// browser_tabs: list, open, select and close tabs. Every agent works in its own tab group.

import { attach, send, sessionOf } from '../cdp';
import { assertNotHeld, defaultTabOf, nameOf, ownerLabel, rename, withClaimLock } from './agents';
import { claimTab, openAgentTab, pageHeader, waitForLoad } from './tab';
import { freeTool, text, ToolError, TrustedError } from './types';

async function bringToFront(tab: chrome.tabs.Tab) {
  await chrome.tabs.update(tab.id!, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/** True when `p` settles within `ms` (its error is rethrown), false when it is still pending. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  const settled = p.then(() => true);
  settled.catch(() => {}); // a rejection after the wait ended is not an unhandled one
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

const CLOSE_WAIT_MS = 4000;

/**
 * Closes a tab without hanging. A page with a beforeunload handler makes Chrome ask "Leave site?" and
 * chrome.tabs.remove waits for that answer, possibly forever; a frozen page never answers at all.
 * Closing was asked for, so a "Leave site?" dialog is accepted; anything else ends in a clear error.
 */
async function closeTab(tabId: number): Promise<void> {
  const removed = chrome.tabs.remove(tabId);
  if (await settlesWithin(removed, 1000)) return;
  // Still open: look for the dialog (attaching enables the Page domain that reports it).
  await settlesWithin(attach(tabId), 3000).catch(() => false);
  if (sessionOf(tabId)?.dialog) await settlesWithin(send(tabId, 'Page.handleJavaScriptDialog', { accept: true }), 2000).catch(() => false);
  if (await settlesWithin(removed, CLOSE_WAIT_MS)) return;
  const dialog = sessionOf(tabId)?.dialog;
  // The dialog text comes from the page, so that error is not a trusted one.
  if (dialog) throw new ToolError(`Tab ${tabId} did not close: it shows a ${dialog.type} dialog ("${dialog.message}"). Answer it with browser_handle_dialog, then close the tab again.`);
  throw new TrustedError(`Tab ${tabId} did not close: the page is not responding. Check it with browser_tabs "list"; Chrome may close it later on its own.`);
}

async function groupTitles(): Promise<Map<number, string>> {
  const groups = chrome.tabGroups ? await chrome.tabGroups.query({}).catch(() => []) : [];
  return new Map(groups.map((g) => [g.id, g.title ?? '']));
}

export const tabsTools = {
  browser_tabs: freeTool(async (args, ctx) => {
    const action = args.action as string;
    // A name may come with any action, so an agent can name its group on its very first call. An empty
    // name only matters for "rename": models often send "" or null for optional fields.
    const hasName = typeof args.name === 'string' && args.name.trim() !== '';
    const named = hasName || action === 'rename' ? await rename(ctx.agent, args.name) : undefined;
    const namedNote = named ? `Your tab group is named "${named}".\n\n` : '';
    if (action === 'rename') {
      if (!named) throw new ToolError('name is required for "rename".');
      return text(namedNote.trim());
    }
    if (action === 'new') {
      const tab = await withClaimLock(() => openAgentTab(ctx.agent, args.url || 'about:blank'));
      if (args.activate) await bringToFront(tab);
      if (args.url) await waitForLoad(tab.id!, 30_000);
      return text(`${namedNote}Opened tab ${tab.id}${args.url ? ` at ${args.url}` : ''} in your tab group. It is now your default tab.\n\n${await pageHeader(tab)}`);
    }
    if (action === 'select') {
      if (args.tabId === undefined) throw new ToolError('tabId is required for "select".');
      const tab = await withClaimLock(() => claimTab(ctx.agent, args.tabId, true));
      if (args.activate) await bringToFront(tab);
      return text(`${namedNote}Tab ${args.tabId} is now your default tab.\n\n${await pageHeader(tab)}`);
    }
    if (action === 'close') {
      if (args.tabId === undefined) throw new ToolError('tabId is required for "close".');
      // Checked and closed under the claim lock, so the tab cannot change hands in between.
      await withClaimLock(async () => {
        assertNotHeld(ctx.agent, args.tabId);
        await closeTab(args.tabId);
      });
      return text(`Closed tab ${args.tabId}.`);
    }
    const mine = defaultTabOf(ctx.agent);
    const titles = await groupTitles();
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const lines: string[] = [`${namedNote}Your tab group: "${nameOf(ctx.agent)}". Tabs "used by" another agent are refused while it is working; use your own.`];
    for (const w of windows) {
      lines.push(`Window ${w.id}${w.focused ? ' (focused)' : ''}:`);
      for (const t of w.tabs ?? []) {
        const owner = ownerLabel(t.id!);
        const group = t.groupId !== -1 ? titles.get(t.groupId) : undefined;
        const flags = [
          t.active && 'active',
          t.id === mine && 'YOUR DEFAULT TAB',
          owner && t.id !== mine && `used by ${owner}`,
          group && `group "${group}"`,
          t.audible && 'playing audio',
          t.discarded && 'sleeping',
        ].filter(Boolean).join(', ');
        lines.push(`  - [${t.id}] ${t.title ?? ''} — ${t.url ?? ''}${flags ? ` (${flags})` : ''}`);
      }
    }
    return text(`${lines.join('\n')}\n\nPass tabId to any tool to work in a specific tab; calls on different tabs run in parallel. Use action "new" to open a tab of your own.`);
  }),
};
