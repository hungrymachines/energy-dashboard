import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HungryMachinesPanel } from '../src/panel/hungry-machines-panel.js';
import { HmLoginForm } from '../src/ui/login-form.js';
import { HmConstraintEditor } from '../src/ui/constraint-editor.js';
import { HmScheduleChart } from '../src/ui/schedule-chart.js';
import { authStore, type AuthState } from '../src/store.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}
if (!customElements.get('hm-schedule-chart')) {
  customElements.define('hm-schedule-chart', HmScheduleChart);
}
if (!customElements.get('hm-constraint-editor')) {
  customElements.define('hm-constraint-editor', HmConstraintEditor);
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
  weather_entity_id: '',
};

function ratesResponse(): unknown {
  return {
    pricing_location: 3,
    intervals: Array.from({ length: 48 }, (_, i) => i),
    rates_cents_per_kwh: Array.from({ length: 48 }, () => 30),
    unit: 'cents/kWh',
    source: 'zone',
    hourly_rates_cents_per_kwh: null,
    pricing_source: 'zone',
    dynamic_zone: null,
    pricing_adder_cents_per_kwh: null,
    available_dynamic_zones: [],
    available_pricing_zones: [],
  };
}

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

function mountPanel(init: Partial<HungryMachinesPanel> = {}): PanelEl {
  const el = document.createElement('hungry-machines-panel') as PanelEl;
  Object.assign(el, init);
  document.body.appendChild(el);
  return el;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: PanelEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function clickSettings(root: ShadowRoot): void {
  const settings = Array.from(
    root.querySelectorAll<HTMLButtonElement>('nav.tabs button'),
  ).find((b) => b.textContent?.trim() === 'Settings');
  if (!settings) throw new Error('Settings tab not found');
  settings.click();
}

function feedbackSection(root: ShadowRoot): Element {
  const section = Array.from(root.querySelectorAll('.settings-section')).find(
    (s) => s.querySelector('h3')?.textContent?.includes('Send feedback'),
  );
  if (!section) throw new Error('feedback section not found');
  return section;
}

describe('hungry-machines-panel feedback form', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    localStorage.clear();
    clearTokens();
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
    setAuthState({
      access: 'ACCESS',
      refresh: 'REFRESH',
      status: 'authed',
      user: { ...SAMPLE_USER },
    });
    vi.spyOn(authStore, 'hydrate').mockImplementation(async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        if (url.includes('/api/v1/rates')) return jsonResponse(ratesResponse());
        return jsonResponse(null);
      }),
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

  it('renders a feedback section with category select, message textarea, and send button', async () => {
    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const section = feedbackSection(el.shadowRoot!);
    const categories = Array.from(
      section.querySelectorAll<HTMLOptionElement>('select[name="feedback_category"] option'),
    ).map((o) => o.value);
    expect(categories).toEqual(['comment', 'bug', 'idea', 'other']);
    expect(section.querySelector('textarea[name="feedback_message"]')).not.toBeNull();
    expect(section.querySelector('button[name="send_feedback"]')).not.toBeNull();
  });

  it('send button is disabled until a message is typed', async () => {
    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const btn = root.querySelector<HTMLButtonElement>('button[name="send_feedback"]')!;
    expect(btn.disabled).toBe(true);

    const ta = root.querySelector<HTMLTextAreaElement>('textarea[name="feedback_message"]')!;
    ta.value = 'It works great';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    expect(btn.disabled).toBe(false);
  });

  it('submitting POSTs the message + category to /api/v1/feedback and clears the form', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      calls.push({ url, init });
      if (url.includes('/api/v1/feedback')) return jsonResponse({ stored: true }, 201);
      if (url.includes('/api/v1/rates')) return jsonResponse(ratesResponse());
      return jsonResponse(null);
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const sel = root.querySelector<HTMLSelectElement>('select[name="feedback_category"]')!;
    sel.value = 'bug';
    sel.dispatchEvent(new Event('change', { bubbles: true }));

    const ta = root.querySelector<HTMLTextAreaElement>('textarea[name="feedback_message"]')!;
    ta.value = 'The schedule chart did not refresh.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    root.querySelector<HTMLButtonElement>('button[name="send_feedback"]')!.click();
    await flush(el);

    const post = calls.find((c) => c.url.includes('/api/v1/feedback') && c.init?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init!.body as string)).toEqual({
      message: 'The schedule chart did not refresh.',
      category: 'bug',
    });

    // Form cleared + confirmation shown.
    expect(ta.value).toBe('');
    const flash = root.querySelector<HTMLElement>('button[name="send_feedback"]')!
      .parentElement!.querySelector('.saved-flash')!;
    expect(flash.hasAttribute('hidden')).toBe(false);
  });

  it('surfaces an API error without clearing the message', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/v1/feedback')) {
        return jsonResponse({ detail: 'Database unavailable' }, 503);
      }
      if (url.includes('/api/v1/rates')) return jsonResponse(ratesResponse());
      return jsonResponse(null);
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountPanel();
    await flush(el);
    clickSettings(el.shadowRoot!);
    await flush(el);

    const root = el.shadowRoot!;
    const ta = root.querySelector<HTMLTextAreaElement>('textarea[name="feedback_message"]')!;
    ta.value = 'something';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    root.querySelector<HTMLButtonElement>('button[name="send_feedback"]')!.click();
    await flush(el);

    const err = feedbackSection(root).querySelector<HTMLElement>('.zone-error[role="alert"]')!;
    expect(err.hasAttribute('hidden')).toBe(false);
    expect(err.textContent).toContain('Database unavailable');
    // Message preserved so the user can retry.
    expect(ta.value).toBe('something');
  });
});
