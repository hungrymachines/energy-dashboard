import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel, viewFromHash } from '../src/panel/hungry-machines-panel.js';
import { authStore } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const USER = {
  user_id: 'u1',
  email: 'jane@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
  weather_entity_id: '',
};

function tabs(el: PanelEl): HTMLButtonElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('nav.tabs button[role="tab"]'));
}

async function mount(): Promise<PanelEl> {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('panel tabs and URL hash', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    window.location.hash = '';
    authStore.state = { access: 'a', refresh: 'r', user: USER as never, status: 'authed', error: null };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    clearTokens();
    window.location.hash = '';
  });

  it('reads the hash, with unknown or empty falling back to dashboard', () => {
    expect(viewFromHash('#health')).toBe('health');
    expect(viewFromHash('#building')).toBe('building');
    expect(viewFromHash('#settings')).toBe('settings');
    expect(viewFromHash('')).toBe('dashboard');
    expect(viewFromHash('#nope')).toBe('dashboard');
  });

  it('fits four tabs on a phone: the narrow rule follows the base button rule', () => {
    const css = (HungryMachinesPanel.styles as { cssText: string }).cssText;
    const base = css.indexOf('nav.tabs button {');
    const narrow = css.indexOf('@media (max-width: 600px)');
    expect(base).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(base);
    expect(css.slice(narrow, narrow + 300)).toContain('min-width: 0');
    // Not a scroll box: the buttons' -1px margin would give it a 1px scroll.
    expect(css).not.toMatch(/nav\.tabs \{[^}]*overflow/);
  });

  it('renders four tabs in order', async () => {
    const el = await mount();
    expect(tabs(el).map((b) => b.textContent!.trim())).toEqual([
      'Dashboard',
      'Connection Health',
      'Building Info',
      'Settings',
    ]);
    expect(tabs(el)[0].getAttribute('aria-selected')).toBe('true');
  });

  it('opens on the tab named in the hash', async () => {
    window.location.hash = '#building';
    const el = await mount();
    expect(tabs(el)[2].getAttribute('aria-selected')).toBe('true');
    expect(el.shadowRoot!.querySelector('[data-view="building"]')).not.toBeNull();
  });

  it('writes the hash when a tab is clicked', async () => {
    const el = await mount();
    tabs(el)[1].click();
    await el.updateComplete;
    expect(window.location.hash).toBe('#health');
    expect(el.shadowRoot!.querySelector('[data-view="health"]')).not.toBeNull();
  });

  it('switches tabs on hashchange', async () => {
    const el = await mount();
    window.location.hash = '#settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await el.updateComplete;
    expect(tabs(el)[3].getAttribute('aria-selected')).toBe('true');
  });
});
