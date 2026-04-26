# RALPH Process -- Autonomous Implementation Loop

When running in a RALPH loop (invoked by `ralph.sh` or when the user says "ralph"), follow this exact process for EACH iteration. Each iteration has fresh context -- you have NO memory of previous iterations except what's in files.

## RALPH Workflow (per iteration)

### 1. Read the PRD
Read `prd.json` from the project root. If it doesn't exist, stop and tell the user to create one (`/prd` or `/ralph` skill).

### 2. Check for Completion
If ALL stories have `"passes": true`, respond with exactly:
```
<promise>COMPLETE</promise>
```
Then stop. Do not implement anything.

### 3. Read Progress and Context
- Read `progress.txt` -- check the **Codebase Patterns** section first (consolidated learnings from prior iterations), then recent entries to avoid repeating mistakes
- Read `AGENTS.md` if it exists -- codebase patterns and key code locations
- Read the rest of this `CLAUDE.md` -- architecture, conventions, and build commands

### 4. Verify Git Branch
Check `prd.json` field `branchName`. Run `git branch --show-current`. If not on the correct branch:
- Branch exists: `git checkout <branchName>`
- Branch doesn't exist: `git checkout -b <branchName>`

### 5. Pick the Next Story
Select the highest-priority story where `"passes": false`. Priority 1 = highest. Among equal priorities, pick the lowest ID number.

### 6. Implement
Implement ONLY this story. Follow the acceptance criteria exactly. Rules:
- Read files before modifying them
- Follow existing code patterns from CLAUDE.md / AGENTS.md
- Minimum viable implementation -- don't over-engineer
- For cross-layer changes, verify EVERY layer
- If a criterion says "Verify: ...", actually perform that verification

### 7. Quality Checks
Run the project's build/test commands (see Build & Run section below). If checks fail, fix the issues. If unfixable, document in story notes.

### 8. Commit
```
feat: [Story ID] - [Story Title]
```
Use `feat:` for features, `fix:` for bugs, `refactor:` for refactoring, `docs:` for documentation.
**Never add Co-Authored-By lines or any co-author attribution to commits.**

### 9. Update PRD
In `prd.json`, set `"passes": true` and add implementation notes to `"notes"` (what was done, key decisions, files changed).

### 10. Update Patterns
If you discovered reusable patterns or gotchas, update `AGENTS.md`. Keep entries concise. Only update if genuinely new information.

### 11. Document Progress
Append to `progress.txt`:
```
## Iteration: <Day>, <Month> <Date>, <Year> <Time>

**Story:** <Story ID> - <Story Title>
**Status:** Completed | Partial | Blocked

**Files Changed:**
- path/to/file (brief description)

**Learnings:**
- Key insight or pattern discovered
```

Update the Codebase Patterns section at the top of `progress.txt` if you found broadly useful patterns.

### 12. Final Check
If ALL stories now have `"passes": true`, respond with:
```
<promise>COMPLETE</promise>
```

## RALPH Rules

1. **One story per iteration.** Do not combine multiple stories.
2. **Fresh context.** Each iteration starts with no memory. Read progress.txt and AGENTS.md.
3. **Verify everything.** Every "Verify:" criterion must be checked. Run build/test commands.
4. **Don't break things.** Tests passing before must still pass after.
5. **Commit atomically.** One commit per story.
6. **Be honest.** Don't set `passes: true` for incomplete work.

## General Rules

- **Never add Co-Authored-By lines or any co-author attribution to git commits.**
- All work happens on the `master` branch.
- Read `structure.md` when you need the deep architecture reference (component shapes, store contract, API client behavior, build pipeline). This file is the quick reference.

## Env Var Policy (RALPH runs without live credentials)

This package has **no build-time secrets** -- the bundle is shipped to end users via HACS and points at `https://api.hungrymachines.io` by default. There is no `.env` to populate. All "credentials" are runtime: a JWT obtained via the in-panel Supabase login flow, stored in `localStorage`. RALPH stories must:

