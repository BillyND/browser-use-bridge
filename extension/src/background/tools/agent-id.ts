// Human-facing identity of an agent: the short label and colour of its tab group.
// Pure functions so they can be unit tested.

export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const DEFAULT_AGENT = 'default';

/** Longest group title Helmsman sets; Chrome shows more but the tab strip gets crowded. */
export const LABEL_MAX = 24;

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim() || 'agent';

/**
 * The label an agent has until it names itself. Ids look like
 * `local:claude-code/sbb-dev#1a2b3c4d` (local server: client, working folder, process),
 * `local:claude-code` (older local servers), `ChatGPT#<client id>` (cloud gateway) or an
 * arbitrary string; the label is the part a person recognises: the folder when there is one.
 */
export function agentLabel(agent: string): string {
  if (agent === DEFAULT_AGENT) return 'AI';
  let rest = agent.startsWith('local:') ? agent.slice(6) : agent;
  const hash = rest.indexOf('#');
  if (hash > 0) rest = rest.slice(0, hash);
  const slash = rest.lastIndexOf('/');
  return clip(slash >= 0 && slash < rest.length - 1 ? rest.slice(slash + 1) : rest);
}

/**
 * Cleans a group name an agent chose for itself; empty when nothing usable is left. Other agents see
 * it in tab listings and refusals, so control characters, quotes and angle brackets are dropped.
 */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const s = name.replace(/[\u0000-\u001f\u007f"<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  // The "·N" suffix is Helmsman's, so a chosen name cannot fake one (checked after clipping too).
  return s ? clip(clip(s).replace(/·\d+$/, '')) : '';
}

/** `base`, or `base·2`, `base·3`… so the label differs from every label in `taken`. */
export function uniqueLabel(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `·${n}`;
    const label = `${base.slice(0, LABEL_MAX - suffix.length).trim()}${suffix}`;
    if (!taken.includes(label)) return label;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable colour per agent, skipping colours other agents already use while some remain free. */
export function pickColor(agent: string, taken: readonly string[]): GroupColor {
  const start = hash(agent) % GROUP_COLORS.length;
  for (let i = 0; i < GROUP_COLORS.length; i++) {
    const color = GROUP_COLORS[(start + i) % GROUP_COLORS.length];
    if (!taken.includes(color)) return color;
  }
  return GROUP_COLORS[start];
}
