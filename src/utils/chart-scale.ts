// How charts pick their y-axis, saved on the account (user_preferences
// chart_scale / solar_chart_scale) so every device shows the same view.
//
// Temperature charts: 'standard' keeps the fixed per-appliance range (HVAC
// 40–100 °F, water heater 50–150 °F) so devices compare at a glance;
// 'dynamic' zooms to each chart's own band and setpoints.
// Solar chart: 'max' tops out at the system size; 'dynamic' at the day's
// expected peak plus 25 %.

export type ChartScale = 'standard' | 'dynamic';
export type SolarChartScale = 'max' | 'dynamic';

export interface ChartScaleState {
  temperature: ChartScale;
  solar: SolarChartScale;
}

export interface ChartScalePrefs {
  chart_scale?: ChartScale | null;
  solar_chart_scale?: SolarChartScale | null;
}

export type ChartScaleListener = (state: ChartScaleState) => void;

const DEFAULT_STATE: ChartScaleState = { temperature: 'standard', solar: 'max' };

class ChartScaleStore {
  state: ChartScaleState = { ...DEFAULT_STATE };

  private readonly listeners = new Set<ChartScaleListener>();

  subscribe(listener: ChartScaleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Adopt the account's saved choices; null or missing means the default. */
  setFromPreferences(prefs: ChartScalePrefs | null | undefined): void {
    const next: ChartScaleState = {
      temperature: prefs?.chart_scale === 'dynamic' ? 'dynamic' : 'standard',
      solar: prefs?.solar_chart_scale === 'dynamic' ? 'dynamic' : 'max',
    };
    if (next.temperature === this.state.temperature && next.solar === this.state.solar) return;
    this.state = next;
    for (const l of this.listeners) l(this.state);
  }

  reset(): void {
    this.setFromPreferences(null);
  }
}

export const chartScaleStore = new ChartScaleStore();
