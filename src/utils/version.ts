/**
 * Which build of the integration is the user running?
 *
 * `custom_components/hungry_machines/__init__.py` registers the bundle
 * with HA as `/hungry_machines/hungry-machines.js?v=<manifest version>`
 * — a cache-buster, so browsers refetch after an upgrade — and HA's
 * frontend writes that URL verbatim into a `<script type="module">` tag.
 * The version is therefore already in the document; reading it back off
 * the tag beats baking a constant into the bundle at build time, which
 * would be one more thing to keep in step with manifest.json.
 *
 * Returns null when there's no such tag (a card loaded outside the HA
 * panel, or a unit test that hasn't planted one). Callers render '—'.
 */

const SCRIPT_PATH = '/hungry_machines/hungry-machines.js';

/** Pull `v` out of a script `src`. Exported for the tests. */
export function parseVersionFromScriptUrl(
  src: string | null | undefined,
): string | null {
  if (!src) return null;
  const match = /[?&]v=([^&]*)/.exec(src);
  if (!match) return null;
  const value = decodeURIComponent(match[1]).trim();
  return value || null;
}

export function getIntegrationVersion(): string | null {
  if (typeof document === 'undefined') return null;
  const tags = document.querySelectorAll(`script[src*="${SCRIPT_PATH}"]`);
  for (const tag of Array.from(tags)) {
    const version = parseVersionFromScriptUrl(tag.getAttribute('src'));
    if (version) return version;
  }
  return null;
}
