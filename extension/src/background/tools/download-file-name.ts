// File names for what Helmsman saves into the Downloads folder (screenshots, PDFs). Pure.

/**
 * A path relative to Downloads that chrome.downloads accepts: subfolders are kept ("jira/ABC-1.jpg"),
 * while "..", empty parts and characters invalid in file names are dropped or replaced, and the file
 * always ends in `ext` (an existing other extension is replaced, so the name matches the content).
 */
export function downloadFileName(name: unknown, fallback: string, ext: string): string {
  const parts = String(name ?? '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f:*?"<>|]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  let file = parts.pop() ?? '';
  file = file.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/^\.+/, '') || fallback;
  return [...parts, `${file}${ext}`].join('/');
}
