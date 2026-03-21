<script lang="ts">
  import type { AnalyticsTopSenderPoint } from "../../lib/analytics";

  export let senders: AnalyticsTopSenderPoint[] = [];
  export let limit = 10;

  const fmt = new Intl.NumberFormat("en-US");
  const pctFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

  $: visible = senders.slice(0, limit);
  $: max = Math.max(1, ...visible.map((s) => s.messages));
  $: total = visible.reduce((sum, s) => sum + s.messages, 0);
  $: bars = visible.map((s) => ({
    ...s,
    pct: (s.messages / max) * 100,
    intensity: s.messages / max,
    share: total > 0 ? (s.messages / total) * 100 : 0,
  }));
  $: hasSenders = visible.length > 0;

  let tooltipContent: string | null = null;
  let tooltipX = 0;
  let tooltipY = 0;

  function showTooltip(event: MouseEvent, bar: (typeof bars)[number]) {
    const lines: string[] = [`#${bar.rank} — ${bar.label}`];
    if (bar.name && bar.email && bar.name !== bar.email) {
      lines.push(bar.email);
    }
    lines.push(`${fmt.format(bar.messages)} messages  ${pctFmt.format(bar.share)}% of top ${visible.length}`);
    tooltipContent = lines.join("\n");
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
  <h3>Top Contributors</h3>

  {#if hasSenders}
    <div class="chart">
      {#each bars as bar (bar.rank)}
        <div
          class="row"
          on:mouseenter={(e) => showTooltip(e, bar)}
          on:mousemove={moveTooltip}
          on:mouseleave={hideTooltip}
        >
          <span class="label">{bar.label}</span>
          <div class="track">
            <div
              class="bar"
              style="width: {bar.pct}%; opacity: {0.22 + 0.78 * bar.intensity}"
            ></div>
          </div>
          <span class="count">{fmt.format(bar.messages)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">No sender activity has been ingested yet.</p>
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
    align-content: start;
  }

  h3 {
    margin: 0;
    font-size: 0.96rem;
    color: var(--text);
  }

  .chart {
    display: grid;
    gap: 0.38rem;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 3.5rem;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    cursor: default;
  }

  .label {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .track {
    height: 0.9rem;
    background: var(--surface-muted);
    border-radius: 3px;
    border: 1px solid var(--border-soft);
    overflow: hidden;
  }

  .bar {
    height: 100%;
    background: var(--primary);
    border-radius: 3px;
    min-width: 2px;
  }

  .count {
    font-size: 0.78rem;
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
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
