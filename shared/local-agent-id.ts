// The agent id a local MCP server process reports with every call:
// `local:<client>/<working folder>#<process instance>`, e.g. `local:claude-code/sbb-dev#1a2b3c4d`.
// The extension reads the folder as the agent's starting group title (see agentLabel) and the
// instance keeps two sessions of the same client in the same folder apart. Pure: no Node APIs.

/** Characters the id format uses as separators, plus whitespace. */
const SEPARATORS = /[\s/\\#:]+/g;

const part = (s: string) => s.replace(SEPARATORS, '-').replace(/^-+|-+$/g, '');

export function localAgentId(client: string, cwd: string, home: string, instance: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '');
  // Apps started from the dock run in "/" or the home folder: no project there, so no folder label.
  const isProject = trimmed !== '' && trimmed !== home.replace(/[/\\]+$/, '');
  const folder = isProject ? part(trimmed.split(/[/\\]/).pop() ?? '') : '';
  return `local:${part(client) || 'local'}${folder ? `/${folder}` : ''}#${instance}`;
}
