# Agent Notes — Hungry Machines Base Frontend

Quick reference for hot spots and gotchas. See `CLAUDE.md` for the canonical project doc and `structure.md` for the deep architecture reference.

## Hot files

- `src/store.ts` — `authStore` singleton + `getEntityMap`/`setEntityMap` (localStorage `hm_entity_map`).
- `src/panel/hungry-machines-panel.ts` — full-page panel; tabs (Dashboard / Settings); appliance cards; rates editor; entity / pricing-zone selects.
- `src/cards/thermostat-card.ts` and `src/cards/savings-card.ts` — Lovelace cards. They take their HA-entity wiring from **Lovelace card config**, not from `getEntityMap()`.
- `src/api/client.ts` — `apiFetch` with auto-attached Bearer + 401 → `clearTokens` chain.
- `src/data/pricing-zones.ts` — `PRICING_ZONE_LABELS` (1..8 → `{ provider, region }`) + `pricingZoneOptionLabel` / `pricingZoneFullLabel` helpers. Drives the Settings → Pricing zone dropdown text and zone-hint span. Update zones 3–8 here when the API repo's `app/services/pricing.py` is reconciled.
- `src/ui/appliance-form.ts` — `HmApplianceForm` modal. Two-step flow: type picker (4 types) → per-type config form. Emits `appliance-created` (with `{detail: {appliance}}`) and `cancelled`. The panel listens to both and re-fetches `/api/v1/schedules` on creation by flipping `_schedulesFetched=false`. `appliancesApi.create()` synthesizes a full `Appliance` from the API's thin `{appliance_id}` response when needed.
- `custom_components/hungry_machines/auth.py` — `login(hass, email, password)`, `refresh(hass, refresh_token)`, `current_token(hass, entry)`. All async; all use `aiohttp_client.async_get_clientsession`. Token cache lives in `entry.data` (`access_token`, `refresh_token`, `expires_at`); `current_token` returns the cached token if `expires_at > time.time() + 30`, otherwise refreshes and persists via `hass.config_entries.async_update_entry`.
- `custom_components/hungry_machines/scheduler.py` — `fetch_today_schedule(hass, entry)` caches the HVAC schedule on `hass.data[DOMAIN]['schedule']`; `apply_current_slot(hass, entry)` writes that slot's targets to the configured climate entity via `hass.services.async_call('climate', 'set_temperature', ...)`. Both gracefully no-op on missing token/cache/entity rather than throwing.
- `custom_components/hungry_machines/readings.py` — `push_current_reading(hass, entry) -> bool` reads the configured climate entity, builds one sensor reading (`indoor_temp` from `current_temperature`, `target_temp` from `temperature`, `indoor_humidity` from `current_humidity`, `hvac_state` from `state.state.upper()` whitelisted to `{HEAT, COOL, OFF, FAN}` with `'OFF'` fallback), and POSTs `{readings: [reading]}` to `/api/v1/readings`. Returns `False` (and doesn't post) when the climate entity is unconfigured / missing / lacks `current_temperature`. Triggers reauth on 401. Wired to a 5-minute `async_track_time_interval` in `async_setup_entry`; unsub stored at `hass.data[DOMAIN]['readings_unsub']` and torn down explicitly in `async_unload_entry`.
- `custom_components/hungry_machines/config_flow.py` — three flows on one class: user (collects email/password/climate_entity, exchanges for tokens, stores ONLY tokens + email + climate in `entry.data`), reauth (re-prompts for password only when refresh fails), options (lets user change `climate_entity` post-setup without rotating tokens).
- `conftest.py` (project root) — installs minimal sys.modules stubs for `homeassistant.*`, `aiohttp`, `voluptuous` so the Python integration code can be imported during pytest runs without a real HA install. Tests under `custom_components/hungry_machines/tests/` rely on this — never try to `pip install homeassistant` for the test loop.

## EntityMap shape

```ts
interface EntityMap { climate?: string; weather?: string }
```

Stored under `hm_entity_map` in localStorage as JSON. Legacy four-key entries (`indoor_temp`, `outdoor_temp`, `power`, `weather`) are silently migrated on first read by `getEntityMap()` — the migration also rewrites the persisted JSON so subsequent reads are O(1).

If you add another entity field:

1. Extend the `EntityMap` interface.
2. Add a row to `ENTITY_FIELDS` in `hungry-machines-panel.ts` with the right `domain` (`'climate' | 'weather'` today; widen the union if you add e.g. `'sensor'`).
3. Update `migrateEntityMap` in `store.ts` to copy the new key through.
4. Test fixture in `tests/settings.test.ts` `HASS` constant must include at least one entity of the new domain plus an off-domain entity for filter-coverage.

## Patterns to preserve (specific to this repo)

- `customElements.define(...)` calls in `src/main.ts` are guarded with `customElements.get(...)` — preserve the guard, the bundle is reloaded by HA when other integrations re-register tags.
- `window.customCards` registration (only the two cards, not the panel) — must dedupe before pushing.
- Test fetch mocking: stub `globalThis.fetch` per-test with `vi.stubGlobal('fetch', vi.fn(...))`. Never call out to a real network.
- 48 × 30-min schedule shape is load-bearing across panel/cards; use `expandHourlyTo48` / `collapse48ToHourly` from `src/utils/hourly.ts` rather than reimplementing.
- Settings tab uses a draft-then-save pattern: change handlers mutate `_entityMapDraft` / `_zoneDraft` only; the `.settings-actions` bar's Save button is the single persistence path. `_isDirty()` drives the Save/Reset disabled state, and `_savedFlash` (cleared in `disconnectedCallback`) flashes the confirmation. New settings fields should follow the same draft → Save flow rather than auto-persisting on change.
- `<select>` options use `?selected=${id === selected}` alongside the parent's `.value` binding so the form reflects the saved value on remount under happy-dom — required for tests that simulate page reload.
- **Wrap fragment-level `${TemplateResult}` slots in an element.** Lit's HTML parser (under happy-dom) silently drops a child-content binding when `${someTemplateResult}` appears at fragment level between two sibling elements (e.g. `</label>\n      ${typeFields}\n      <div>`). The slot disappears from the compiled template, all later bindings shift by one, and you'll see things like a button's text rendering its own `@click` handler source. Workaround: always wrap such inserts in a host element — `<div>${typeFields}</div>` — so the slot lives inside an element start/end tag pair rather than at fragment level.

## Python integration patterns

- **Tests run with sys.modules stubs, not real HA.** Project-root `conftest.py` pre-installs lightweight stubs for `homeassistant.*` + `aiohttp.ClientError` + `voluptuous.{Schema, Required, Optional, In}`. This means pytest can import `custom_components/hungry_machines/__init__.py` (which has top-level HA imports) without `pip install homeassistant`. Tests use `MagicMock` / `AsyncMock` for hass, ConfigEntry, sessions, etc., and `patch.object(auth.aiohttp_client, "async_get_clientsession", ...)` to drive responses.
- **Async-context-manager mock pattern.** `aiohttp` calls look like `async with session.post(...) as resp: data = await resp.json()`. Mock with: `response = MagicMock(status=200, json=AsyncMock(return_value=body))`, `cm = MagicMock(__aenter__=AsyncMock(return_value=response), __aexit__=AsyncMock(return_value=False))`, `session.post = MagicMock(return_value=cm)`. Helpers `_mock_response` + `_session_with_post`/`_session_with_get` live in the test files and should be reused.
- **Password is never persisted.** `entry.data` writes go through `config_flow.py`'s `async_create_entry(data=...)` and `async_update_entry(data=...)` — those builders only spread {email, access_token, refresh_token, expires_at, climate_entity}. Never add a `CONF_PASSWORD` to those dicts. The grep guard `grep -c 'password' custom_components/hungry_machines/__init__.py custom_components/hungry_machines/scheduler.py` must stay at 0; `auth.py` has password mentions only as a function param + JSON body of the POST.
- **`hass.data[DOMAIN]` shape.** Three domain-level keys plus per-entry data: `_frontend_registered` (process-lifetime guard for static-path registration), `schedule` (the cached HVAC schedule), `readings_unsub` (the 5-min readings poller's unsub callable; popped + called in `async_unload_entry`). Per-entry: `<entry.entry_id>` -> `{'unsub': [callbacks]}` for `async_track_time_change` subscriptions (the 5:05 morning refresh + the every-30-min slot apply). The readings poller intentionally stores its unsub at the domain level instead of in the per-entry `unsub` list to avoid double-tear-down.
- **Test import style.** `from hungry_machines import auth` (not `from custom_components.hungry_machines import auth`). Pytest's __init__.py walk-up makes `custom_components/` the sys.path root since it has no `__init__.py`.
- **`/api/v1/schedules` shape: schedule arrays are nested.** The API returns `{appliances: [{appliance_type, schedule: {intervals, high_temps, low_temps}, savings_pct, source, ...}]}` — the temp arrays live under `appliance.schedule.*`, NOT directly on the appliance entry. `scheduler.fetch_today_schedule` reads `hvac.get('schedule') or {}` and pulls high_temps/low_temps off that. v0.3.0–v0.3.3 had a silent bug where the path was one level too high; the cache was always empty and no setpoint was ever applied. Tests in `test_scheduler.py` cover the nested happy path, the legacy flat-shape regression marker (yields empty arrays), and the end-to-end fetch→apply chain. Future shape changes to the schedules contract should follow this same nested-fixture pattern.

## Build / verify primitives

```bash
npm test            # vitest (currently 104 frontend cases across 15 files)
npm run build       # rollup -> custom_components/hungry_machines/frontend/hungry-machines.js
npx tsc --noEmit    # type check
python3 -m pytest custom_components/hungry_machines/tests/ -v   # 30 Python cases (auth + scheduler + readings + config_flow)
python3 -m py_compile custom_components/hungry_machines/{__init__,auth,scheduler,readings,config_flow,const}.py
./scripts/release.sh
```

`custom_components/hungry_machines/frontend/hungry-machines.js` is gitignored; CI rebuilds it on tag push.
