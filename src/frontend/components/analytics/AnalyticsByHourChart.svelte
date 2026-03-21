<script lang="ts">
  import type { AnalyticsByHourPoint } from "../../lib/analytics";

  export let hours: AnalyticsByHourPoint[] = [];

  const fmt = new Intl.NumberFormat("en-US");
  const pctFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

  $: max = Math.max(1, ...hours.map((h) => h.messages));
  $: total = hours.reduce((sum, h) => sum + h.messages, 0);
  $: bars = hours.map((h) => ({
    ...h,
    heightPct: (h.messages / max) * 100,
    intensity: h.messages / max,
    pct: total > 0 ? (h.messages / total) * 100 : 0,
  }));
  $: hasData = hours.some((h) => h.messages > 0);

  let tooltipContent: string | null = null;
  let tooltipX = 0;
  let tooltipY = 0;

  function showTooltip(event: MouseEvent, bar: (typeof bars)[number]) {
    const nextHour = (bar.hour + 1) % 24;
    const range = `${String(bar.hour).padStart(2, "0")}:00 – ${String(nextHour).padStart(2, "0")}:00 UTC`;
    tooltipContent = `${range}\n${fmt.format(bar.messages)} messages  ${pctFmt.format(bar.pct)}%`;
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
  <h3>Messages by Hour <span class="subtitle">UTC</span></h3>

  {#if hasData}
    <div class="chart-wrap">
      <div class="bars" role="img" aria-label="Column chart showing message volume by UTC hour of day">
        {#each bars as bar (bar.hour)}
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
        {#each bars as bar (bar.hour)}
          <span class="tick">{String(bar.hour)}</span>
        {/each}
      </div>
    </div>
  {:else}
    <p class="empty">No hourly distribution is available yet.</p>
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

  .chart-wrap {
    display: grid;
    gap: 3px;
  }

  .bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 72px;
  }

  .col {
    flex: 1;
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
    gap: 3px;
  }

  .tick {
    flex: 1;
    font-size: 0.6rem;
    color: var(--text-muted);
    text-align: center;
    line-height: 1;
    user-select: none;
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