- **Never require a live API.** Tests use vitest + happy-dom and stub `fetch` (or import the `apiFetch` client and mock it). No story Verify step should hit `api.hungrymachines.io`.
- **Tolerate missing tokens.** Components and the auth store must render a "signed out" state without throwing when `localStorage` is empty. The login form is the entry point; everything else short-circuits to a stub when `authStore.token` is null.
- **Verify with static checks.** `npm run build`, `npm test`, `tsc --noEmit`, file-existence greps, and bundle-size checks via `./scripts/release.sh` are the right Verify primitives. If a story needs a "real" API response, mock it.
- **Live integration is post-merge.** Loading the built `dist/hungry-machines.js` into a real Home Assistant instance and exercising the panel is a manual step the user does after the bundle ships -- not part of any RALPH Verify.

If a story's Verify step appears to need network access, the implementation is wrong -- mock the API call, don't relax the Verify.

---

# Hungry Machines -- Base Frontend (HACS Package)

## What This Project Is

This repository is **only** the v1 Home Assistant frontend for [Hungry Machines](https://hungrymachines.io). It ships a single ESM bundle, `dist/hungry-machines.js`, that registers three custom elements in HA:

- **`hungry-machines-panel`** -- full-page HA custom panel: Supabase login gate, dashboard with per-appliance optimized schedules (rate-colored 48-interval timeline), per-appliance constraint editor, settings (entity mapping, pricing zone, account).
- **`hm-thermostat-card`** -- standalone Lovelace card: indoor/outdoor temp, today's HVAC schedule chart, savings-level slider.
- **`hm-savings-card`** -- standalone Lovelace card: today's average savings %, current home power draw, next scheduled device run.

The bundle is distributed via HACS (`hacs.json`) and consumed by users following the install instructions in `README.md`.

**Note:** Previously called "Curve Control." A few historical names may linger in comments; all new code uses "Hungry Machines."

### What this repo is NOT

- **Not the backend.** The FastAPI optimizer, APScheduler jobs, and Supabase migrations live in a separate repo (`hungry-machines-api/`). When this code needs the API contract, treat `https://api.hungrymachines.io` as an external dependency. Do not edit endpoint shapes here -- mirror them in the typed wrappers in `src/api/`.
- **Not the marketing site.** `hungrymachines.io` is a separate Astro project.
- **Not the docs site.** `docs.hungrymachines.io` is a separate Starlight project.
- **Not a monorepo root.** This directory is published as its own GitHub repo at `hungrymachines/energy-dashboard` for HACS distribution. Do not add cross-package tooling that assumes siblings (the API, marketing site, and docs site live in separate repos).

## Project Layout

```
hungry-machines_base-frontend/
├── src/
│   ├── main.ts                        # entry — imports tokens + registers all custom elements
│   ├── api/                           # typed API client (per-endpoint wrappers)
│   │   ├── client.ts                  # apiFetch — auth header injection + 401 retry
│   │   ├── auth.ts                    # /auth/me + Supabase session bridge
│   │   ├── appliances.ts              # CRUD + readings + constraints
│   │   ├── preferences.ts             # GET/PUT /api/v1/preferences
│   │   ├── schedules.ts               # GET /api/v1/schedules
│   │   └── rates.ts                   # hourly TOU rates
│   ├── store.ts                       # singleton authStore (subscribe/hydrate/login/logout)
│   ├── panel/hungry-machines-panel.ts # full-page HA custom panel
│   ├── cards/
│   │   ├── thermostat-card.ts
│   │   └── savings-card.ts
│   ├── ui/
│   │   ├── login-form.ts
│   │   ├── schedule-chart.ts
│   │   └── constraint-editor.ts
│   ├── utils/hourly.ts                # 24h <-> 48-slot helpers
│   └── styles/tokens.{css,ts}         # brand palette + Lora/Lato tokens
├── tests/                             # vitest + happy-dom (one file per component / module)
├── scripts/release.sh                 # npm ci + npm run build + bundle size
├── dist/hungry-machines.js            # built bundle (generated; what HACS ships)
├── hacs.json                          # HACS metadata
├── README.md                          # install + configuration for end users
├── base-frontend-description.md       # original product brief
├── rollup.config.mjs                  # single-ESM bundle, terser max_line_len: 120
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── prd.json                           # RALPH story tracker (created per-feature)
├── ralph.sh                           # RALPH autonomous loop driver
├── structure.md                       # FULL architecture reference -- read for depth
└── CLAUDE.md                          # this file
```

## Stack

**Lit 3** + **TypeScript 5** + **Rollup 4** (single-file ESM bundle with terser). Tests run under **vitest 1** + **happy-dom**. No CSS loader — brand tokens live in `src/styles/tokens.ts` and install via constructable `CSSStyleSheet` + `document.adoptedStyleSheets`. Only runtime dependency: `lit`. Targets Home Assistant's modern frontend (evergreen browsers, ES2020+).

## Architecture at a Glance

```
                       ┌───────────────────────────────┐
                       │ Home Assistant frontend       │
                       │ (user's browser, served by HA)│
                       └─────────────┬─────────────────┘
                                     │ loads /hacsfiles/energy-dashboard/hungry-machines.js
                                     ▼
                       ┌───────────────────────────────┐
                       │ dist/hungry-machines.js       │
                       │ ┌──────────────────────────┐  │
                       │ │ <hungry-machines-panel>  │  │
                       │ │ <hm-thermostat-card>     │  │
                       │ │ <hm-savings-card>        │  │
                       │ └──────────────────────────┘  │
                       │       ▲              ▲        │
                       │       │ subscribe    │        │
                       │       ▼              │        │
                       │  ┌──────────┐        │        │
                       │  │authStore │  Lit components│
                       │  │(localSt.)│  share auth via│
                       │  └────┬─────┘  this singleton│
                       │       │                       │
                       │       ▼                       │
                       │  src/api/* — typed apiFetch  │
                       └─────────────┬─────────────────┘
                                     │ HTTPS, Bearer <Supabase JWT>
                                     ▼
                       ┌───────────────────────────────┐
                       │ api.hungrymachines.io         │
                       │ (external — see API_CONTRACT  │
                       │  in the hungry-machines-api   │
                       │  repo)                        │
                       └───────────────────────────────┘
```

**Key invariant:** the panel and the two cards share **one** `authStore` singleton. Sign in once via the panel and the cards immediately switch from their "Sign in from the Hungry Machines panel" stub to live data. Tokens live in `localStorage` and survive HA restarts; `apiFetch` automatically attaches them and surfaces 401s for the store to clear.

See `structure.md` for the full component contract, store API, and build pipeline.

---

## Patterns agents must preserve

- **Single bundle, no code-splitting.** `rollup.config.mjs` sets `inlineDynamicImports: true`. HA loads exactly one URL; do not introduce dynamic `import()` that would create chunks.
- **Custom elements are idempotent.** Every `customElements.define(...)` in `src/main.ts` is guarded by `customElements.get(...)`. Reloading the resource (or another integration registering the same tag) must not throw.
- **`window.customCards` registration.** Lovelace card picker only sees a card if it's pushed to `window.customCards`. The panel does not need this; the two cards do. Don't push duplicates -- check `existing` set first.
- **Brand tokens via adopted stylesheets.** `src/styles/tokens.ts` exports a `CSSStyleSheet` that is `adoptedStyleSheets`-installed once. Components reference `var(--hm-*)` -- do not hard-code colors or fonts. Never add a CSS-in-JS or CSS-loader; the bundle is intentionally tiny.
- **48 × 30-min interval shape.** Every schedule is 48 half-hour slots; this matches the API. The `schedule-chart` and `constraint-editor` rely on it. `src/utils/hourly.ts` converts between 24-hour user-facing arrays and 48-slot internal arrays -- do not reinvent that conversion inline.
- **Auth is Supabase Auth.** The login form drives `supabase.auth.signInWithPassword` (or signup) via the panel; the resulting JWT is what the API expects. Do not add a legacy `/auth/login` path -- the API does not have one.
- **`apiFetch` owns 401 handling.** On 401, `apiFetch` clears `authStore` (which forces every subscribed component back to the login state). Component code must not catch and swallow 401 itself.
- **Cards degrade gracefully when signed out.** Both cards render a stub instead of a request when `authStore.token` is null. Do not call API wrappers from `connectedCallback` unconditionally.
- **Tests use happy-dom + stubbed fetch.** No test should require a network. Set `globalThis.fetch = vi.fn(...)` and assert request shape. See `tests/client.test.ts` for the canonical pattern.
- **Bundle size is a feature.** The single-file ESM ships to every user's HA instance. `./scripts/release.sh` prints the size after build; if a change adds more than a few KB of minified output, justify it in the PRD notes.

## Build & Run

```bash
npm install
npm run build      # rollup -c → dist/hungry-machines.js
npm test           # vitest run
npm run dev        # rollup watch
npx tsc --noEmit   # type-check without emitting

./scripts/release.sh   # npm ci + build + print bundle size (the canonical "ready to ship" check)
```

There is no docker build, no `.env`, no migrations, and no server to start. The output is one file.

### Local end-to-end with Home Assistant
1. `npm run build`.
2. Copy `dist/hungry-machines.js` into a running HA's `/config/www/hungry-machines.js` (or symlink it).
3. Add it as a Lovelace resource (`/local/hungry-machines.js`, JavaScript module).
4. Add the `panel_custom` block from `README.md` to `configuration.yaml` and restart HA.

This is the manual smoke test for any UI-shaped change. RALPH stories must not require it -- they verify with vitest -- but the user does it before tagging a release.

## API Contract

This package consumes `api.hungrymachines.io`. The endpoints and shapes are owned by the API repo (`hungry-machines-api/API_CONTRACT.md`). The local mirrors live in `src/api/*.ts` -- one file per endpoint group:

- `auth.ts` -- bridges Supabase JS session to `Authorization: Bearer <JWT>`; calls `/auth/me`.
- `appliances.ts` -- `GET/POST/PUT /api/v1/appliances`, `POST /api/v1/appliances/{id}/readings`, `POST /api/v1/appliances/{id}/constraints`, `GET /api/v1/appliances/{id}/schedule`.
- `preferences.ts` -- `GET/PUT /api/v1/preferences`.
- `schedules.ts` -- `GET /api/v1/schedules` (all appliances, today).
- `rates.ts` -- hourly TOU rate config.
- `client.ts` -- `apiFetch(path, init)` builds `Authorization` header, handles 401, parses JSON, throws typed errors.

**If the API contract changes, the diff lands in the API repo first; this repo follows.** Do not invent new endpoints here -- if you need one that doesn't exist, the story is "add it server-side" and only then mirror it in `src/api/`.

## Branding

The HACS package follows the Hungry Machines brand:
- Palette: deep blue primary (`#1E3A8A`), teal/emerald secondary (`#0F766E`), amber accent (`#F59E0B`), cool-white background.
- Type: Lora serif headings, Lato sans body. Tokens defined in `src/styles/tokens.{css,ts}` -- both files keep the same values; `tokens.ts` is the one wired into components.
- Voice (any user-facing copy): direct, empowering, transparent. No hype, no superlatives, no fear-based framing.

The full brand source-of-truth (`Brand Guidelines.md`, `Brand Website UI UX.md`) lives in the marketing-site repo; copy values from `src/styles/tokens.ts` rather than hand-typing hex codes.

## Distribution

The artifact is `dist/hungry-machines.js`, configured by `hacs.json`:
```json
{ "name": "Hungry Machines", "content_in_root": false, "filename": "hungry-machines.js", "render_readme": true }
```

Published at `hungrymachines/energy-dashboard`. HACS users add `https://github.com/hungrymachines/energy-dashboard` as a custom Frontend repository, install, and reference the file at `/hacsfiles/energy-dashboard/hungry-machines.js`. Releases are tagged on `master`; the file in the release tarball must be the built `dist/hungry-machines.js`. Do not check `dist/` into the working tree under normal commits -- it is built and attached by the release flow.

---

## For Agents: Where to Look When...

| Question | Go to |
|---|---|
| What's the architecture / how do the pieces fit? | `structure.md` |
| What's the shape of endpoint `/api/v1/X`? | `src/api/<group>.ts` (this repo's mirror) → `hungry-machines-api/API_CONTRACT.md` (source of truth, in the API repo) |
| What custom elements does the bundle export? | `src/main.ts` |
| Where do tokens / colors / fonts come from? | `src/styles/tokens.ts` |
| How does auth flow work? | `src/store.ts` + `src/api/client.ts` + `src/ui/login-form.ts` |
| How does the dashboard render schedules? | `src/panel/hungry-machines-panel.ts` + `src/ui/schedule-chart.ts` |
| How do users install this? | `README.md` |
| What's currently being built? | `prd.json` (if present) + `progress.txt` |
| What patterns / gotchas have we learned? | `AGENTS.md` (if present) + `progress.txt` Codebase Patterns section |
