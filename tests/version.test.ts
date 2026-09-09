import { describe, it, expect, afterEach } from 'vitest';
import {
  parseVersionFromScriptUrl,
  getIntegrationVersion,
} from '../src/utils/version.js';

describe('parseVersionFromScriptUrl', () => {
  it('reads the cache-buster HA appends to the bundle URL', () => {
    expect(
      parseVersionFromScriptUrl('/hungry_machines/hungry-machines.js?v=3.6.0'),
    ).toBe('3.6.0');
  });

  it('finds v among other query params', () => {
    expect(parseVersionFromScriptUrl('/x.js?a=1&v=3.6.0&b=2')).toBe('3.6.0');
  });

  it('returns null for a URL with no version, an empty one, or no URL', () => {
    expect(parseVersionFromScriptUrl('/hungry_machines/hungry-machines.js')).toBeNull();
    expect(parseVersionFromScriptUrl('/hungry_machines/hungry-machines.js?v=')).toBeNull();
    expect(parseVersionFromScriptUrl(null)).toBeNull();
  });
});

describe('getIntegrationVersion', () => {
  afterEach(() => {
    document
      .querySelectorAll('script[src*="hungry-machines.js"]')
      .forEach((n) => n.remove());
  });

  it('reads the version off the tag HA writes for the bundle', () => {
    const tag = document.createElement('script');
    tag.setAttribute('src', '/hungry_machines/hungry-machines.js?v=3.6.0');
    document.head.appendChild(tag);

    expect(getIntegrationVersion()).toBe('3.6.0');
  });

  it('returns null when the bundle tag is absent', () => {
    expect(getIntegrationVersion()).toBeNull();
  });
});
