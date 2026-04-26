# Hungry Machines — Home Assistant Frontend

Home Assistant custom panel + two Lovelace cards that talk to the [Hungry Machines](https://hungrymachines.io) API. Sign in inside HA, see today's optimized schedules for your HVAC, EV charger, home battery, and water heater, and edit the constraints the nightly optimizer uses — without leaving your dashboard.

## Overview

Hungry Machines is a home energy optimization service. A backend at `api.hungrymachines.io` generates nightly operating schedules that shift your flexible loads into cheaper time-of-use hours. This package ships the client half:

- **`hungry-machines-panel`** — full-page custom panel with a login gate, a dashboard showing per-appliance schedules (rate-colored 48-interval timeline), a per-appliance constraint editor, and a settings view (entity mapping, pricing zone, account).
- **`hm-thermostat-card`** — standalone Lovelace card with current indoor/outdoor temp, today's optimized HVAC schedule chart, and a savings-level slider.
- **`hm-savings-card`** — standalone Lovelace card showing today's average savings percentage, current home power draw, and the next scheduled device run.

All three are packaged as a single JavaScript bundle (`hungry-machines.js`) suitable for HACS distribution.

Learn more at [hungrymachines.io](https://hungrymachines.io).

## Installation

### HACS (Custom Repository)

1. In Home Assistant, open **HACS → Frontend → ⋮ (top right) → Custom repositories**.
2. Add the repository URL for this package with **Category: Lovelace**.
3. Search for "Hungry Machines" in HACS and install it.
4. Restart Home Assistant (or reload resources under **Settings → Dashboards → Resources**).

### Manual install (fallback)

1. Build the bundle locally (see Developer notes) or download `hungry-machines.js` from a release.
2. Copy `dist/hungry-machines.js` into your HA config directory at `/config/www/hungry-machines.js`.
3. Under **Settings → Dashboards → Resources**, add:
   - URL: `/local/hungry-machines.js`
   - Resource type: **JavaScript module**
4. Hard-reload the browser tab.

## Panel setup

Add the panel to `configuration.yaml`:

```yaml
panel_custom:
  - name: hungry-machines-panel
    sidebar_title: Hungry Machines
    sidebar_icon: mdi:lightning-bolt
    url_path: hungry-machines
    module_url: /hacsfiles/hungry-machines-hacs/hungry-machines.js
    embed_iframe: false
    trust_external_script: false
```

If you installed manually, use `module_url: /local/hungry-machines.js` instead.

Restart Home Assistant. A new **Hungry Machines** entry appears in the sidebar.

## Card examples

Both cards auto-register with the Lovelace card picker (search "Hungry Machines") once the resource is loaded. YAML examples:

### Thermostat card

```yaml
type: custom:hm-thermostat-card
entities:
  indoor_temp: sensor.living_room_temp
  outdoor_temp: sensor.outside_temp
  hvac_action: sensor.hvac_action
```

### Savings card

```yaml
type: custom:hm-savings-card
entities:
  power: sensor.home_power
```

Both cards fall back to a "Sign in from the Hungry Machines panel" stub until you authenticate once via the panel — tokens persist in `localStorage` and are shared across the panel and cards.

## Configuration

All configuration is handled in-panel under the **Settings** tab:

- **Home Assistant entities** — pick which HA entities feed the panel's temp/power/weather readings.
- **Pricing zone** — choose your time-of-use pricing zone (1–8). Saves directly to the API.
- **Account** — sign out, or email `info@hungrymachines.io` to delete your account.

The cards' `entities:` keys are separate from the panel's entity map — the panel map is used by the dashboard view; the cards read the entities you pass in their YAML config.

## Developer notes

Requirements: Node 20+ (22 recommended).

```bash
npm install
npm run build      # produce dist/hungry-machines.js
npm test           # run vitest suite
npm run dev        # rollup watch mode
```

Project layout:

- `src/api/*.ts` — typed API client (`apiFetch` + wrappers for auth/appliances/schedules/preferences/rates).
- `src/store.ts` — auth store (tokens in `localStorage`, subscribable).
- `src/panel/hungry-machines-panel.ts` — the full-page panel element.
- `src/cards/thermostat-card.ts`, `src/cards/savings-card.ts` — the two Lovelace cards.
- `src/ui/*.ts` — shared Lit components (login form, schedule chart, constraint editor).
- `src/styles/tokens.css` + `src/styles/tokens.ts` — brand palette + Lora/Lato font tokens.
- `tests/*.test.ts` — vitest + happy-dom.

One-shot release helper:

```bash
./scripts/release.sh
```

This runs `npm ci && npm run build` and prints the size of the emitted bundle.

## License

Same as the parent Hungry Machines repository.
