# Base Frontend — Architecture Reference

Deep reference for **`hungry-machines_base-frontend`**, the Home Assistant integration package distributed via HACS. Everything below is observed from the files in this directory; nothing here describes the backend, marketing site, or docs site (those live in their own repos).

This file is the deep reference; `CLAUDE.md` is the quick reference. Read this when you need exact component contracts, the Python integration shape, the build pipeline, or the auth/store/API-client wiring.

---

## 1. What This Package Ships

A HACS **Integration** (not a Dashboard plugin). Two artifacts that ship as one zip:

1. **Python integration** at `custom_components/hungry_machines/` — about 100 lines total. Registers a static HTTP path that serves the JS bundle, calls `add_extra_js_url` so cards work everywhere, and calls `async_register_built_in_panel` so the sidebar entry appears. No business logic; no HTTP calls outside HA.
2. **Frontend bundle** at `custom_components/hungry_machines/frontend/hungry-machines.js` — single-file ESM (rollup + terser, ~96 KB). Registers six custom elements; three are user-facing, three are internal Lit components reused by the others:

| Custom element | Kind | Used as |
|---|---|---|
| `hungry-machines-panel` | HA custom panel | Full-page sidebar entry, registered programmatically by the Python integration via `async_register_built_in_panel` |
| `hm-thermostat-card` | Lovelace card | Card-picker option (`type: custom:hm-thermostat-card`) |
| `hm-savings-card` | Lovelace card | Card-picker option (`type: custom:hm-savings-card`) |
| `hm-login-form` | Internal | Reused inside the panel's signed-out state |
| `hm-schedule-chart` | Internal | 48-slot timeline visual, used by the panel and `hm-thermostat-card` |
| `hm-constraint-editor` | Internal | Per-appliance constraint editor, used inside the panel |

The two cards self-register with `window.customCards` so they show up in HA's Lovelace card picker as soon as the integration is installed.

`hacs.json` declares this as a zip-release integration:
```json
{ "name": "Hungry Machines", "render_readme": true, "zip_release": true, "filename": "hungry_machines.zip" }
```

End users install by adding `https://github.com/hungrymachines/energy-dashboard` to HACS with **Type: Integration**, then **Settings → Devices & Services → Add Integration → "Hungry Machines"**. No `configuration.yaml` editing required. See `README.md` for the user-facing runbook.

---

## 2. Top-Level Layout

```
hungry-machines_base-frontend/
├── custom_components/hungry_machines/   # the HACS Integration (what HA installs)
│   ├── __init__.py                      # async_setup_entry: static path + extra_js + panel
│   ├── manifest.json                    # HA integration manifest
│   ├── config_flow.py                   # one-step "Add Integration" UI flow
│   ├── const.py                         # DOMAIN, panel constants, SCRIPT_URL
│   ├── strings.json                     # source UI strings
│   ├── translations/en.json             # localized UI strings
│   └── frontend/
│       └── hungry-machines.js           # built JS bundle (gitignored — output of npm run build)
├── src/                                 # TypeScript / Lit sources
│   ├── main.ts                          # entry; imports tokens, registers custom elements,
│   │                                    # pushes the two cards onto window.customCards
│   ├── api/                             # typed API client + per-endpoint wrappers
│   │   ├── client.ts
│   │   ├── auth.ts
│   │   ├── appliances.ts
│   │   ├── preferences.ts
│   │   ├── schedules.ts
│   │   └── rates.ts
│   ├── store.ts                         # singleton authStore (subscribe/hydrate/login/logout)
│   ├── panel/
│   │   └── hungry-machines-panel.ts
│   ├── cards/
│   │   ├── thermostat-card.ts
│   │   └── savings-card.ts
│   ├── ui/
│   │   ├── login-form.ts
│   │   ├── schedule-chart.ts
│   │   └── constraint-editor.ts
│   ├── utils/
│   │   └── hourly.ts                    # 24h ↔ 48-slot conversion helpers
│   └── styles/
│       ├── tokens.css                   # human-readable token reference
│       └── tokens.ts                    # the actual constructable CSSStyleSheet that ships
├── tests/                               # vitest + happy-dom; one file per TS module
├── scripts/release.sh                   # npm ci + npm run build + print bundle size
├── .github/workflows/release.yml        # tag push → build → zip integration → publish release
├── hacs.json                            # HACS metadata (zip_release for integration mode)
├── README.md                            # end-user install + configuration
├── LICENSE                              # MIT
├── base-frontend-description.md         # original product brief
├── package.json                         # name: hungry-machines-frontend, only runtime dep: lit
├── package-lock.json
├── rollup.config.mjs                    # single-ESM bundle, inlineDynamicImports, terser max_line_len 120
├── tsconfig.json
├── vitest.config.ts
├── prd.json                             # RALPH story tracker (per-feature)
├── progress.txt                         # RALPH iteration log + Codebase Patterns
├── AGENTS.md                            # (if present) consolidated agent learnings
├── ralph.sh                             # RALPH autonomous loop driver
├── CLAUDE.md                            # quick reference for agents
└── structure.md                         # this file
```

