// End-to-end: closing a tab whose page asks "Leave site?" must not hang the agent or the
// claim lock that every agent's tab choice goes through.

import { expect, test } from '@playwright/test';
import { call, refOf, SITE_A, startHarness, stopHarness, tabIdOf, type Harness } from './support/harness';

let h: Harness;
const A = 'agent-leave-a';
const B = 'agent-leave-b';

test.beforeAll(async () => {
  h = await startHarness();
});

test.afterAll(async () => {
  await stopHarness(h);
});

test('closing a tab with a beforeunload handler closes it and leaves every agent usable', async () => {
  const opened = await call('browser_tabs', { action: 'new', url: `${SITE_A}/leave.html` }, A);
  expect(opened.isError, opened.text).toBeFalsy();
  const tabId = tabIdOf(opened.text);
  // A click gives the page the user activation Chrome requires before it shows "Leave site?".
  const snap = await call('browser_snapshot', { tabId }, A);
  const clicked = await call('browser_click', { ref: refOf(snap.text, 'Sửa'), tabId }, A);
  expect(clicked.isError, clicked.text).toBeFalsy();

  const started = Date.now();
  const closed = await call('browser_tabs', { action: 'close', tabId }, A);
  expect(closed.isError, closed.text).toBeFalsy();
  expect(Date.now() - started).toBeLessThan(15_000);
  const exists = await h.sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tabId);
  expect(exists).toBe(false);

  // Neither the same agent's lane nor the shared claim lock is left stuck.
  const list = await call('browser_tabs', { action: 'list' }, A);
  expect(list.isError, list.text).toBeFalsy();
  expect(list.text).not.toContain(`[${tabId}]`);
  const other = await call('browser_tabs', { action: 'new', url: `${SITE_A}/index.html` }, B);
  expect(other.isError, other.text).toBeFalsy();
});
