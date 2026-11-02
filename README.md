# Hungry Machines — Home Assistant Integration

Outsmart your electric bill - Hungry Machines Energy provides an energy management system that shifts HVAC, EV charging, home batteries, and other electric loads to cheaper hours for homes and buildings with time-of-use or dynamic electricity rates. It keeps the comfort and charge constraints you set.

This package adds the Hungry Machines control surface to Home Assistant: a sidebar panel for managing schedules and constraints, plus two Lovelace cards for at-a-glance status. Sign in with the same account you create at [hungrymachines.io](https://hungrymachines.io), and your dashboard shows the schedules generated each night.

Learn more at **[hungrymachines.io](https://hungrymachines.io)**.

See how it works and experience the benefits in the [online game](https://hungrymachines.io/feed-your-hungry-machines/).

Questions: [info@hungrymachines.io](mailto:info@hungrymachines.io).

![Hungry Machines HVAC card — the optimizer's predicted indoor-temperature trajectory (solid line) tracked against your high/low comfort limits (dashed) over the day's electricity prices (bars), with the day's savings shown above.](images/hvac-card.png)

![The Hungry Machines panel dashboard — one card per registered appliance (HVAC, EV charger, home battery, water heater, solar). Each shows its optimized schedule, today's savings, and per-appliance constraint controls, with an "Add another appliance" button to register more.](images/base-dashboard.png)

---

## What you get

- **`hungry-machines-panel`** — full-page sidebar entry. Sign in, then **add the appliances you want optimized** (one or more HVACs, plus an EV charger, home battery, water heater, or solar array), map each one to its Home Assistant entities, edit the comfort and charge constraints the optimizer respects, choose your pricing, and review a per-appliance diagnostics view that flags sensor or connection problems.
- **`hm-thermostat-card`** — Lovelace card with current indoor/outdoor temperature, an optimization chart (your comfort limits + the optimizer's predicted temperature trajectory over a 24-hour price backdrop), and a savings-level slider. Pin it to one HVAC with `appliance_id` when you run more than one.
- **`hm-savings-card`** — Lovelace card with today's estimated savings, current home power draw, and the next scheduled appliance run. Scope it to a single HVAC with `appliance_id`, or leave it whole-home.

All three share one sign-in. Sign in once via the panel and the cards activate everywhere on your dashboard — your token persists in your browser's localStorage. Each card also shows a small health badge when its underlying sensors look stale, so you're never silently optimizing on bad data.

## How it works

1. You register your appliances and set your preferences in the panel inside Home Assistant. Each HVAC is mapped to its own climate entity (and optional indoor-temperature, humidity, and power sensors); EV chargers, batteries, and water heaters are mapped to their own entities. Solar has no control entity — nothing to switch — but you can point it at a production sensor, and the forecast then learns from your array's real output instead of its nameplate rating.
2. Throughout the day, your Home Assistant captures readings from each appliance (HVAC: indoor temperature, HVAC state and mode, fan, target setpoint, humidity, power) and pushes them to the Hungry Machines Optimization API. If you mapped an indoor-temperature sensor to an HVAC, that sensor is the temperature Hungry Machines models, optimizes and holds inside your band; without one it uses the thermostat's own reading. The optimizer uses this stream to fit a **per-HVAC thermal model** — without it, the backend falls back to default rates and the optimization is significantly less exact. On the first warm day after you add an HVAC, the backend runs a short one-time **calibration window** (a forced morning cooling pattern) so it can learn how that unit responds; the panel shows a banner while it's running, with a **Skip** option.
3. Each night, Hungry Machines resolves a 24-hour weather forecast and your rates, then runs an optimization per appliance that picks operating intervals to minimize cost while staying inside your comfort and charge constraints.
4. Your Home Assistant pulls the resulting schedule and, on every 30-minute boundary, applies it to each appliance. For HVAC that means setpoint, mode, and fan; for EV/battery/water heater it switches the device on or off. The plan sets a target for the room your sensor sits in, not for the thermostat's dial. Between those boundaries a check runs every five minutes: when the room reads more than half a degree off its target, the setpoint moves one degree toward closing the gap, and it repeats until the room lands where the plan asked. Your comfort range bounds every one of those commands, and the comfort check stays the safety net at the edges. The panel and cards in this package show what's running, what's coming next, and how much you save.

Savings figures are estimates until a metered baseline exists: each one is the cost the model predicts a naive thermostat would have run up, minus the plan Hungry Machines chose, both priced on the curve that plan was built against.

The optimization itself (per-HVAC thermal models, HVAC scheduling, EV/battery load-shifting, water-heater control, solar coupling) lives in the backend. You can visit the [online game](https://hungrymachines.io/feed-your-hungry-machines/) to experience how it works. This package is the user-facing window into it.

## Requirements

- Home Assistant with [HACS](https://hacs.xyz/docs/setup/download) installed.
- A Hungry Machines account — sign up at [hungrymachines.io](https://hungrymachines.io).
- For each HVAC you want optimized, a `climate.*` entity in Home Assistant. A power sensor, a dedicated indoor-temperature sensor, and a humidity sensor are optional but improve the model (you map all of these per-appliance when you add it in the panel). A mapped indoor-temperature sensor becomes the room Hungry Machines optimizes for, so put it where you actually sit. A `weather.*` entity is optional too; pick it in the panel's **Settings** tab to feed the optimizer your local forecast (the backend falls back to generic data if you don't).

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
3. Enter your **hungrymachines.io email and password** (the same credentials you use on the website and inside the panel) and click **Submit**. That's the only thing the config flow asks for — you pick your appliances and their entities later, in the panel (Step 4).

A **Hungry Machines** entry now appears in your sidebar, and the two Lovelace cards become available in the dashboard card picker. The integration also begins its background tasks: it captures readings from each registered appliance (buffered and pushed periodically, so the optimizer math can learn how your home responds), once a day it pushes your weather forecast, and each morning it fetches today's optimized schedules and applies them to the appliances.

### Step 4 — Sign in and add your appliances

Click the **Hungry Machines** entry in the sidebar and enter the same hungrymachines.io email and password to load your dashboard. The first time in, the dashboard is empty — use **Add appliance** to register each device you want optimized:

- Pick a type (HVAC, EV charger, home battery, water heater, or solar).
- For HVAC, choose the `climate.*` entity it controls and, optionally, dedicated indoor-temperature / humidity / power sensors. With the optimization mode on Auto, Hungry Machines switches the thermostat between heat and cool for you. On Heating only or Cooling only, keep the thermostat in the same mode, or its setting wins and the log records an error (see [Thermostat modes](#thermostat-modes)). The indoor-temperature sensor is the one Hungry Machines models, optimizes and holds inside your band — leave it empty to use the thermostat's own reading. Add a card per HVAC if you have more than one — each gets its own thermal model and schedule.
- For EV charger / battery / water heater, choose the switch and any state-of-charge or tank-temperature sensor.
- For solar, enter your system size, tilt, and azimuth, and optionally pick a **production sensor** — a `sensor.*` reporting your inverter's or plug's instantaneous output in W or kW (not an energy `kWh` sensor). Solar has no switch to control; the sensor is what lets Hungry Machines learn your array's real output and shading instead of estimating from the nameplate rating.

Each appliance card then shows today's optimized schedule, an **Edit constraints** button, and a per-appliance pause toggle. You can edit or delete an appliance at any time.

### Step 5 — Add the cards (optional)

The panel is the primary surface; the cards are extras for your existing dashboards. In any Lovelace dashboard, click **Add card → Search "Hungry Machines"**, then fill in the entity IDs that match your home:

```yaml
type: custom:hm-thermostat-card
# Optional: pick a specific HVAC when you have more than one registered.
# With exactly one HVAC the card auto-resolves and this can be omitted.
# appliance_id: 11111111-2222-3333-4444-555555555555
entities:
  indoor_temp: sensor.living_room_temp
  outdoor_temp: sensor.outside_temp
  hvac_action: sensor.hvac_action
```

```yaml
type: custom:hm-savings-card
# Optional: scope the savings figure (and the integration-health badge)
# to one HVAC. Omitted → whole-home average + next scheduled run.
# appliance_id: 11111111-2222-3333-4444-555555555555
entities:
  power: sensor.home_power
```

Sign-in is shared with the panel — once you've signed in, the cards light up immediately.

---

## Configuration

Everything you'd expect to tune lives inside the panel's **Settings** tab:

- **Weather entity** — optionally pick the `weather.*` entity whose forecast is pushed to the optimizer each day. (Per-appliance HVAC sensor entities are chosen when you add the appliance, not here.)
- **Pricing source** — one section with two modes:
  - **Static (time-of-use zone)** — choose a preset rate plan from the catalog (the list covers common US utilities). If none fits, switch on **hourly rate overrides** and enter your own per-hour ¢/kWh. If you would like to add a new area or location, please contact us at [info@hungrymachines.io](mailto:info@hungrymachines.io). 
  - **Dynamic (changes daily)** — follow real-time and dynamic prices for a supported grid region instead of a fixed TOU schedule. Pick your **Region** (currently ComEd and Ameren Illinois) and a **delivery charge estimate** (a flat ¢/kWh added to the wholesale price to approximate delivery, capacity, and taxes). ComEd customers can additionally pick their **Delivery plan** — the ComEd Delivery Time-of-Day rate — which prefills four editable per-period distribution prices (Morning, Mid-Day Peak, Evening, Overnight) from the published rate table for that plan; check them against the Distribution Facility Charge lines on your own bill and edit any that differ, so the per-half-hour distribution charge follows your own numbers instead of an estimate. With a plan chosen, the flat delivery-charge field then only needs to cover the small non-delivery residual (taxes, supply riders), around 2¢/kWh. The Region, Delivery plan, period-price, and delivery-charge fields only appear when Source = Dynamic (Delivery plan and period prices only appear once your utility offers a plan). If you have another area or location to add, please contact us at [info@hungrymachines.io](mailto:info@hungrymachines.io). 
  - **Export rate** — what your utility pays for power you send back to the grid. ComEd and Ameren Illinois customers choose by when net metering started. From 2025 on, or with a solar rebate, exports earn supply and transmission without delivery; this is the default. Before 2025 with no rebate, exports earn the full price. Other live hourly prices choose between the market price alone and the full price. Other fixed and time-of-use plans default to the same prices we use to plan your devices. You can also enter your own hourly rates, or say you are not paid for exports. A chart shows today's export price against what you pay, and the solar card plots it against your generation. The optimizer values your solar surplus against this rate, so an appliance only soaks up daylight generation when running then beats selling that power.
- **Temperature units** — show temperatures in °F, °C, or follow Home Assistant's setting (the default). The choice is saved on your account and changes the panel and every card at once, with no reload. It never moves your comfort range: the service and your stored bands stay in °F, and the panel converts only what it shows. This is separate from a second conversion that always runs, between Home Assistant's own unit and °F, so a metric Home Assistant works whichever unit you pick. Requires a backend that serves `temperature_unit` on `/api/v1/preferences`.
- **Time zone** — plans and prices line up with this zone, so it should match where your home is. A new account takes Home Assistant's zone, and Settings shows it so you can change it. A change applies from your next nightly plan.
- **Send feedback** — a short form to send a comment, bug report, or feature request to the team without leaving Home Assistant.
- **Account** — sign out, or email info@hungrymachines.io if you want your account deleted.

Comfort and charge constraints are edited per-appliance from the **Dashboard** — each appliance card has an **Edit constraints** button that opens a per-type editor, plus a **pause toggle** that excludes that one appliance from optimization without deleting it (there's also a master optimization switch that pauses everything):

- **HVAC** — a low/high comfort limit for every one of the 24 hours, in your chosen unit. That table is what the panel edits and what every save sends. Beneath it a **Defaults** group holds base temperature, savings level (1 = tight ±2°F, 2 = moderate ±6°F, 3 = aggressive ±12°F), optimization mode (`cool`, `heat`, `auto`, `off`), and `time_away` / `time_home` (HH:MM, the times you typically leave and return). Those four shape the table whenever you press **Reset to defaults**, and the backend derives the same shape for any home that has never edited an hour.
- **EV charger** — target charge %, minimum charge %, current charge %, deadline time (HH:MM by which the target must be reached).
- **Home battery** — target charge %, minimum charge %, deadline time.
- **Water heater** — minimum and maximum tank temperature.
- **Solar** — no constraints to set, so the card carries **Edit appliance** instead: system size, tilt, azimuth, and the optional production sensor. The card shows the day's forecast generation curve, where that forecast came from (nameplate estimate, a forecast for your tilt and azimuth, or learned from your production sensor), the expected kWh, and — when you have entered export rates — the surplus and what it earns.

## Manual install (without HACS)

If you don't use HACS:

1. Download `hungry_machines.zip` from the [latest GitHub release](https://github.com/hungrymachines/energy-dashboard/releases).
2. Unzip into your Home Assistant config at `custom_components/hungry_machines/` (the zip contains the integration's files; create the directory if it doesn't exist).
3. Restart Home Assistant.
4. Continue from **Step 3** above (Settings → Devices & Services → Add Integration).

## Uninstall

1. **Settings → Devices & Services**, click **Hungry Machines**, then the ⋮ menu, then **Delete**. The sidebar entry and Lovelace cards disappear.
2. To remove the package entirely, also remove it from HACS.

## Checking that it's working

Open **Settings → System → Logs** in Home Assistant and search for `Hungry Machines`. Problems appear there as warnings when they start and once a day while they last. Good news is in the full log, under **Load full logs**: when an upload, a solar production sensor, today's plan, the weather push, or a thermostat mode starts working or recovers, plus one line each hour listing what was uploaded.

The integration reads your devices every 5 minutes and uploads once an hour, at 2 minutes past. If an upload fails, the readings wait in memory and go up at the next hourly upload. A Home Assistant restart clears any readings still waiting.

## Thermostat modes

Set the device's optimization mode under **Edit constraints**. It decides who chooses between heating and cooling:

- **Auto:** Hungry Machines chooses. It picks heating or cooling each day from the forecast and switches your thermostat to match, even if the thermostat is in its own Auto mode. If the room leaves your comfort range the other way, say a warm afternoon on a heating day, it switches the thermostat to bring the room back. A thermostat you turn off stays off, and the log records an error.
- **Heating only or Cooling only:** you choose. Keep your thermostat in the same mode. If they conflict, including a thermostat that is off or in its own Auto mode, **the thermostat's setting wins**. Hungry Machines sends it nothing, not even a comfort correction, and logs an error naming both modes.
- **Off:** Hungry Machines leaves the thermostat alone.

If you turned on letting Hungry Machines control the mode, and on window units, it also turns the unit on and off through the day, so these checks don't apply.

**The one exception is the freeze floor.** If a room falls below 50 °F, Hungry Machines heats it to 52 °F, then puts the thermostat back the way it found it. This overrides the plan, a pause, and the thermostat's own setting, because pipes can freeze. It needs a unit with a heat mode, and it checks every 5 minutes while Home Assistant is running and has an appliance list from us. Hungry Machines never commands a setpoint below 50 °F.

Hungry Machines plans around electricity prices only. It does not price natural gas or choose a fuel: your thermostat still decides when to use a gas furnace or auxiliary heat.

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

The Python integration is a thin shim that registers the bundled JS file as a Lovelace resource and registers the sidebar panel. All product logic lives in the TypeScript bundle.


## Changelog

See the [Releases page](https://github.com/hungrymachines/energy-dashboard/releases).

## License

MIT — see [`LICENSE`](LICENSE).
