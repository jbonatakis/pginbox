<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import AnalyticsSummaryGrid from "../components/analytics/AnalyticsSummaryGrid.svelte";
  import AnalyticsTopSendersSection from "../components/analytics/AnalyticsTopSendersSection.svelte";
  import AnalyticsTrendSection from "../components/analytics/AnalyticsTrendSection.svelte";
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

  $: monthRows =
    $analyticsState.data?.byMonth.map((month) => ({
      id: month.key,
      label: month.label,
      messages: month.messages,
    })) ?? [];

  $: hourRows =
    $analyticsState.data?.byHour.map((hour) => ({
      id: String(hour.hour),
      label: hour.label,
      messages: hour.messages,
    })) ?? [];

  $: dayRows =
    $analyticsState.data?.byDow.map((day) => ({
      id: String(day.dow),
      label: day.label,
      messages: day.messages,
    })) ?? [];

  $: hasMonthData = monthRows.length > 0;
  $: hasHourData = hourRows.some((hour) => hour.messages > 0);
  $: hasDayData = dayRows.some((day) => day.messages > 0);

  $: isInitialLoad =
    $analyticsState.status === "idle" || ($analyticsState.status === "loading" && !$analyticsState.data);
</script>

<section class="page">
  <header class="page-header">
    <div class="header-copy">
      <h1 class="page-title" data-route-heading tabindex="-1">Analytics</h1>
      <p>Inspect mailing list trends and activity over time.</p>
    </div>

    <button class="refresh-button" type="button" disabled={$analyticsState.isLoading} on:click={retry}
      >{$analyticsState.isLoading ? "Refreshing..." : "Refresh"}</button
    >
  </header>

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

    <section class="section-grid" aria-label="Monthly and sender breakdowns">
      <AnalyticsTrendSection
        title="Messages by Month"
        rows={monthRows}
        hasData={hasMonthData}
        emptyMessage="No month-level activity has been ingested yet."
      />

      <AnalyticsTopSendersSection
        senders={$analyticsState.data.topSenders}
        emptyMessage="No sender activity has been ingested yet."
      />
    </section>

    <section class="section-grid" aria-label="Hourly and day-of-week breakdowns">
      <AnalyticsTrendSection
        title="Messages by Hour (UTC)"
        rows={hourRows}
        hasData={hasHourData}
        emptyMessage="No hourly distribution is available yet."
        dense
      />

      <AnalyticsTrendSection
        title="Messages by Weekday"
        rows={dayRows}
        hasData={hasDayData}
        emptyMessage="No day-of-week distribution is available yet."
        dense
      />
    </section>
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.8rem;
    flex-wrap: wrap;
  }

  .header-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .page-title {
    margin: 0;
    font-size: 1.2rem;
    color: #102a43;
  }

  p {
    margin: 0;
    color: #486581;
    line-height: 1.4;
    min-width: 0;
  }

  .refresh-button,
  .retry-button {
    border: 1px solid #6f9fdd;
    border-radius: 0.55rem;
    background: #e8f2ff;
    color: #0b4ea2;
    font-weight: 650;
    font-size: 0.86rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .refresh-button:disabled,
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
    color: #486581;
  }

  .section-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    min-width: 0;
  }

  @media (max-width: 480px) {
    .refresh-button {
      width: 100%;
    }
  }
</style>
