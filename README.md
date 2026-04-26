# Hungry Machines — Home Assistant Frontend

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
2. Each night, the Hungry Machines API fetches a 24-hour weather forecast and your time-of-use rates, then runs an optimization that picks operating intervals to minimize cost while staying inside your comfort and charge constraints.
3. Your Home Assistant pulls the resulting schedule the next morning and applies the setpoints. The panel and cards in this package show what's running, what's coming next, and what you'll pay.

The optimization itself (per-home thermal models, HVAC scheduling, EV/battery load-shifting, water-heater control) lives entirely in the backend. This package is the user-facing window into it.

## Requirements

- Home Assistant with [HACS](https://hacs.xyz/docs/setup/download) installed.
- A Hungry Machines account — sign up at [hungrymachines.io](https://hungrymachines.io).
- At least an indoor temperature sensor and a home power sensor in HA. You'll map them in the panel's **Settings** tab.

---

## Install

### Step 1 — Create your Hungry Machines account

Go to **[hungrymachines.io](https://hungrymachines.io)** and sign up. Confirm your email when the verification message arrives. The email and password you set there are what you'll use to sign in inside Home Assistant.

### Step 2 — Add the package to HACS

1. In Home Assistant, open **HACS → Frontend → ⋮ (top right) → Custom repositories**.
2. Add `https://github.com/hungrymachines/energy-dashboard` with **Type: Dashboard**.
3. Search for **Hungry Machines** in HACS and click **Download**.
4. Restart Home Assistant (or reload Lovelace resources under **Settings → Dashboards → Resources**).

### Step 3 — Add the panel

Edit `configuration.yaml` and add:

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

Restart Home Assistant. A **Hungry Machines** entry appears in your sidebar.

### Step 4 — Sign in

Click the new sidebar entry. Enter the email and password you created at [hungrymachines.io](https://hungrymachines.io). That's it — the dashboard now shows today's optimized schedules for whatever appliances you've registered.

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

The cards stay in a "Sign in from the Hungry Machines panel" stub state until you've signed in once via the panel — the token is shared, so signing in once activates everything.

---

## Configuration

Everything you'd expect to tune lives inside the panel's **Settings** tab:

- **Home Assistant entities** — pick which `sensor.*` entities feed indoor/outdoor temperature and home power. The panel and the cards both read this map.
- **Pricing zone** — choose your time-of-use rate plan (1–8 preset zones covering common US utilities, including SDG&E, ConEd, and Xcel). Hourly rate overrides are supported if your utility doesn't fit a preset.
- **Account** — sign out, or email [info@hungrymachines.io](mailto:info@hungrymachines.io) if you want your account deleted.

Comfort and charge constraints (HVAC high/low temperature ranges, EV target state-of-charge, battery reserve, water-heater setpoint, etc.) are edited per-appliance in the panel's **Constraints** tab.

## Manual install (without HACS)

If you don't use HACS:

1. Download `hungry-machines.js` from the [latest GitHub release](https://github.com/hungrymachines/energy-dashboard/releases).
2. Copy it into your Home Assistant config directory at `/config/www/hungry-machines.js`.
3. Under **Settings → Dashboards → Resources**, add `/local/hungry-machines.js` with **Resource type: JavaScript module**.
4. Use `module_url: /local/hungry-machines.js` in the `panel_custom` block above (instead of the `/hacsfiles/...` path).
5. Restart Home Assistant and hard-reload your browser tab.

---

## Support

- **Account, billing, product questions:** [info@hungrymachines.io](mailto:info@hungrymachines.io)
- **Learn more:** [hungrymachines.io](https://hungrymachines.io)
- **Bug reports for this package:** [GitHub issues](https://github.com/hungrymachines/energy-dashboard/issues)

## For developers

This package is open-source — patches and forks welcome. Build from source (Node 20+):

```bash
npm install
npm run build      # → dist/hungry-machines.js
npm test           # vitest suite
```

Architecture reference: [`structure.md`](structure.md). The bundle is a single ESM file built with Rollup; every custom element ships in `dist/hungry-machines.js`.

## License

MIT — see [`LICENSE`](LICENSE).
