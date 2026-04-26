import { LitElement, html, css, type PropertyValues } from 'lit';
import { authStore, type AuthState } from '../store.js';
import type { SignupBody } from '../api/auth.js';

type Tab = 'signin' | 'signup';

export class HmLoginForm extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--hm-font-body, sans-serif);
      color: var(--hm-text, #0F172A);
      max-width: 360px;
      width: 100%;
      box-sizing: border-box;
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--hm-muted, #64748B);
      margin-bottom: 16px;
    }
    .tab {
      flex: 1;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: var(--hm-muted, #64748B);
      font: inherit;
      cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    .tab[aria-selected='true'] {
      color: var(--hm-primary, #1E3A8A);
      border-bottom-color: var(--hm-primary, #1E3A8A);
      font-weight: 600;
    }
    h2 {
      font-family: var(--hm-font-heading, serif);
      color: var(--hm-primary, #1E3A8A);
      margin: 0 0 12px 0;
      font-size: 1.25rem;
    }
    label {
      display: block;
      margin-bottom: 12px;
      font-size: 14px;
    }
    .label-text {
      display: block;
      margin-bottom: 4px;
      color: var(--hm-text, #0F172A);
    }
    input,
    select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--hm-muted, #64748B);
      border-radius: 6px;
      font: inherit;
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-text, #0F172A);
      box-sizing: border-box;
    }
    input:focus,
    select:focus {
      outline: 2px solid var(--hm-primary, #1E3A8A);
      outline-offset: 1px;
    }
    button.submit {
      width: 100%;
      padding: 10px 12px;
      background: var(--hm-primary, #1E3A8A);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      margin-top: 4px;
    }
    button.submit[disabled] {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      margin-right: 8px;
      animation: hm-spin 0.6s linear infinite;
      vertical-align: -2px;
    }
    @keyframes hm-spin {
      to {
        transform: rotate(360deg);
      }
    }
    .error {
      background: var(--hm-bg, #F8FAFC);
      color: var(--hm-error, #DC2626);
      border: 1px solid var(--hm-error, #DC2626);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .forgot {
      margin-top: 10px;
      font-size: 13px;
    }
    a.link {
      color: var(--hm-secondary, #0F766E);
      text-decoration: none;
    }
    a.link:hover {
      text-decoration: underline;
    }
  `;

  static override properties = {
    _tab: { state: true },
    _pending: { state: true },
    _error: { state: true },
  };

  _tab: Tab = 'signin';
  _pending = false;
  _error: string | null = null;

  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._syncFromStore(authStore.state);
    this._unsubscribe = authStore.subscribe((s) => this._syncFromStore(s));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  override updated(_changed: PropertyValues): void {
    // no-op; reserved for future focus management
  }

  private _syncFromStore(s: AuthState): void {
    this._pending = s.status === 'loading';
    this._error = s.error;
  }

  private _selectTab(tab: Tab): void {
    this._tab = tab;
  }

  private _readInput(name: string): string {
    const root = this.shadowRoot;
    if (!root) return '';
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[name="${name}"]`,
    );
    return el ? el.value : '';
  }

  private _onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const email = this._readInput('email').trim();
    const password = this._readInput('password');
    if (!email || !password) return;

    if (this._tab === 'signin') {
      await authStore.login(email, password);
      return;
    }

    const body: SignupBody = { email, password };
    const zip = this._readInput('location_zip').trim();
    if (zip) body.location_zip = zip;
    const sizeRaw = this._readInput('home_size_sqft').trim();
    if (sizeRaw) {
      const n = Number(sizeRaw);
      if (Number.isFinite(n) && n > 0) body.home_size_sqft = Math.trunc(n);
    }
    const zoneRaw = this._readInput('pricing_location');
    if (zoneRaw) {
      const n = Number(zoneRaw);
      if (Number.isFinite(n)) body.pricing_location = n;
    }
    await authStore.signup(body);
  };

  override render() {
    const isSignin = this._tab === 'signin';
    return html`
      <section>
        <div class="tabs" role="tablist">
          <button
            class="tab"
            type="button"
            role="tab"
            aria-selected=${isSignin ? 'true' : 'false'}
            @click=${() => this._selectTab('signin')}
          >
            Sign In
          </button>
          <button
            class="tab"
            type="button"
            role="tab"
            aria-selected=${!isSignin ? 'true' : 'false'}
            @click=${() => this._selectTab('signup')}
          >
            Sign Up
          </button>
        </div>
        ${this._error
          ? html`<div class="error" role="alert">${this._error}</div>`
          : null}
        <form @submit=${this._onSubmit} novalidate>
          <h2>${isSignin ? 'Welcome back' : 'Create your account'}</h2>
          <label>
            <span class="label-text">Email</span>
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <label>
            <span class="label-text">Password</span>
            <input
              name="password"
              type="password"
              autocomplete=${isSignin ? 'current-password' : 'new-password'}
              required
            />
          </label>
          ${isSignin ? null : this._renderSignupFields()}
          <button class="submit" type="submit" ?disabled=${this._pending}>
            ${this._pending
              ? html`<span class="spinner" aria-hidden="true"></span>${isSignin
                    ? 'Signing in…'
                    : 'Creating account…'}`
              : isSignin
                ? 'Sign in'
                : 'Create account'}
          </button>
          ${isSignin
            ? html`<p class="forgot">
                <a
                  class="link"
                  href="https://hungrymachines.io/forgot-password"
                  target="_blank"
                  rel="noopener noreferrer"
                  >Forgot password?</a
                >
              </p>`
            : null}
        </form>
      </section>
    `;
  }

  private _renderSignupFields() {
    return html`
      <label>
        <span class="label-text">ZIP code (optional)</span>
        <input
          name="location_zip"
          type="text"
          inputmode="numeric"
          autocomplete="postal-code"
          pattern="\\d{5}"
          maxlength="5"
        />
      </label>
      <label>
        <span class="label-text">Home size in sq ft (optional)</span>
        <input
          name="home_size_sqft"
          type="number"
          min="100"
          max="20000"
          step="1"
        />
      </label>
      <label>
        <span class="label-text">Pricing zone</span>
        <select name="pricing_location">
          <option value="1">Zone 1</option>
          <option value="2">Zone 2</option>
          <option value="3">Zone 3</option>
          <option value="4">Zone 4</option>
          <option value="5">Zone 5</option>
          <option value="6">Zone 6</option>
          <option value="7">Zone 7</option>
          <option value="8">Zone 8</option>
        </select>
      </label>
    `;
  }
}
