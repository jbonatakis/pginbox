<script lang="ts">
  import type { AnalyticsSummaryMetric } from "../../lib/analytics";

  export let metrics: AnalyticsSummaryMetric[] = [];

  const numberFormatter = new Intl.NumberFormat("en-US");

  const metricLabels: Record<AnalyticsSummaryMetric["id"], string> = {
    totalMessages: "Total messages",
    totalThreads: "Total threads",
    uniqueSenders: "Unique senders",
    monthsIngested: "Months ingested",
  };

  const formatCount = (value: number): string => numberFormatter.format(value);

  const labelForMetric = (metric: AnalyticsSummaryMetric): string =>
    metricLabels[metric.id] ?? metric.label;
</script>

<section class="summary-grid" aria-label="Summary metrics">
  {#each metrics as metric (metric.id)}
    <article class="metric-card">
      <p class="metric-label">{labelForMetric(metric)}</p>
      <p class="metric-value">{formatCount(metric.value)}</p>
    </article>
  {/each}
</section>

<style>
  .summary-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  }

  .metric-card {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-soft);
    padding: 0.75rem 0.85rem;
    display: grid;
    align-content: start;
    gap: 0.2rem;
    min-height: 5rem;
    min-width: 0;
  }

  .metric-label {
    margin: 0;
    font-size: 0.77rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .metric-value {
    margin: 0;
    font-size: 1.42rem;
    font-weight: 700;
    color: var(--text);
    line-height: 1.1;
  }
</style>
