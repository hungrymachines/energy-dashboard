# Base Frontend — Architecture Reference

Deep reference for **`hungry-machines_base-frontend`**, the Home Assistant frontend package distributed via HACS. Everything below is observed from the files in this directory; nothing here describes the backend, marketing site, or docs site (those live in their own repos).

This file is the deep reference; `CLAUDE.md` is the quick reference. Read this when you need exact component contracts, the build pipeline, or the auth/store/API-client wiring.

---

## 1. What This Package Ships

Exactly one artifact: `dist/hungry-machines.js`, a single-file ESM bundle (rollup + terser). Loading it once into Home Assistant registers six custom elements; three are user-facing, three are internal Lit components reused by the others.

| Custom element | Kind | Used as |
|---|---|---|
| `hungry-machines-panel` | HA custom panel | Full-page sidebar entry, registered in `configuration.yaml` via `panel_custom:` |
| `hm-thermostat-card` | Lovelace card | YAML-configured card (`type: custom:hm-thermostat-card`) |
| `hm-savings-card` | Lovelace card | YAML-configured card (`type: custom:hm-savings-card`) |
| `hm-login-form` | Internal | Reused inside the panel's signed-out state |
| `hm-schedule-chart` | Internal | 48-slot timeline visual, used by the panel and `hm-thermostat-card` |
| `hm-constraint-editor` | Internal | Per-appliance constraint editor, used inside the panel |

The two cards also self-register with `window.customCards` so they show up in HA's Lovelace card picker.

`hacs.json` declares the artifact:
```json
{ "name": "Hungry Machines", "content_in_root": false, "filename": "hungry-machines.js", "render_readme": true }
```

End users install via HACS (custom Frontend repository pointing at `https://github.com/hungrymachines/energy-dashboard`) and reference `/hacsfiles/energy-dashboard/hungry-machines.js`. Manual install drops the file in `/config/www/` and references `/local/hungry-machines.js`. See `README.md` for the install runbook.

---

## 2. Top-Level Layout

```
hungry-machines_base-frontend/
├── src/                          # all TS sources
│   ├── main.ts                   # entry; imports tokens stylesheet, registers custom elements,
│   │                             # pushes the two cards onto window.customCards
│   ├── api/                      # typed API client + per-endpoint wrappers
│   │   ├── client.ts
│   │   ├── auth.ts
│   │   ├── appliances.ts
│   │   ├── preferences.ts
│   │   ├── schedules.ts
│   │   └── rates.ts
│   ├── store.ts                  # singleton authStore (subscribe/hydrate/login/logout)
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
│   │   └── hourly.ts             # 24h ↔ 48-slot conversion helpers
│   └── styles/
│       ├── tokens.css            # human-readable token reference
│       └── tokens.ts             # the actual constructable CSSStyleSheet that ships
├── tests/                        # vitest + happy-dom; one file per component / module
├── scripts/release.sh            # npm ci + npm run build + print bundle size
├── dist/                         # build output (gitignored except at release time)
├── hacs.json                     # HACS metadata
├── README.md                     # end-user install + configuration
├── base-frontend-description.md  # original product brief
├── package.json                  # name: hungry-machines-frontend, only runtime dep: lit
├── package-lock.json
├── rollup.config.mjs             # single-ESM bundle, inlineDynamicImports, terser max_line_len 120
├── tsconfig.json
├── vitest.config.ts
├── prd.json                      # RALPH story tracker (per-feature)
├── progress.txt                  # RALPH iteration log + Codebase Patterns
├── AGENTS.md                     # (if present) consolidated agent learnings
├── ralph.sh                      # RALPH autonomous loop driver
├── CLAUDE.md                     # quick reference for agents
└── structure.md                  # this file
```

There is no Dockerfile, no `docker-compose.yml`, and no `.env*`. The output is a single static JS file.

---

## 3. Stack & Tooling

| Layer | Tool | Notes |
|---|---|---|
| UI framework | **Lit 3** | Reactive properties, `LitElement`, `html`/`css` template literals |
| Language | **TypeScript 5** | `tsconfig.json`: `module: ESNext`, `target: ES2020`, `moduleResolution: bundler`, strict |
| Bundler | **Rollup 4** | Plugins: `@rollup/plugin-typescript`, `@rollup/plugin-node-resolve` (browser), `@rollup/plugin-terser` |
| Test runner | **Vitest 1** + **happy-dom** | DOM-shaped tests for Lit components; `globalThis.fetch` is stubbed per-test |
| Distribution | **HACS** (Home Assistant Community Store) | Custom Frontend repository pointing at this repo's release tarball |

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
    file: 'dist/hungry-machines.js',
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

`scripts/release.sh` is the canonical "ready to ship" check: `npm ci && npm run build`, then `du -h dist/hungry-machines.js`.

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

Registered via `configuration.yaml`:
```yaml
panel_custom:
  - name: hungry-machines-panel
    sidebar_title: Hungry Machines
    sidebar_icon: mdi:lightning-bolt
    url_path: hungry-machines
    module_url: /hacsfiles/energy-dashboard/hungry-machines.js
    embed_iframe: false
    trust_external_script: false
```

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

The artifact is `dist/hungry-machines.js`. Release flow is automated by `.github/workflows/release.yml` — pushing a `v*` tag runs `npm ci && npm test && npm run build`, creates a GitHub Release for the tag, and attaches `dist/hungry-machines.js` as a release asset.

```bash
# Cut a release:
# 1. Bump "version" in package.json on master and commit.
# 2. Tag and push.
git tag v0.1.1
git push --tags
# CI runs the workflow; the release appears on github.com with the bundle attached.
```

A failing test or build aborts the workflow before the release is created, so a broken commit can't ship by accident. If you ever need to release manually (CI down, debugging), `./scripts/release.sh` builds + prints bundle size locally and you can drag the file into the release UI on github.com.

`hacs.json` controls how HACS finds the file: `content_in_root: false` + `filename: hungry-machines.js` means HACS pulls `hungry-machines.js` from the latest release's assets and copies it to `/hacsfiles/<repo-name>/`.

The published GitHub repo is `hungrymachines/energy-dashboard`. HACS derives the on-disk path from the repo name, so installs land at `/hacsfiles/energy-dashboard/`; the `module_url` in `README.md` and the deploy snippets here all match that path.

`dist/` is gitignored in normal development — never committed. The release workflow rebuilds it from source on every tag push.

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
2. `npm run build` — produces `dist/hungry-machines.js`.
3. `npm test` — runs the vitest suite (must be green).
4. `npx tsc --noEmit` — type-check.
5. (Optional, manual) Copy `dist/hungry-machines.js` into a real HA's `/config/www/`, register as a Lovelace resource (`/local/hungry-machines.js`, JavaScript module), and add the `panel_custom` block from `README.md` to `configuration.yaml`. Restart HA. Sign in. Verify the dashboard renders schedules.

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

If a story tempts you to import something heavy (a full charting library, a date library, a runtime CSS-in-JS engine), pause and check whether a dozen lines of plain Lit + `Intl.*` would do — they almost always do.
