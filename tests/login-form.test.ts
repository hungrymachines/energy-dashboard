import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HmLoginForm } from '../src/ui/login-form.js';
import { authStore } from '../src/store.js';
import { clearTokens, setApiBase } from '../src/api/client.js';

if (!customElements.get('hm-login-form')) {
  customElements.define('hm-login-form', HmLoginForm);
}

type FormEl = HmLoginForm & { updateComplete: Promise<boolean> };

function mountForm(): FormEl {
  const el = document.createElement('hm-login-form') as FormEl;
  document.body.appendChild(el);
  return el;
}

function resetStoreState(): void {
  authStore.state = {
    access: null,
    refresh: null,
    user: null,
    status: 'unauthed',
    error: null,
  };
}

function setInput(root: ShadowRoot, name: string, value: string): void {
  const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!el) throw new Error(`input[name="${name}"] not found`);
  el.value = value;
}

function submitForm(root: ShadowRoot): void {
  const form = root.querySelector('form');
  if (!form) throw new Error('form not found');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('hm-login-form', () => {
  beforeEach(() => {
    setApiBase('https://api.example.test');
    clearTokens();
    resetStoreState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    clearTokens();
    resetStoreState();
  });

  it('renders email and password inputs on the Sign In tab by default', async () => {
    const el = mountForm();
    await el.updateComplete;

    const root = el.shadowRoot!;
    const email = root.querySelector<HTMLInputElement>('input[name="email"]');
    const password = root.querySelector<HTMLInputElement>(
      'input[name="password"]',
    );

    expect(email).not.toBeNull();
    expect(email!.type).toBe('email');
    expect(password).not.toBeNull();
    expect(password!.type).toBe('password');

    // Sign-up-only fields should NOT be present on the sign-in tab.
    expect(root.querySelector('input[name="location_zip"]')).toBeNull();
    expect(root.querySelector('select[name="pricing_location"]')).toBeNull();
  });

  it('switching to Sign Up tab reveals the signup-only fields', async () => {
    const el = mountForm();
    await el.updateComplete;

    const root = el.shadowRoot!;
    const tabs = root.querySelectorAll<HTMLButtonElement>('button.tab');
    expect(tabs.length).toBe(2);
    const signupTab = tabs[1]!;
    signupTab.click();
    await el.updateComplete;

    expect(root.querySelector('input[name="location_zip"]')).not.toBeNull();
    expect(root.querySelector('input[name="home_size_sqft"]')).not.toBeNull();
    const zone = root.querySelector<HTMLSelectElement>(
      'select[name="pricing_location"]',
    );
    expect(zone).not.toBeNull();
    // 8 zones per the acceptance criteria.
    expect(zone!.querySelectorAll('option').length).toBe(8);
  });

  it('submitting the Sign In tab calls authStore.login with the entered credentials', async () => {
    const loginSpy = vi
      .spyOn(authStore, 'login')
      .mockImplementation(async () => {
        /* noop — prevent real fetch */
      });

    const el = mountForm();
    await el.updateComplete;

    const root = el.shadowRoot!;
    setInput(root, 'email', 'user@example.com');
    setInput(root, 'password', 'hunter2');

    submitForm(root);
    // Give the async handler a microtask to run.
    await Promise.resolve();
    await el.updateComplete;

    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(loginSpy).toHaveBeenCalledWith('user@example.com', 'hunter2');
  });

  it('renders the error text when the auth store surfaces an error', async () => {
    authStore.state = {
      access: null,
      refresh: null,
      user: null,
      status: 'unauthed',
      error: 'Invalid login credentials',
    };

    const el = mountForm();
    await el.updateComplete;

    const errorEl = el.shadowRoot!.querySelector('.error');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain('Invalid login credentials');
  });

  it('disables the submit button while the store reports a loading status', async () => {
    authStore.state = {
      access: null,
      refresh: null,
      user: null,
      status: 'loading',
      error: null,
    };

    const el = mountForm();
    await el.updateComplete;

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button.submit',
    );
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    expect(el.shadowRoot!.querySelector('.spinner')).not.toBeNull();
  });
});
