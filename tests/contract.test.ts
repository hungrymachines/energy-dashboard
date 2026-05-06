// Contract drift gate.
//
// Each `_*Compat` type below uses `extends ... ? true : false` to assert that
// the hand-typed interface in `src/api/*.ts` is structurally compatible with
// the corresponding response shape in the auto-generated `src/api/generated.ts`.
// The assertions live at module scope so `tsc --noEmit` (also exposed as
// `npm run check:contract`) fails on drift even without a runtime test runner.
// The vitest case at the bottom is just a placeholder so the file is counted
// in `npm test`.
import { describe, it, expect } from 'vitest';
import type { paths } from '../src/api/generated';
import type { Preferences } from '../src/api/preferences';
import type { RatesResponse } from '../src/api/rates';
import type { Appliance, ApplianceSchedule } from '../src/api/appliances';
import type { HvacScheduleResponse, SchedulesResponse } from '../src/api/schedules';
import type { Session, UserMe } from '../src/api/auth';

type _PreferencesCompat = Preferences extends paths['/api/v1/preferences']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkPreferences: _PreferencesCompat = true;

type _RatesCompat = RatesResponse extends paths['/api/v1/rates']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkRates: _RatesCompat = true;

type _ApplianceCompat = Appliance[] extends paths['/api/v1/appliances']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkAppliance: _ApplianceCompat = true;

type _HvacScheduleCompat = HvacScheduleResponse extends paths['/api/v1/schedule']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkHvacSchedule: _HvacScheduleCompat = true;

type _SchedulesCompat = SchedulesResponse extends paths['/api/v1/schedules']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkSchedules: _SchedulesCompat = true;

type _UserMeCompat = UserMe extends paths['/auth/me']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkUserMe: _UserMeCompat = true;

type _SessionCompat = Session extends paths['/auth/login']['post']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkSession: _SessionCompat = true;

type _ApplianceScheduleCompat = ApplianceSchedule extends paths['/api/v1/appliances/{appliance_id}/schedule']['get']['responses']['200']['content']['application/json']
  ? true
  : false;
const _checkApplianceSchedule: _ApplianceScheduleCompat = true;

// Reference the assertion locals so an unused-vars rule wouldn't strip them.
const _assertions = [
  _checkPreferences,
  _checkRates,
  _checkAppliance,
  _checkHvacSchedule,
  _checkSchedules,
  _checkUserMe,
  _checkSession,
  _checkApplianceSchedule,
];

describe('hand-typed API wrappers vs generated.ts (drift gate is tsc --noEmit)', () => {
  it('placeholder so vitest counts the file; real assertions are at module scope', () => {
    expect(_assertions.every((v) => v === true)).toBe(true);
    expect(true).toBe(true);
  });
});
