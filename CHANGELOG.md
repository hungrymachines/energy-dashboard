# Changelog

What's new in the Hungry Machines integration for Home Assistant. Update from HACS to get the latest release.

<!-- Each release has a `summary` comment under its date: a few plain lines for announcements. It does not show on GitHub. -->

## 3.13 — Setpoints that follow your room sensor, a quick comfort preset, and rebuilt cards

*November 13, 2026*

<!-- summary
- A unit whose own sensor reads differently from your room sensor is now set as far from the plan as it takes for your room sensor to read the planned temperature, up to 3 °F outside your comfort range.
- Quick preset fills the hourly comfort table from a base temperature, the times you leave and return, and a Tight, Default or Wide range.
- The thermostat card needs no setup, and the savings card lists each appliance with its own estimate and next run.
- Pausing from the panel takes effect within seconds.
-->

### Units that read the room differently from your sensor

A window unit or mini-split reads the room from its own built-in sensor, which can sit a degree or more from the room sensor you mapped to it. Set to 69 °F, such a unit stops at 69 °F on its own sensor while your room sensor still reads 71 °F. Your comfort range is about the room, so Hungry Machines now moves the unit's setpoint until your room sensor reads the planned temperature, in heating and cooling.

- The setpoint can sit up to 3 °F outside your comfort range. It leaves the range only while the unit's own behaviour shows the disagreement: idle while the room is short of its target, or still running while the room is past it.
- A unit that reaches that limit is flagged in its comfort settings. **Wider setpoint offset** raises the limit to 6 °F for that unit. You can also map a different temperature sensor, or widen the range.
- The comfort table marks any hours too narrow for a unit to hold and says how wide they need to be. It is advice and does not block saving.

### Quick preset

The HVAC editor fills the hourly comfort table in one step. Set a base temperature, the times you leave and return, and a Tight (±2 °F), Default (±5 °F) or Wide (±10 °F) range for the hours you are away. Every hour stays editable.

### Rebuilt dashboard cards

- **Thermostat card.** Shows the room temperature and what the thermostat is set to with no setup, draws today's comfort range, and says when a unit is paused, on an idle day or on a warm-up test.
- **Savings card.** Lists each appliance with its own estimate and its next scheduled run, and shows a sensor problem on the unit's row.
- Both reload the plan about every five minutes and link to the panel.

### Also in this release

- Pausing from the panel takes effect within seconds.
- The freeze floor is designed to return the thermostat to its earlier setpoint as well as its mode, including after a Home Assistant restart.
- Diagnostics names any unit whose readings have stopped or are not changing, and lists the sensor differences measured for each unit.

## 3.12 — Pools, hot tubs, and a form that finds your devices

*November 11, 2026*

<!-- summary
- Add a pool pump, and the plan places its daily hours in the cheapest half-hours of the window you allow.
- Add a hot tub with ready and eco temperatures and up to four soak times.
- Water heaters get a lowest planned temperature and a scheduled sanitize cycle.
- The add-appliance form suggests matching devices and fills in their sensors.
-->

### Pool pump

Add a pool pump as its own appliance. Tell it how many hours to run each day and the window you allow, and the plan places those hours in the cheapest half-hours of the window.

### Hot tub

Add a hot tub with a ready temperature, an eco temperature, and up to four soak times, each on the days of the week you choose. The tub drifts toward eco between soaks, and the plan is designed to have it back at ready before the next one. Its card plots the water temperature against both limits.

### Water heater: lowest temperature and sanitize cycle

- **Lowest temperature.** A temperature that plans are designed to keep the tank above, 120 °F by default.
- **Sanitize cycle.** Schedules heating the tank to a temperature you choose (140 °F by default) and holding it for an hour every two days, in the cheapest half-hours that fit. On by default, and it needs the tank's own thermostat set at least that high.
- The water heater card shows when the next cycle runs and whether the last one reached its temperature.

### Add appliances faster

- The entity picker groups likely matches under **Suggested**. Every other entity is still listed below.
- Pick a device and its temperature or battery sensor is filled in for you.
- The first step offers devices it recognized in your home, so a tub, pump or robot vacuum takes one tap to add.

### Also in this release

- **Run warm-up** button on each HVAC card schedules the one-time warm-up for the next suitable day.
- On heating days, an idle thermostat now stays in heat at the bottom of your comfort range instead of switching off, so the thermostat holds that temperature on its own if Home Assistant stops.
- Smoother comfort protection in narrow comfort ranges and in Auto mode.