There is no Dockerfile, no `docker-compose.yml`, and no `.env*`. The shipped artifact is `custom_components/hungry_machines/` (zipped at release time) with the built JS bundle inside it.

---

## 3. Stack & Tooling

| Layer | Tool | Notes |
|---|---|---|
| UI framework | **Lit 3** | Reactive properties, `LitElement`, `html`/`css` template literals |
| Language | **TypeScript 5** | `tsconfig.json`: `module: ESNext`, `target: ES2020`, `moduleResolution: bundler`, strict |
| Bundler | **Rollup 4** | Plugins: `@rollup/plugin-typescript`, `@rollup/plugin-node-resolve` (browser), `@rollup/plugin-terser` |
| Test runner | **Vitest 1** + **happy-dom** | DOM-shaped tests for Lit components; `globalThis.fetch` is stubbed per-test |
| Distribution | **HACS** (Home Assistant Community Store) | Custom **Integration** repository (Type: Integration), zip release |
| Integration host | **Python 3.11+** (whatever HA ships) | `custom_components/hungry_machines/` — uses HA's built-in `frontend`, `http`, and `config_entries` modules; no third-party Python deps |

### Runtime dependencies

```json
"dependencies": { "lit": "^3.2.0" }
```

That's it. Everything else is a devDependency. The bundle includes Lit (no peer dep on HA — HA ships its own Lit, but we self-contain so the bundle works regardless of HA version).

### Build pipeline

`rollup.config.mjs`:
```js
{
  input: 'src/main.ts',
  output: {
    file: 'custom_components/hungry_machines/frontend/hungry-machines.js',
    format: 'esm',
    inlineDynamicImports: true,   // single chunk — HA fetches one URL
    sourcemap: false,             // ship size-optimized
  },
  plugins: [
    resolve({ browser: true }),
    typescript({ tsconfig: './tsconfig.json' }),
    terser({
      format: { comments: false, max_line_len: 120, semicolons: true },
      compress: { passes: 2 },
      mangle: { properties: false },   // do NOT mangle properties — HA / Lovelace
                                       // pokes at component fields by name
    }),
  ],
}
```

**Two non-obvious constraints:**
- `inlineDynamicImports: true`. Any future `import('./foo')` will be inlined, not split. Do not rely on dynamic import for code-splitting; HA loads exactly one URL.
- `mangle: { properties: false }`. Lovelace and HA's panel host instantiate elements by tag name and read/write public properties (`hass`, `narrow`, `route`, `config`). If property mangling were on, those reads would silently break. Do not turn it on.

### Scripts

```json
"scripts": {
  "build": "rollup -c",
  "test": "vitest run",
  "dev": "rollup -c -w"
}
```

`scripts/release.sh` is the canonical "ready to ship" check: `npm ci && npm run build`, then `du -h custom_components/hungry_machines/frontend/hungry-machines.js`.

---

## 4. Auth & Store Contract

### `src/store.ts` — `authStore` singleton

A small subscribable store. Single source of truth for the JWT, user identity, and "are we signed in?" state across the panel, both cards, and the login form. Backed by `localStorage` so HA reloads / page reloads survive.

Public surface (observed from imports):
- `authStore.token: string | null` — current JWT or null
- `authStore.userId: string | null`
- `authStore.subscribe(fn)` — register a listener; called on every state change
- `authStore.hydrate()` — read from `localStorage` on element `connectedCallback`
- `authStore.login({token, userId})` — persist + notify
- `authStore.logout()` — clear + notify; also called by `apiFetch` on 401

### `src/api/client.ts` — `apiFetch`

