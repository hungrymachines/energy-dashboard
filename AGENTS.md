# Agent Notes — Hungry Machines Base Frontend

Quick reference for hot spots and gotchas. See `CLAUDE.md` for the canonical project doc and `structure.md` for the deep architecture reference.

## Hot files

- `src/store.ts` — `authStore` singleton + `getEntityMap`/`setEntityMap` (localStorage `hm_entity_map`).
- `src/panel/hungry-machines-panel.ts` — full-page panel; tabs (Dashboard / Settings); appliance cards; rates editor; entity / pricing-zone selects.
- `src/cards/thermostat-card.ts` and `src/cards/savings-card.ts` — Lovelace cards. They take their HA-entity wiring from **Lovelace card config**, not from `getEntityMap()`.
- `src/api/client.ts` — `apiFetch` with auto-attached Bearer + 401 → `clearTokens` chain.
- `src/data/pricing-zones.ts` — `PRICING_ZONE_LABELS` (1..8 → `{ provider, region }`) + `pricingZoneOptionLabel` / `pricingZoneFullLabel` helpers. Drives the Settings → Pricing zone dropdown text and zone-hint span. Update zones 3–8 here when the API repo's `app/services/pricing.py` is reconciled.
- `src/ui/appliance-form.ts` — `HmApplianceForm` modal. Two-step flow: type picker (4 types) → per-type config form. Emits `appliance-created` (with `{detail: {appliance}}`) and `cancelled`. The panel listens to both and re-fetches `/api/v1/schedules` on creation by flipping `_schedulesFetched=false`. `appliancesApi.create()` synthesizes a full `Appliance` from the API's thin `{appliance_id}` response when needed.

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

## Build / verify primitives

```bash
npm test            # vitest (currently 75 cases across 13 files)
npm run build       # rollup -> custom_components/hungry_machines/frontend/hungry-machines.js
npx tsc --noEmit    # type check
./scripts/release.sh
```

`custom_components/hungry_machines/frontend/hungry-machines.js` is gitignored; CI rebuilds it on tag push.