## 3.11 — A comfort range for each day, and timed pauses

*November 9, 2026*

<!-- summary
- Set one comfort range for every day, one each for weekdays and weekends, or one for each day of the week.
- Pause one HVAC unit for 2, 4 or 6 hours. The plan takes it back when the time is up.
- Choose fixed or fitted chart scales.
- The solar card plots measured output against the forecast.
-->

### A comfort range for each day of the week

The HVAC editor has a new **Days** choice: one range for every day, one for weekdays and one for weekends, or one for each day. Each night's plan uses that date's range, and the dashboard chart and thermostat card follow today's.

### Pause a unit for 2, 4 or 6 hours

- Each HVAC card and the thermostat card have **Pause 2 h**, **Pause 4 h** and **Pause 6 h** buttons.
- A paused unit is yours. The card shows when the plan resumes, and **Resume now** ends the pause early.
- New `hungry_machines.pause` and `hungry_machines.resume` services do the same from an automation.
- The freeze floor still acts during a pause.

### Chart scales

A new **Chart scale** setting. Standard keeps each appliance's fixed range. Dynamic fits the chart to your comfort range and setpoints. Solar charts choose between your system size and the day's peak.

### Measured solar on the solar card

With a production sensor, the card plots today's measured output over the forecast, refreshed every 5 minutes, and shows the kWh you made so far against the forecast.

### 3.11.1

- The solar card shows whether your production sensor is connected: reporting, unavailable, missing, or not chosen.
- An evening change to your comfort settings now takes effect that night.

## 3.10 — Celsius, Auto mode, and idle days

*November 2, 2026*

<!-- summary
- Work in °F or °C, including on metric Home Assistant installs.
- Auto mode switches your thermostat between heating and cooling for each day's plan.
- On a mild day, no heating or cooling is planned.
- Simpler export rate choices for solar homes.
-->

### Choose °F or °C

Settings has a **Temperature units** selector: °F, °C, or Home Assistant's own setting. The panel, cards, charts and editors all show and accept the unit you choose. Metric Home Assistant installs are now supported.

### Auto mode chooses heating or cooling for you

With a device on **Auto**, Hungry Machines switches your thermostat to heating or cooling for each day's plan, based on how your own home responds to the weather. If the room leaves your comfort range the other way, it switches to bring the room back. Prefer to choose yourself? On **Heating only** or **Cooling only**, your thermostat's mode wins, and a thermostat you turn off is left off.

### Idle days

On a mild day, when your home should stay inside your comfort range with nothing running, no heating or cooling is planned. Comfort protection still steps in if the forecast turns out wrong.

### Freeze floor

If a room falls below 50 °F, Hungry Machines is designed to heat it to 52 °F and then return the thermostat to the mode it was in, even when optimization is paused. It is a backstop that works while Home Assistant is running, not a replacement for your thermostat's own freeze protection.

### Simpler export rates

Pick how your utility credits the solar power you send back: market price, your regular rates, your own 24 hourly rates, or no credit. ComEd and Ameren Illinois customers choose by when net metering started. The solar card now plots the export price.

### Also in this release

- **Time zone** in Settings keeps your plans and prices lined up with your local day.
- Home Assistant's log now says when uploads, your solar sensor, today's plan and each thermostat start working, fail or recover.
- Uploads recover on their own after a long outage.

## 3.9 — Home power limits and a simpler comfort table

*October 7, 2026*

<!-- summary
- Home power limits: a whole-home power cap, a limit on how many appliances run at once, and demand charges.
- The hourly comfort table is now the main comfort control.
- Plug-in and balcony solar arrays are read correctly.
-->

### Home power limits

A new Settings section: how many appliances may run at once, a whole-home power cap, an always-on reserve, and a demand charge with an optional on-peak window. Leave any field blank for no limit. HVAC is planned first, and your other appliances are planned around it.

### The hourly comfort table is now the main control

Settings shows one low and high limit for each of the 24 hours. **Reset to defaults** refills the table with a pre-cooling shape: a tight range overnight and a wider one through the day. Your saved limits load as before.

### Plug-in and balcony solar

Smart plugs on plug-in inverters are now read correctly, and the solar picker names plug-in and balcony arrays.

### 3.9.1 and 3.9.2

- The integration carries its own icon on Home Assistant 2026.3 and later.
- The command check moved beside Sensor health in Diagnostics, and a paused unit no longer triggers a warning.
- New accounts start in your Home Assistant time zone.

## 3.8 — Steadier room temperatures

*September 10, 2026*