Thin wrapper around `fetch`:
1. Reads `authStore.token`. If present, sets `Authorization: Bearer <token>`.
2. Sets `Content-Type: application/json` on requests with a body.
3. On `401`, calls `authStore.logout()` so subscribed components flip to the signed-out state automatically. Then throws.
4. On other non-2xx, throws a typed error (status + parsed JSON body).
5. On 2xx, returns parsed JSON.

The base URL is `https://api.hungrymachines.io` (no env var — this is a shipped client). Tests stub `globalThis.fetch` to assert request shape.

### Per-endpoint wrappers

One file per endpoint group in `src/api/`:
- `auth.ts` — bridges the Supabase JS session to a JWT, calls `GET /auth/me`.
- `appliances.ts` — list/create/update appliances; push readings; push constraints; fetch a single appliance schedule.
- `preferences.ts` — GET/PUT `/api/v1/preferences` (base temp, savings level, hourly highs/lows).
- `schedules.ts` — GET `/api/v1/schedules` (today's optimized schedules for every appliance).
- `rates.ts` — hourly TOU rate overrides.

**Mirror discipline:** the API contract is owned by the backend repo (`hungry-machines-api/API_CONTRACT.md`). These wrappers are the local mirror — when the contract changes, the diff lands server-side first and this repo follows. Do not invent new endpoint shapes here.

---

## 5. Component Contracts

### `<hungry-machines-panel>` — full-page HA custom panel

Registered programmatically by `custom_components/hungry_machines/__init__.py` via:
```python
async_register_built_in_panel(
    hass,
    component_name="custom",
    sidebar_title="Hungry Machines",
    sidebar_icon="mdi:lightning-bolt",
    frontend_url_path="hungry-machines",
    config={
        "_panel_custom": {
            "name": "hungry-machines-panel",
            "embed_iframe": False,
            "trust_external": False,
            "module_url": "/hungry_machines/hungry-machines.js",
        }
    },
    require_admin=False,
)
```

`module_url` resolves to a static path served by the integration itself (`async_register_static_paths(StaticPathConfig(...))`), so the JS file lives next to the Python and is served directly — not via `/hacsfiles/` and not via Lovelace resource registration.

HA constructs the element and assigns `hass`, `narrow`, `route`, `panel` properties. The panel:
- On `connectedCallback`, calls `authStore.hydrate()` and subscribes.
- Signed-out state: renders `<hm-login-form>` only.
- Signed-in state: renders three views (Dashboard / Constraints / Settings) gated by an in-memory tab selection.
- Dashboard: fetches `/api/v1/schedules`, renders `<hm-schedule-chart>` per appliance with rate-colored 48-interval timelines.
- Constraints: per-appliance editor via `<hm-constraint-editor>`, PUT-back to `/api/v1/appliances/{id}/constraints`.
- Settings: HA entity mapping (which `sensor.*` feed indoor/outdoor temp + power), pricing zone (1–8), account actions (sign out, contact `info@hungrymachines.io` to delete).

### `<hm-thermostat-card>` — Lovelace card

```yaml
type: custom:hm-thermostat-card
entities:
  indoor_temp: sensor.living_room_temp
  outdoor_temp: sensor.outside_temp
  hvac_action: sensor.hvac_action
```

Reads HA entity states via the standard Lovelace `setConfig({entities})` + `set hass(hass)` contract. Renders current temps, today's HVAC schedule chart (re-using `<hm-schedule-chart>`), and a savings-level slider that PUT-backs to `/api/v1/preferences`. Falls back to a "Sign in from the Hungry Machines panel" stub when `authStore.token` is null — registers `authStore.subscribe` so it lights up the moment the panel signs in.

### `<hm-savings-card>` — Lovelace card

```yaml
type: custom:hm-savings-card
entities:
  power: sensor.home_power
```

Today's average savings %, current home power draw (from the configured HA `power` entity), and the next scheduled device run (computed from `/api/v1/schedules`). Same signed-out stub as the thermostat card.

### Internal Lit components

- **`<hm-login-form>`** — email + password fields. On submit, drives the Supabase JS session and, on success, calls `authStore.login(...)`. Surfaces `signUp` and `resetPassword` flows behind toggles.
- **`<hm-schedule-chart>`** — pure render; takes a 48-element schedule array + an optional 48-element rate array and paints the timeline with the rate gradient. No fetching, no store subscription.
- **`<hm-constraint-editor>`** — per-appliance form. For HVAC: 24-hour high/low temp ranges (uses `src/utils/hourly.ts` to convert 24-entry user input to the 48-slot internal shape). For EV / battery / water heater: the appliance-specific constraint shape. Emits a `change` event with the new constraints object; the panel POSTs it.

### Custom-elements registration

`src/main.ts` is the only place `customElements.define(...)` is called. Every define is guarded:
```ts
if (!customElements.get('hungry-machines-panel')) {
  customElements.define('hungry-machines-panel', HungryMachinesPanel);
}
```
This allows the file to be loaded twice (e.g. once by HA's panel host and once by Lovelace) without throwing.

`window.customCards` is also populated guard-checked: a `Set<string>` of existing types prevents double-pushing the two card registrations.

---

## 6. Styles & Theming

### Tokens

`src/styles/tokens.ts` exports a constructable `CSSStyleSheet` with the brand palette and font tokens (`--hm-color-primary`, `--hm-color-secondary`, `--hm-color-accent`, `--hm-color-bg`, `--hm-font-display`, `--hm-font-body`, etc.). On import, the stylesheet is appended to `document.adoptedStyleSheets`. Components also adopt it on their shadow roots so the tokens resolve under `:host`.

`src/styles/tokens.css` is the human-readable equivalent — kept in sync as documentation, but `tokens.ts` is what ships in the bundle.

### Why constructable stylesheets

- No CSS loader → smaller bundle, fewer rollup plugins.
- Tokens are defined exactly once, shared across every shadow root.
- HA's own theme tokens are still visible in light DOM, so the panel/cards can read them too if needed.

### Brand at-a-glance

- Deep blue `#1E3A8A` (primary), teal/emerald `#0F766E` (secondary), amber `#F59E0B` (accent), cool-white background.
- Lora serif for headings, Lato sans for body.
- Voice: direct, empowering, transparent. No hype, no fear-based framing. The full brand source-of-truth lives in the marketing-site repo (`Brand Guidelines.md`, `Brand Website UI UX.md`).

---

## 7. Schedule Shape — 48 × 30-min Intervals

Every schedule (HVAC, EV, battery, water heater) the API returns is a 48-element array (a 24-hour day at 30-minute resolution). This shape is hardcoded into:
- `<hm-schedule-chart>` (renders 48 bars).
- `<hm-constraint-editor>` (round-trips to/from a 24-entry hourly UI via `src/utils/hourly.ts`).
- The API wrappers, which type the schedule shape per appliance.

| Appliance | Schedule shape |
|---|---|
| `hvac` | `{ intervals: number[48], high_temps: number[48], low_temps: number[48] }` (Fahrenheit) |
| `ev_charger` | `{ intervals: boolean[48], value_trajectory: number[48], unit: 'percent' }` (0–100) |
| `home_battery` | `{ intervals: boolean[48], value_trajectory: number[48], unit: 'percent' }` (0–100) |
| `water_heater` | `{ intervals: boolean[48], temp_trajectory: number[48], unit: 'fahrenheit' }` |

Do not hand-roll new shapes. If a story needs different data, bring the change to the backend repo first; only then mirror it.

---

## 8. Tests

Vitest + happy-dom. One test file per component / module:

```
tests/
├── client.test.ts                   # apiFetch: header injection, 401 → logout, error parsing
├── store.test.ts                    # authStore: hydrate, login/logout, subscribe semantics
├── login-form.test.ts               # render, submit, error display
├── panel.test.ts                    # signed-in / signed-out switching
├── panel-schedules.test.ts          # dashboard: schedule fetch + render
├── thermostat-card.test.ts          # config + hass property reactivity, signed-out stub
├── savings-card.test.ts             # next-run computation, signed-out stub
├── schedule-chart.test.ts           # 48-bar render, rate gradient
├── constraint-editor.test.ts        # constraint round-trip
├── constraint-editor-hourly.test.ts # 24h ↔ 48-slot conversion in the editor
├── settings.test.ts                 # entity mapping + pricing zone
├── settings-rates.test.ts           # hourly rates editor
└── hourly.test.ts                   # src/utils/hourly.ts unit tests
```

Patterns:
- **Stub `globalThis.fetch`** with `vi.fn(...)` per test; assert URL + method + headers + body.
- **happy-dom** for shadow DOM querying. Use `await el.updateComplete` after Lit property writes before asserting the rendered tree.
- **No real network.** A test that requires a live API is wrong — see the Env Var Policy in `CLAUDE.md`.
- **`authStore` is shared state.** Tests that set tokens must clear them in `afterEach` (or use a fresh `localStorage` per test) to avoid leakage.

---

## 9. Distribution & Release

Two artifacts ship per release:
1. `hungry_machines.zip` — the contents of `custom_components/hungry_machines/` (with the just-built JS bundle inside `frontend/`). This is what HACS downloads and extracts.
2. `hungry-machines.js` — the standalone JS bundle, attached as a separate asset. Useful for power-users who want to inspect the bundle or do a non-HACS install of just the JS.

Release flow is automated by `.github/workflows/release.yml`. Pushing a `v*` tag runs `npm ci && npm test && npm run build`, zips `custom_components/hungry_machines/`, and creates a GitHub Release with both assets attached:

```bash
# Cut a release:
# 1. Bump "version" in package.json AND custom_components/hungry_machines/manifest.json on master.
# 2. Commit, tag, push.
git tag v0.2.1
git push --tags
# CI runs the workflow; the release appears on github.com with both assets attached.
```

A failing test or build aborts the workflow before the release is created, so a broken commit can't ship by accident. If you ever need to release manually (CI down, debugging), `./scripts/release.sh` builds + prints bundle size locally; then `cd custom_components/hungry_machines && zip -r ../../hungry_machines.zip .` and drag both files into the release UI on github.com.

### How HACS finds the zip

`hacs.json`:
```json
{ "name": "Hungry Machines", "render_readme": true, "zip_release": true, "filename": "hungry_machines.zip" }
```

`zip_release: true` tells HACS this is a zipped Integration release. `filename: hungry_machines.zip` is the exact asset name HACS looks for on the latest release. HACS downloads the zip and extracts it directly into the user's `<config>/custom_components/hungry_machines/`, so the zip must contain the *contents* of that folder (not a wrapping folder). The release workflow zips from inside the directory (`cd custom_components/hungry_machines && zip ...`) to match.

### Version coupling

Three places carry a version, and they must agree at tag time:
- `package.json` `version`
- `custom_components/hungry_machines/manifest.json` `version`
- The `vX.Y.Z` git tag

HA uses the manifest version to detect updates. HACS uses the tag for the same purpose. Mismatches produce confusing "no update available" reports for users.

### What's not committed

`custom_components/hungry_machines/frontend/hungry-machines.js` is gitignored — built only at release time. The repository's working tree intentionally does *not* contain a built bundle so that reading the source is unambiguous and `git diff` only shows authored changes.

---

## 10. Where This Sits in the Larger Hungry Machines System

This package is **only the client**. Three external dependencies, owned by separate repos:

| External system | Purpose | Where the truth lives |
|---|---|---|
| `api.hungrymachines.io` | FastAPI backend: auth bridge, schedules, preferences, appliances, readings, constraints | `hungry-machines-api/` repo, especially `API_CONTRACT.md` |
| Supabase Cloud | Auth (email/password, magic links, password reset) and Postgres | Supabase project; client uses `supabase-js` SDK |
| `hungrymachines.io` | Marketing site (where users sign up before installing the HACS package) | `hungry-machines-website/` repo |

Code in this repo never touches Supabase tables directly, never calls Stripe, never fetches weather. Everything outside the HA frontend goes through `api.hungrymachines.io`.

---

## 11. Minimum Bootstrapping Checklist

For a fresh contributor (or a fresh RALPH iteration on a clean checkout):

1. `npm install` — installs Lit + dev tooling.
2. `npm run build` — produces `custom_components/hungry_machines/frontend/hungry-machines.js`.
3. `npm test` — runs the vitest suite (must be green).
4. `npx tsc --noEmit` — type-check.
5. (Optional, manual) Copy or symlink the entire `custom_components/hungry_machines/` directory into a real HA's `<config>/custom_components/hungry_machines/`. Restart HA. **Settings → Devices & Services → Add Integration → "Hungry Machines" → Submit**. Click the new sidebar entry and sign in.

Steps 1–4 run in CI; step 5 is the manual smoke test before tagging a release.

---

## 12. Adding New Functionality — Decision Tree

| You want to... | Where the change goes |
|---|---|
| Add a new field to a request/response | Backend repo first (update `API_CONTRACT.md` + handler). Then mirror in `src/api/<group>.ts` here. |
| Add a new UI view inside the panel | New `src/ui/<thing>.ts` component, used by `src/panel/hungry-machines-panel.ts`. Test with vitest. |
| Add a new Lovelace card | New `src/cards/<thing>-card.ts`. Register in `src/main.ts` (both `customElements.define` guard + `window.customCards.push` guard). Test with vitest. |
| Change a brand color | `src/styles/tokens.ts` (and mirror to `tokens.css` for documentation). Components reference the var, so nothing else changes. |
| Add an internal helper used across components | `src/utils/<thing>.ts`. Add a unit test. |
| Add a new external dependency | Strongly consider not. The bundle is shipped to every user's HA; every byte counts. Justify in the PRD. |
| Change the panel's sidebar title or icon | `custom_components/hungry_machines/const.py` (`PANEL_TITLE`, `PANEL_ICON`). |
| Change the integration's URL slug or domain | `custom_components/hungry_machines/const.py` + `manifest.json`. **Breaking change** — existing users' config entries will need to be re-added. |
| Add a config-flow step (e.g. ask the user something) | `config_flow.py`. Add new strings to `strings.json` and `translations/en.json`. |
| Bump the package version | `package.json` AND `custom_components/hungry_machines/manifest.json` AND the next git tag. Keep all three in sync. |

---

## 13. Python Integration Anatomy

The Python at `custom_components/hungry_machines/` is small enough to keep entirely in your head. Here's exactly what each file does:

### `manifest.json`
HA integration manifest. Required keys: `domain`, `name`, `version`, `documentation`, `issue_tracker`, `codeowners`, `dependencies` (`http`, `frontend`), `config_flow: true`, `iot_class`, `integration_type: service`. `requirements: []` because we have no third-party Python deps.

### `const.py`
Pure constants. `DOMAIN = "hungry_machines"`. `PANEL_URL_PATH`, `PANEL_TITLE`, `PANEL_ICON`, `PANEL_NAME`. `SCRIPT_FILENAME = "hungry-machines.js"` and `SCRIPT_URL = f"/{DOMAIN}/{SCRIPT_FILENAME}"` — the URL HA will serve the JS at, used by both the static-path registration and the panel's `module_url`.

### `__init__.py`
Two functions:

**`async_setup_entry(hass, entry)`** — runs when the user adds the integration via the UI. In order:
1. Resolves the path to the bundled JS (`Path(__file__).parent / "frontend" / SCRIPT_FILENAME`). If missing, logs a clear error and returns `False` (HA will mark the entry as failed; user is told to reinstall via HACS).
2. `await hass.http.async_register_static_paths([StaticPathConfig(SCRIPT_URL, str(frontend_file), False)])` — serves the JS at `/hungry_machines/hungry-machines.js`.
3. `add_extra_js_url(hass, SCRIPT_URL)` — injects the script tag into every HA frontend page, so cards work everywhere (not just on the panel page).
4. `async_register_built_in_panel(...)` with `component_name="custom"` and `module_url=SCRIPT_URL` — registers the sidebar entry.

**`async_unload_entry(hass, entry)`** — runs when the user deletes the integration. Calls `async_remove_panel(hass, PANEL_URL_PATH)` so the sidebar entry disappears immediately. We deliberately do *not* try to un-register the static path or extra_js_url — HA cleans those on next restart and the alternative is fragile.

### `config_flow.py`
Single-step user flow. Asserts unique-id (only one Hungry Machines per HA) via `_abort_if_unique_id_configured()`. The "step" is just a confirmation dialog with the strings from `strings.json` — no fields to fill in. Sign-in happens later, in the panel itself.

### `strings.json` + `translations/en.json`
The text the user sees during setup. Identical content; HA expects both. New languages would land as `translations/<lang>.json`.

### `frontend/hungry-machines.js`
The built TypeScript bundle. Gitignored on master; only present locally after `npm run build`, and only present in releases inside the zip.

That's the whole integration. ~100 lines of Python total. If a story tempts you to add more, ask: "could this live in TypeScript instead?" The answer is almost always yes.

If a story tempts you to import something heavy (a full charting library, a date library, a runtime CSS-in-JS engine), pause and check whether a dozen lines of plain Lit + `Intl.*` would do — they almost always do.
