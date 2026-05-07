# Hungry Machines — Home Assistant Integration

Hungry Machines optimizes when your home runs its biggest energy users — HVAC, EV charger, home battery, water heater — to shift load into the cheapest hours of your time-of-use rate plan, while keeping the comfort and charge constraints you set.

This package adds the Hungry Machines control surface to Home Assistant: a sidebar panel for managing schedules and constraints, plus two Lovelace cards for at-a-glance status. Sign in with the same account you create at [hungrymachines.io](https://hungrymachines.io), and your dashboard mirrors the schedules our backend generates each night.

Learn more at **[hungrymachines.io](https://hungrymachines.io)**. Questions: [info@hungrymachines.io](mailto:info@hungrymachines.io).

---

## What you get

- **`hungry-machines-panel`** — full-page sidebar entry. Sign in, see today's optimized schedule for every appliance you've registered, edit the comfort and charge constraints the optimizer respects, and choose your time-of-use pricing zone.
- **`hm-thermostat-card`** — Lovelace card with current indoor/outdoor temperature, today's HVAC schedule, and a savings-level slider.
- **`hm-savings-card`** — Lovelace card with today's average savings, current home power draw, and the next scheduled appliance run.

All three share one sign-in. Sign in once via the panel and the cards activate everywhere on your dashboard — your token persists in your browser's localStorage.

## How it works

1. You connect your appliances and preferences via the panel inside Home Assistant.
2. Throughout the day, your Home Assistant pushes a sensor reading (indoor temperature, HVAC state, target setpoint, humidity) to the Hungry Machines API every 5 minutes. The optimizer uses this stream to fit a per-home thermal model — without it, no real optimization is possible and the backend falls back to flat defaults.
3. Each night, the Hungry Machines API fetches a 24-hour weather forecast and your time-of-use rates, then runs an optimization that picks operating intervals to minimize cost while staying inside your comfort and charge constraints.
4. Your Home Assistant pulls the resulting schedule the next morning and applies the setpoints on every 30-minute boundary throughout the day. The panel and cards in this package show what's running, what's coming next, and what you'll pay.

The optimization itself (per-home thermal models, HVAC scheduling, EV/battery load-shifting, water-heater control) lives entirely in the backend. This package is the user-facing window into it.

## Requirements

- Home Assistant with [HACS](https://hacs.xyz/docs/setup/download) installed.
- A Hungry Machines account — sign up at [hungrymachines.io](https://hungrymachines.io).
- At least an indoor temperature sensor and a home power sensor in HA. You'll map them in the panel's **Settings** tab after sign-in.

---

## Install

No `configuration.yaml` editing required. Five steps, all from the Home Assistant UI.

### Step 1 — Create your Hungry Machines account

Go to **[hungrymachines.io](https://hungrymachines.io)** and sign up. Confirm your email when the verification message arrives. The email and password you set there are what you'll use to sign in inside Home Assistant.

### Step 2 — Add the integration to HACS

1. In Home Assistant, open **HACS → ⋮ (top right) → Custom repositories**.
2. Add `https://github.com/hungrymachines/energy-dashboard` with **Type: Integration**.
3. Search for **Hungry Machines** in HACS and click **Download**.
4. Restart Home Assistant when HACS prompts you.

### Step 3 — Add the integration

1. Open **Settings → Devices & Services → Add Integration**.
2. Search for **Hungry Machines** and click it.
3. Enter your **hungrymachines.io email and password** (the same credentials you use on the website and inside the panel) and pick the **HVAC climate entity** that should follow the optimized schedule. Click **Submit**.

   Your password is sent once to `api.hungrymachines.io` so the integration can obtain access + refresh tokens. **Only the tokens** are persisted in Home Assistant — your password is never stored locally. If your tokens ever stop working, Home Assistant will prompt you to re-enter your password to refresh them.

A **Hungry Machines** entry now appears in your sidebar, and the two Lovelace cards become available in the dashboard card picker. The integration also begins two background tasks: it polls the climate entity every 5 minutes and pushes a sensor reading to the API (so the optimizer can learn from how your home responds), and it fetches today's optimized HVAC schedule each morning and writes the targets to the climate entity on every 30-minute boundary.

### Step 4 — Sign in to the panel

Click the **Hungry Machines** entry in the sidebar. Enter the same hungrymachines.io email and password to load your dashboard — today's optimized schedules for whatever appliances you've registered, plus the constraint editor and Settings tab.

### Step 5 — Add the cards (optional)

The panel is the primary surface; the cards are extras for your existing dashboards. In any Lovelace dashboard, click **Add card → Search "Hungry Machines"**, then fill in the entity IDs that match your home:

```yaml
type: custom:hm-thermostat-card
entities:
  indoor_temp: sensor.living_room_temp
  outdoor_temp: sensor.outside_temp
  hvac_action: sensor.hvac_action
```

```yaml
type: custom:hm-savings-card
entities:
  power: sensor.home_power
```

Sign-in is shared with the panel — once you've signed in, the cards light up immediately.

---

## Configuration

Everything you'd expect to tune lives inside the panel's **Settings** tab:

- **Home Assistant entities** — pick which `sensor.*` entities feed indoor/outdoor temperature and home power. The panel and cards both read this map.
- **Pricing zone** — choose your time-of-use rate plan (1–8 preset zones covering common US utilities, including SDG&E, ConEd, and Xcel). Hourly rate overrides are supported if your utility doesn't fit a preset.
- **Account** — sign out, or email [info@hungrymachines.io](mailto:info@hungrymachines.io) if you want your account deleted.

Comfort and charge constraints are edited per-appliance from the **Dashboard** — each appliance card has an **Edit constraints** button that opens a per-type editor:

- **HVAC** — base temperature, savings level (1 = tight ±2°F, 2 = moderate ±6°F, 3 = aggressive ±12°F), optimization mode (`cool`, `heat`, `auto`, `off`), and `time_away` / `time_home` (HH:MM, the times you typically leave and return). An optional **hourly comfort bands** override lets advanced users specify a per-hour low/high in °F across all 24 hours instead of the symmetric base±band — useful if your comfort needs change throughout the day in ways the base+savings-level abstraction can't capture.
- **EV charger** — target charge %, minimum charge %, current charge %, deadline time (HH:MM by which the target must be reached).
- **Home battery** — target charge %, minimum charge %, deadline time.
- **Water heater** — minimum and maximum tank temperature (°F).

## Manual install (without HACS)

If you don't use HACS:

1. Download `hungry_machines.zip` from the [latest GitHub release](https://github.com/hungrymachines/energy-dashboard/releases).
2. Unzip into your Home Assistant config at `custom_components/hungry_machines/` (the zip contains the integration's files; create the directory if it doesn't exist).
3. Restart Home Assistant.
4. Continue from **Step 3** above (Settings → Devices & Services → Add Integration).

## Uninstall

1. **Settings → Devices & Services**, click **Hungry Machines**, then the ⋮ menu, then **Delete**. The sidebar entry and Lovelace cards disappear.
2. To remove the package entirely, also remove it from HACS.

## Support

- **Account, billing, product questions:** [info@hungrymachines.io](mailto:info@hungrymachines.io)
- **Learn more:** [hungrymachines.io](https://hungrymachines.io)
- **Bug reports for this package:** [GitHub issues](https://github.com/hungrymachines/energy-dashboard/issues)

## For developers

This package is open-source — patches and forks welcome. Build from source (Node 20+):

```bash
npm install
npm run build      # → custom_components/hungry_machines/frontend/hungry-machines.js
npm test           # vitest suite
```

The Python integration is a thin shim that registers the bundled JS file as a Lovelace resource and registers the sidebar panel. All product logic lives in the TypeScript bundle. Architecture reference: [`structure.md`](structure.md).

## Regenerating the API types

`src/api/generated.ts` is produced by [`openapi-typescript`](https://www.npmjs.com/package/openapi-typescript) from the committed `openapi.snapshot.json`, which is itself produced from the FastAPI app object in the sibling `hungry-machines-api/` repo. When the backend lands a contract change, regenerate from the monorepo root:

```bash
cd ../hungry-machines-api && python -c "import json; from app.main import app; print(json.dumps(app.openapi(), indent=2))" > ../hungry-machines_base-frontend/openapi.snapshot.json && cd ../hungry-machines_base-frontend && npm run codegen && npm test
```

Commit the resulting `openapi.snapshot.json` and `src/api/generated.ts` deltas in the same PR as the consuming change. The snapshot pins to **committed master-branch API code**, not whatever is deployed on the VPS — that's the point. Live deployment can lag the generated types and contract tests will still tell you the truth about the wire format the frontend has agreed to.

`tests/contract.test.ts` enforces structural compatibility between the hand-typed wrappers in `src/api/*.ts` and the generated paths bundle: each interface (e.g. `Preferences`, `RatesResponse`, `Appliance`, `HvacScheduleResponse`, `SchedulesResponse`, `UserMe`, `Session`, `ApplianceSchedule`) has a module-scope `extends` assertion against `paths['<endpoint>']['<method>']['responses']['200']['content']['application/json']`. The drift gate is **`npm run check:contract`** (alias for `tsc --noEmit`); the runtime vitest case in the same file is just a placeholder so the file is counted in `npm test`. Run `npm run check:contract` before you push when changing `src/api/*.ts` or `openapi.snapshot.json`. CI runs it on every push and PR to `master` via `.github/workflows/contract.yml`.

## Changelog

- **v2.0.0** — feat: closed control loop across every registered appliance. Per-appliance entity_id (and optional sensor entities) is now picked at "Add appliance" time inside the panel and persisted to Supabase, replacing the integration's old single-climate-entity config flow and the panel's localStorage entity_map. The readings poller iterates appliances and routes per-type (HVAC home reading → `/api/v1/readings`; EV/battery/water_heater per-appliance → `/api/v1/appliances/{id}/readings` with optional SoC / tank-temp aux sensor reads). The scheduler applies HVAC via `climate.set_temperature` and the rest via `switch.turn_on`/`turn_off`. New daily 03:30 UTC weather pusher reads the user's selected `weather.*` entity (now persisted via PATCH /auth/me) and POSTs the forecast so the API's nightly optimizer prefers it over Open-Meteo. **Breaking config change** — appliances added on v1.x lack `entity_id` and will need to be deleted + re-added once on v2.0; the config flow drops the climate-entity question entirely.
- **v1.1.2** — fix: readings poller is now scheduled with an `async def` callback so HA awaits it on the event loop. The previous sync-def + `hass.async_create_task` pattern fired from a worker thread, which HA 2024.x raises as `RuntimeError: ... calls hass.async_create_task from a thread other than the event loop`. Symptom on v1.1.1: every 5-min tick logged the error and dropped the reading. Fixed; readings now flow. fix: the bundled JS is now served at `/hungry_machines/hungry-machines.js?v=<version>` so browsers auto-bust their cache on every release. Previously the URL had no query string, so even after HACS replaced the bundle on disk, browsers kept serving the previously-cached copy until the user manually hard-refreshed the panel — now updates take effect immediately on the next page load after restart.
- **v1.1.1** — fix: HVAC editor save now updates the panel's cached preferences immediately, so reopening the editor reflects the saved value without a full reload. feat: readings poller logs at INFO when it skips a tick (missing entity / no `current_temperature` attribute / etc.), so misconfigurations are debuggable from `home-assistant.log` without enabling debug-level logging.
- **v1.1.0** — Initial v1 release matching the post-Phase-1 backend: per-appliance constraints persisted, per-appliance schedule endpoint returns the documented shape, OpenAPI codegen + contract test infrastructure, full panel HVAC editor (`time_away` / `time_home` / hourly comfort bands).
- **v1.0.0** — feat: poll the configured climate entity every 5 minutes and push readings to the API; the optimizer now has data to learn from.
- **v0.3.4** — Fix: schedule applier was caching empty arrays, no setpoints were ever applied (regression from v0.3.0). The applier now correctly reads `appliance.schedule.high_temps` / `appliance.schedule.low_temps` from `/api/v1/schedules` instead of looking one level too high on the appliance entry itself.

## License

MIT — see [`LICENSE`](LICENSE).
