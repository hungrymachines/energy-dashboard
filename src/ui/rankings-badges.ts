import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';
import { getDailyMetrics, getMetricsSummary, getRankings } from '../api/me-metrics.js';
import type { DailyEntry, MetricsSummary, RankingsResponse } from '../api/me-metrics.js';
import { computeBadges, savingsAboveMedianStreak } from '../utils/badges.js';
import type { SavingsStreak } from '../utils/badges.js';

const WINDOW_DAYS = 30;
const EM_DASH = '—';
const FLEX_METRIC = 'flexibility_degree_hours';

/** Display order and wording of the three ranked metrics (active machines is a
 *  coverage ladder, not a leaderboard, so it is not ranked). */
const RANKABLE: { metric: string; label: string; blurb: string }[] = [
  { metric: 'savings_pct', label: 'Savings rate', blurb: 'how much you cut off your baseline cost' },
  { metric: 'off_peak_kwh_share_pct', label: 'Off-peak share', blurb: 'how much of your energy runs in the cheapest hours' },
  { metric: 'flexibility_degree_hours', label: 'Flexibility offered', blurb: 'how much room you gave the optimizer' },
];

/** Always "among Hungry Machines homes", never a count of them. */
const COHORT_PHRASE: Record<string, string> = {
  zip5: 'among local Hungry Machines homes',
  zip3: 'among Hungry Machines homes in your area',
  rate_peers: 'among Hungry Machines homes on your rate plan',
  fleet: 'among all Hungry Machines homes',
};

export function cohortPhrase(kind: string | null): string {
  return (kind && COHORT_PHRASE[kind]) || 'among Hungry Machines homes';
}

/**
 * `<hm-rankings-badges>` - the customer's three ranking cards, savings streak
 * and badges. No share card. Rankings and daily series degrade on their own;
 * only a summary failure shows the retry banner.
 */
export class HmRankingsBadges extends LitElement {
  static override styles = css`
    :host { display: block; font-family: var(--hm-font-body, sans-serif); color: var(--hm-text, #0F172A); }
    .banner { padding: 12px 14px; border-radius: 8px; font-size: 14px; background: rgba(100,116,139,0.08); color: #475569; }
    .banner button { margin-left: 8px; }
    h2 { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--hm-muted, #64748B); }
    h3 { margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hm-muted, #64748B); }
    .intro { margin: 4px 0 12px; font-size: 12px; line-height: 1.45; color: var(--hm-muted, #64748B); }
    .section { margin-top: 20px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 700px) { .grid { grid-template-columns: 1fr 1fr 1fr; } }
    .card { padding: 14px; border-radius: 8px; border: 1px solid rgba(100,116,139,0.25); background: #fafbfc; }
    .card.earned { border-color: #0F766E; }
    .big { margin: 8px 0 0; font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .big small { font-size: 14px; font-weight: 400; color: var(--hm-muted, #64748B); }
    .missing { color: var(--hm-muted, #64748B); }
    .note { margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--hm-muted, #64748B); }
    .head { display: flex; justify-content: space-between; gap: 8px; }
    .head b { font-size: 15px; }
    .head span { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--hm-muted, #64748B); }
    .earned .head span { color: #0F766E; }
  `;

  static override properties = {
    _summary: { state: true },
    _rankings: { state: true },
    _days: { state: true },
    _daily: { state: true },
    _loading: { state: true },
    _error: { state: true },
    refreshKey: { type: Number, attribute: 'refresh-key', reflect: true },
  };

  _summary: MetricsSummary | null = null;
  _rankings: RankingsResponse | null = null;
  _days: DailyEntry[] = [];
  _daily = false;
  _loading = false;
  _error: string | null = null;
  refreshKey = 0;

