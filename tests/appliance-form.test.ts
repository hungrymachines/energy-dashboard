import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmApplianceForm } from '../src/ui/appliance-form.js';
import { clearTokens, setApiBase, setTokens } from '../src/api/client.js';

if (!customElements.get('hm-appliance-form')) {
  customElements.define('hm-appliance-form', HmApplianceForm);
}

type FormEl = HmApplianceForm & { updateComplete: Promise<boolean> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(el: FormEl): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function mountForm(): FormEl {
  const el = document.createElement('hm-appliance-form') as FormEl;
  el.open = true;
  document.body.appendChild(el);
  return el;
}

function buttonByText(root: ShadowRoot, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  );
}

function buttonByDataType(root: ShadowRoot, t: string): HTMLButtonElement | undefined {
  return root.querySelector<HTMLButtonElement>(`button[data-type="${t}"]`) ?? undefined;
}

function inputByName(root: ShadowRoot, name: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!el) throw new Error(`input[name="${name}"] not found`);
  return el;
}

describe('hm-appliance-form', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    setTokens({ access: 'ACCESS', refresh: 'REFRESH' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    clearTokens();
  });

  it('initial render shows step 1 with four type buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    const root = el.shadowRoot!;
    const typeButtons = root.querySelectorAll<HTMLButtonElement>('button.type-btn');
    expect(typeButtons.length).toBe(4);
    const types = Array.from(typeButtons).map((b) => b.dataset.type);
    expect(types.sort()).toEqual(['ev_charger', 'home_battery', 'hvac', 'water_heater']);
  });

  it("clicking 'HVAC' advances to step 2 with HVAC-specific fields", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    expect(root.querySelector('select[name="hvac_type"]')).not.toBeNull();
    expect(root.querySelector('input[name="home_size_sqft"]')).not.toBeNull();
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    // Step 1 type buttons no longer rendered.
    expect(root.querySelectorAll('button.type-btn').length).toBe(0);
  });

  it('submit with empty name does NOT call fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'a-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    // Fill HVAC but leave name empty.
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.disabled).toBe(true);
    submitBtn!.click();
    await flush(el);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('successful submit posts to /api/v1/appliances and dispatches appliance-created', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return jsonResponse({ appliance_id: 'app-123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    let createdEvent: CustomEvent | null = null;
    el.addEventListener('appliance-created', ((e: Event) => {
      createdEvent = e as CustomEvent;
    }) as EventListener);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'My HVAC';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    const hvacType = root.querySelector<HTMLSelectElement>('select[name="hvac_type"]')!;
    hvacType.value = 'heat_pump';
    hvacType.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(el);

    const submitBtn = buttonByText(root, 'Add');
    expect(submitBtn!.disabled).toBe(false);
    submitBtn!.click();
    await flush(el);

    const postCall = calls.find(
      (c) => c.url.endsWith('/api/v1/appliances') && c.init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall!.init!.body));
    expect(body.appliance_type).toBe('hvac');
    expect(body.name).toBe('My HVAC');
    expect(body.config).toMatchObject({
      hvac_type: 'heat_pump',
      home_size_sqft: 1800,
    });

    expect(createdEvent).not.toBeNull();
    expect(el.open).toBe(false);
  });

  it('failed submit (500) renders error message and leaves form open', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ detail: 'server is down' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    const root = el.shadowRoot!;
    const name = inputByName(root, 'name');
    name.value = 'My HVAC';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const homeSize = inputByName(root, 'home_size_sqft');
    homeSize.value = '1800';
    homeSize.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(el);

    buttonByText(root, 'Add')!.click();
    await flush(el);

    expect(el.open).toBe(true);
    const root2 = el.shadowRoot!;
    expect(root2.querySelector('.top-error')).not.toBeNull();
    expect(root2.querySelector('.top-error')!.textContent).toContain('server is down');
    // Inputs preserved
    expect(inputByName(root2, 'name').value).toBe('My HVAC');
  });

  it("clicking 'Cancel' on step 2 dispatches cancelled and the form resets to step 1", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null)));
    const el = mountForm();
    await flush(el);

    buttonByDataType(el.shadowRoot!, 'hvac')!.click();
    await flush(el);

    let cancelledFired = false;
    el.addEventListener('cancelled', () => {
      cancelledFired = true;
    });

    buttonByText(el.shadowRoot!, 'Cancel')!.click();
    await flush(el);

    expect(cancelledFired).toBe(true);
    expect(el.open).toBe(false);

    // Re-open the form: should be back to step 1 (type picker).
    el.open = true;
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelectorAll('button.type-btn').length).toBe(4);
    expect(root.querySelector('input[name="name"]')).toBeNull();
  });
});