<!-- summary
- The setpoint now moves in small steps through the day to keep the room on its planned temperature.
- Comfort protection steps gently toward your range.
-->

- Hungry Machines now adjusts the setpoint in small steps through the day to keep the room on its planned temperature.
- Comfort protection steps gently toward your range instead of jumping across it.
- Readings keep flowing on a slow connection.

## 3.7 — Your room sensor leads

*September 10, 2026*

<!-- summary
- Your room sensor is now the temperature Hungry Machines plans around.
- Savings read as an estimate, with the basis on hover.
-->

- If you chose a room sensor, it is now the temperature Hungry Machines plans around and checks against, ahead of the thermostat's own reading.
- Savings read as "est. N% savings today", with the basis on hover.
- Diagnostics shows the integration version.

## 3.6 — Price spike guard

*September 7, 2026*

<!-- summary
- On a real-time rate such as ComEd Hourly Pricing, a developing price spike re-plans the rest of your day.
- Turn it off any time in Settings.
-->

On a real-time rate such as ComEd Hourly Pricing, prices sometimes run far above the day-ahead forecast. When a spike develops, Hungry Machines re-plans the rest of your day and your home picks up the new plan within minutes. Turn it off any time in Settings → **Price spike guard**. Plans work within your comfort range either way.

## 3.5 — Solar that learns your array

*September 4, 2026*

<!-- summary
- Point your solar appliance at a production sensor and Hungry Machines learns your array's real yield and shading.
- A solar card plots the day's generation over the price bars.
- Enter your export rates and plans value your daytime surplus at that price.
-->

- **Production sensor.** Point your solar appliance at a sensor reporting the array's output and Hungry Machines learns your real yield and shading.
- **Solar card.** Plots the day's generation over the price bars with expected kWh, and names the forecast it used.
- **Export rates.** Tell Hungry Machines what your utility pays for power you send back, and plans value your daytime surplus at that price.
- **ComEd Delivery Time-of-Day.** Pick your delivery plan under Dynamic pricing and edit its period prices.

## 3.4 — Comfort protection, all day

*August 27, 2026*

<!-- summary
- About every 5 minutes, each room is checked against the low and high limits you set, and Hungry Machines steps in when the room crosses one.
- It works for every home with nothing to turn on.
-->

Every 5 minutes, Hungry Machines checks each room against the low and high limits you set. If the room crosses one, it steps in to bring the room back, spacing its commands to avoid short-cycling your compressor. It works for every home with nothing to turn on, and uses your room sensor when the thermostat reports no temperature.

## 3.3 — Home robots

*August 25, 2026*

<!-- summary
- Add a robot vacuum or mower, and the plan schedules dock charging in the cheapest half-hours before its Tasks window.
- Hungry Machines only sends the robot to its dock. It does not start tasks.
-->

Add a robot vacuum or mower, set a daily Tasks window and a target charge, and the plan schedules dock charging in the cheapest half-hours before the window. Hungry Machines only sends the robot to its dock. It does not start tasks.

## 3.2 — Per-device control

*July 5, 2026*

<!-- summary
- Pause one device and leave the rest running.
- Each HVAC's own comfort range shows on the dashboard charts.
-->

- An optimization toggle on every controllable card, so you can pause one device and leave the rest running.
- A clear choice between Simple and Custom comfort schedules.
- Each HVAC's own comfort range on the dashboard charts.

## 3.1 — Dehumidifiers

*July 1, 2026*

<!-- summary
- Add a dehumidifier as an appliance. This first release records its use; planning comes later.
-->

Add a dehumidifier as an appliance. This first release records its use; planning comes later.

## 3.0 — More than one HVAC, and live prices

*June 25, 2026*

<!-- summary
- Register more than one HVAC unit, each with its own plan and comfort range.
- Follow live wholesale prices, starting with ComEd and Ameren Illinois.
-->

- **Multiple HVAC units.** Register each unit with its own thermostat and sensors. Each gets its own plan, comfort editor and pause toggle, and both cards can show one unit or the whole home.
- **Dynamic pricing.** Follow live wholesale prices for your grid region, starting with ComEd and Ameren Illinois, plus an estimate of your delivery charge.
- **Send feedback** from Settings.
- All pricing controls in one **Pricing source** section.

## Earlier releases

Versions 0.1 through 2.9 built the foundation: the sidebar panel, the thermostat and savings cards, nightly plans for HVAC, EV chargers, batteries and water heaters, time-of-use pricing zones, sensor health, and the one-time warm-up.
