<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import AnalyticsByHourChart from "../components/analytics/AnalyticsByHourChart.svelte";
  import AnalyticsByMonthChart from "../components/analytics/AnalyticsByMonthChart.svelte";
  import AnalyticsDowChart from "../components/analytics/AnalyticsDowChart.svelte";
  import AnalyticsSummaryGrid from "../components/analytics/AnalyticsSummaryGrid.svelte";
  import AnalyticsTopSendersChart from "../components/analytics/AnalyticsTopSendersChart.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import { createAnalyticsStore } from "../lib/analytics";
  import type { ApiErrorShape } from "../lib/api";

  const analyticsState = createAnalyticsStore();

  onMount(() => {
    void analyticsState.load();
  });

  onDestroy(() => {
    analyticsState.dispose();
  });

  const retry = (): void => {
    void analyticsState.retry();
  };

  const formatErrorDetail = (error: ApiErrorShape | null): string | null => {
    if (!error) return null;

    const path = error.path || "/api/analytics";
    if (error.status > 0) {
      return `${error.method} ${path} -> ${error.status}`;
    }

    return `${error.method} ${path} -> ${error.code ?? "NETWORK_ERROR"}`;
  };

  $: isInitialLoad =
    $analyticsState.status === "idle" || ($analyticsState.status === "loading" && !$analyticsState.data);
</script>

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">Analytics</h1>

  {#if isInitialLoad}
    <LoadingState
      title="Loading analytics"
      message="Summary metrics and activity breakdowns are loading."
    />
  {:else if $analyticsState.status === "error"}
    <div class="status-block">
      <ErrorState
        title="Unable to load analytics"
        message={$analyticsState.error?.message ?? "Analytics requests failed."}
        detail={formatErrorDetail($analyticsState.error)}
      />
      <button class="retry-button" type="button" on:click={retry}>Retry analytics fetch</button>
    </div>
  {:else if $analyticsState.data}
    {#if $analyticsState.status === "empty"}
      <p class="inline-status" role="status">
        Analytics is loaded but no activity has been ingested yet.
      </p>
    {/if}

    {#if $analyticsState.isLoading}
      <p class="inline-status" role="status">Refreshing analytics data...</p>
    {/if}

    <AnalyticsSummaryGrid metrics={$analyticsState.data.summaryMetrics} />

    <AnalyticsByHourChart hours={$analyticsState.data.byHour} />

    <section class="two-col" aria-label="Day-of-week and top sender breakdowns">
      <AnalyticsDowChart days={$analyticsState.data.byDow} />
      <AnalyticsTopSendersChart senders={$analyticsState.data.topSenders} />
    </section>

    <AnalyticsByMonthChart months={$analyticsState.data.byMonth} />
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .retry-button {
    border: 1px solid rgba(111, 159, 221, 0.76);
    border-radius: 0.55rem;
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 650;
    font-size: 0.86rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .retry-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .status-block {
    display: grid;
    gap: 0.65rem;
    justify-items: start;
    min-width: 0;
  }

  .inline-status {
    margin: 0;
    font-size: 0.84rem;
    color: var(--text-muted);
  }

  .two-col {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    min-width: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
