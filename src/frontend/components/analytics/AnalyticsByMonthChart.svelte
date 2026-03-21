<script lang="ts">
  import type { AnalyticsByMonthPoint } from "../../lib/analytics";

  export let months: AnalyticsByMonthPoint[] = [];

  const fmt = new Intl.NumberFormat("en-US");
  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Last 12 months only — enough history without crowding
  $: displayed = months.slice(-12);
  $: max = Math.max(1, ...displayed.map((m) => m.messages));
  $: bars = displayed.map((m) => ({
    ...m,
    heightPct: (m.messages / max) * 100,
    intensity: m.messages / max,
    // Show year only for January to mark year boundaries
    tickLabel: m.month === 1
      ? `Jan '${String(m.year).slice(2)}`
      : (MONTH_ABBR[m.month - 1] ?? ""),
    fullLabel: new Date(Date.UTC(m.year, m.month - 1, 1))
      .toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  }));
  $: hasData = displayed.some((m) => m.messages > 0);

  let tooltipContent: string | null = null;
  let tooltipX = 0;
  let tooltipY = 0;

  function showTooltip(event: MouseEvent, bar: (typeof bars)[number]) {
    tooltipContent = `${bar.fullLabel}\n${fmt.format(bar.messages)} messages`;
    tooltipX = event.clientX;
    tooltipY = event.clientY;
  }

  function moveTooltip(event: MouseEvent) {
    tooltipX = event.clientX;
    tooltipY = event.clientY;
  }

  function hideTooltip() {
    tooltipContent = null;
  }
</script>

<article class="card">
  <h3>Messages by Month <span class="subtitle">last 12 months</span></h3>

  {#if hasData}
    <div class="chart-outer">
      <div class="chart-inner">
        <div class="bars" role="img" aria-label="Column chart showing message volume by month">
          {#each bars as bar (bar.key)}
            <div
              class="col"
              on:mouseenter={(e) => showTooltip(e, bar)}
              on:mousemove={moveTooltip}
              on:mouseleave={hideTooltip}
            >
              <div
                class="bar"
                style="height: {bar.heightPct}%; opacity: {0.2 + 0.8 * bar.intensity}"
              ></div>
            </div>
          {/each}
        </div>
        <div class="ticks" aria-hidden="true">
          {#each bars as bar (bar.key)}
            <span class="tick">{bar.tickLabel}</span>
          {/each}
        </div>
      </div>
    </div>
  {:else}
    <p class="empty">No month-level activity has been ingested yet.</p>
  {/if}

  {#if tooltipContent}
    <div
      class="tooltip"
      role="tooltip"
      style="left: {tooltipX + 14}px; top: {tooltipY - 56}px"
    >
      {tooltipContent}
    </div>
  {/if}
</article>

<style>
  .card {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-soft);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.96rem;
    color: var(--text);
  }

  .subtitle {
    font-size: 0.78rem;
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 0.2em;
  }

  .chart-outer {
    overflow-x: auto;
    min-width: 0;
  }

  .chart-inner {
    display: grid;
    gap: 4px;
  }

  .bars {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 96px;
  }

  .col {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: flex-end;
    cursor: default;
  }

  .bar {
    width: 100%;
    background: var(--primary);
    border-radius: 2px 2px 0 0;
  }

  .ticks {
    display: flex;
    gap: 4px;
  }

  .tick {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.68rem;
    color: var(--text-muted);
    text-align: center;
    line-height: 1;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
  }

  .empty {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
  }

  .tooltip {
    position: fixed;
    z-index: 100;
    background: #102a43;
    color: #fff;
    font-size: 0.75rem;
    padding: 0.35rem 0.6rem;
    border-radius: 0.4rem;
    pointer-events: none;
    white-space: pre;
    line-height: 1.55;
    box-shadow: 0 2px 10px rgba(16, 42, 67, 0.28);
  }
</style>
