// Full access: Chrome's own permission prompts (the bubble by the address bar: "download multiple
// files", "see your clipboard", "know your location", notifications, camera, microphone) are answered by Helmsman for the sites agents work on, so a task never waits on one.
//
// Only sites an agent opens are touched (when its tab commits a page), and only settings still on
// "ask": a choice the user made for a site stays as it is. What a task may need is allowed;
// notifications, camera and microphone, which no task needs, are blocked so they cannot nag later.

import { ownerOf } from './tools/agents';

type Setting = 'allow' | 'block';
type ContentSettingName = 'automaticDownloads' | 'clipboard' | 'location' | 'notifications' | 'camera' | 'microphone';

export const AUTO_ANSWERS: Record<ContentSettingName, Setting> = {
  automaticDownloads: 'allow',
  clipboard: 'allow',
  location: 'allow',
  notifications: 'block',
  camera: 'block',
  microphone: 'block',
};

/** The content-settings pattern for a page's site (scheme, host and port), or undefined for non-web pages. */
export function sitePattern(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}/*`;
}

/** Sites already handled since the service worker started (settings persist, so once is enough). */
const done = new Set<string>();

/** Answers Chrome's permission prompts for the site of `url` (see the file comment). Never throws. */
export async function answerSitePermissionPrompts(url: string): Promise<void> {
  const pattern = sitePattern(url);
  if (!pattern || done.has(pattern) || !chrome.contentSettings) return;
  done.add(pattern);
  await Promise.all(
    (Object.entries(AUTO_ANSWERS) as Array<[ContentSettingName, Setting]>).map(async ([name, setting]) => {
      const api = chrome.contentSettings[name] as chrome.contentSettings.ContentSetting<string> | undefined;
      if (!api) return;
      try {
        const current = await api.get({ primaryUrl: url });
        if (current.setting === 'ask') await api.set({ primaryPattern: pattern, setting });
      } catch {
        /* a setting this Chrome does not support for that site */
      }
    }),
  );
}

// Each page an agent's tab commits to gets its site handled before the page asks for anything.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0 && ownerOf(d.tabId)) void answerSitePermissionPrompts(d.url);
});