  private _lastRefreshKey = -1;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this._load();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('refreshKey') && this.refreshKey !== this._lastRefreshKey) {
      const first = this._lastRefreshKey === -1;
      this._lastRefreshKey = this.refreshKey;
      if (!first) void this._load();
    }
  }

  private async _load(): Promise<void> {
    this._loading = true;
    this._error = null;
    const [sum, rank, daily] = await Promise.allSettled([
      getMetricsSummary(WINDOW_DAYS),
      getRankings(WINDOW_DAYS),
      getDailyMetrics(),
    ]);
    if (sum.status === 'rejected') {
      // Never show an earlier payload as current.
      this._summary = null;
      this._rankings = null;
      this._days = [];
      this._daily = false;
      this._error = sum.reason instanceof Error ? sum.reason.message : String(sum.reason);
    } else {
      this._summary = sum.value;
      this._rankings = rank.status === 'fulfilled' ? rank.value : null;
      this._daily = daily.status === 'fulfilled';
      this._days = daily.status === 'fulfilled' ? daily.value.days : [];
    }
    this._loading = false;
  }

  override render() {
    if (this._error) {
      return html`<div class="banner" role="alert">
        We couldn't load your rankings and badges just now: ${this._error}
        <button type="button" @click=${() => void this._load()}>Try again</button>
      </div>`;
    }
    if (this._loading || !this._summary) {
      return html`<div class="banner" role="status">Loading your rankings and badges…</div>`;
    }
    const flex = this._rankings?.rankings.find((r) => r.metric === FLEX_METRIC)?.percentile ?? null;
    const badges = computeBadges(this._summary, flex, this._days);
    const streak = this._daily ? savingsAboveMedianStreak(this._days) : null;
    return html`<div class="root">
      <div class="section" data-testid="rankings">
        <h2>How you compare</h2>
        <p class="intro">Ranked against comparable Hungry Machines homes. We never show you anything about them.</p>
        ${this._renderRankings()}
      </div>
      <div class="section" data-testid="badges">
        <h2>Badges and streaks</h2>
        <p class="intro">Facts about how your system is working, measured and not hyped.</p>
        ${this._renderStreak(streak)}
        <div class="grid">
          ${badges.map((b) => html`<div class="card ${b.earned ? 'earned' : ''}" data-testid="badge-${b.key}" data-earned=${String(b.earned)}>
            <div class="head"><b>${b.name}</b><span>${b.earned ? 'Earned' : 'Not yet'}</span></div>
            <p class="note">${b.measured}</p>
          </div>`)}
        </div>
      </div>
    </div>`;
  }

  private _renderRankings(): TemplateResult {
    const byMetric = new Map((this._rankings?.rankings ?? []).map((r) => [r.metric, r]));
    const cards = RANKABLE.map((meta) => ({ meta, row: byMetric.get(meta.metric) })).filter((c) => c.row);
    if (cards.length === 0) {
      return html`<div class="card"><p class="note">Rankings appear once we have a day of your data to compare.</p></div>`;
    }
    return html`<div class="grid">${cards.map(({ meta, row }) => html`<div class="card" data-testid="ranking-${meta.metric}">
      <h3>${meta.label}</h3>
      ${row!.rank !== null
        ? html`<p class="big">#${row!.rank} <small>${cohortPhrase(row!.cohort_kind)}</small></p>`
        : html`<p class="big missing">${EM_DASH} <small>not enough data yet</small></p>`}
      <p class="note">Ranked by ${meta.blurb}.</p>
    </div>`)}</div>`;
  }

  private _renderStreak(streak: SavingsStreak | null): TemplateResult {
    let body: TemplateResult;
    if (streak === null || streak.medianPct === null) {
      body = html`<p class="note">${EM_DASH} Your streak appears after a few optimized days of data.</p>`;
    } else if (streak.days === 0) {
      body = html`<p class="note">No active streak yet. A day of savings above your ${WINDOW_DAYS}-day median starts one.</p>`;
    } else {
      body = html`<p class="big">${streak.days}
        <small>${streak.days === 1 ? 'consecutive day' : 'consecutive days'} with savings above your ${WINDOW_DAYS}-day median</small></p>`;
    }
    return html`<div class="card" data-testid="savings-streak" style="margin-bottom:12px">
      <h3>Savings streak</h3>${body}
    </div>`;
  }
}
