import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}

type PanelEl = HungryMachinesPanel & { updateComplete: Promise<boolean> };

const SAMPLE_USER = {
  user_id: 'user-123',
  email: 'jane@example.com',
  location_zip: '94107',
  home_size_sqft: 1800,
  pricing_location: 3,
  timezone: 'America/Los_Angeles',
  subscription_tier: 'free',
};

function setAuthState(partial: Partial<AuthState>): void {
  authStore.state = {
    access: null,
    refresh: null,
    user: null,
    status: 'unauthed',
    error: null,
    ...partial,
  };
}

function mountPanel(): PanelEl {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  document.body.appendChild(el);
  return el;
}

function findButtonByText(
  root: ShadowRoot,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  );
}

describe('hungry-machines-panel', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setAuthState({});
    // Prevent hydrate() from clobbering the state we force in each test.
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    // Stub fetch so the dashboard's /schedules + /rates calls don't hit the
    // real network (US-FE-07 triggers these on mount when authed).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    clearTokens();
    setAuthState({});
  });

  it('renders the login form and no app header when unauthed', async () => {
    setAuthState({ status: 'unauthed' });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelector('hm-login-form')).not.toBeNull();
    expect(root.querySelector('header.app-header')).toBeNull();
    expect(root.querySelector('footer.app-footer')).toBeNull();
  });

  it('renders the authenticated layout with the user email and a Sign out button', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;

    const header = root.querySelector('header.app-header');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('Hungry Machines');

    const tabs = root.querySelectorAll<HTMLButtonElement>('nav.tabs button');
    expect(tabs.length).toBe(2);
    expect(tabs[0]!.textContent?.trim()).toBe('Dashboard');
    expect(tabs[1]!.textContent?.trim()).toBe('Settings');

    const footer = root.querySelector('footer.app-footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('jane@example.com');

    const signOutBtn = findButtonByText(root, 'Sign out');
    expect(signOutBtn).toBeDefined();

    // No login form rendered in authed state.
    expect(root.querySelector('hm-login-form')).toBeNull();
  });

  it('clicking Sign out invokes authStore.logout', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const logoutSpy = vi.spyOn(authStore, 'logout').mockImplementation(() => {
      /* prevent side effects */
    });

    const signOutBtn = findButtonByText(el.shadowRoot!, 'Sign out');
    expect(signOutBtn).toBeDefined();
    signOutBtn!.click();

    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('switches the content section when the Settings tab is clicked', async () => {
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: SAMPLE_USER,
    });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    const content = root.querySelector('section.content')!;
    expect(content.textContent).toContain('Dashboard');

    const settingsTab = Array.from(
      root.querySelectorAll<HTMLButtonElement>('nav.tabs button'),
    ).find((b) => b.textContent?.trim() === 'Settings');
    expect(settingsTab).toBeDefined();
    settingsTab!.click();
    await el.updateComplete;

    const updated = root.querySelector('section.content')!;
    expect(updated.textContent).toContain('Settings');
  });

  it('shows a loading spinner when the auth store reports loading', async () => {
    setAuthState({ status: 'loading' });
    const el = mountPanel();
    await el.updateComplete;

    const root = el.shadowRoot!;
    expect(root.querySelector('.spinner')).not.toBeNull();
    expect(root.querySelector('hm-login-form')).toBeNull();
    expect(root.querySelector('header.app-header')).toBeNull();
  });
});
