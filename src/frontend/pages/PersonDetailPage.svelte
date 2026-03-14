<script lang="ts">
  import type { Person } from "shared/api";
  import { onDestroy } from "svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import PersonEmailList from "../components/people/PersonEmailList.svelte";
  import PersonTopThreadsList from "../components/people/PersonTopThreadsList.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { onLinkClick, peoplePath } from "../router";

  type PersonDetailStatus = "idle" | "loading" | "success" | "error";
  type LoadMode = "replace" | "preserve";

  export let id: string;

  const createdAtFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  let activeRequestController: AbortController | null = null;
  let error: ApiErrorShape | null = null;
  let isRefreshing = false;
  let lastLoadedId: number | null = null;
  let parsedId: number | null = null;
  let person: Person | null = null;
  let requestSequence = 0;
  let status: PersonDetailStatus = "idle";

  const parsePersonId = (value: string): number | null => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;

    const numberValue = Number(trimmed);
    if (numberValue < 1) return null;
    if (!Number.isSafeInteger(numberValue)) return null;

    return numberValue;
  };

  const formatErrorDetail = (apiError: ApiErrorShape | null): string | null => {
    if (!apiError) return null;
    const defaultPath = parsedId === null ? "/api/people/:id" : `/api/people/${parsedId}`;
    const path = apiError.path || defaultPath;

    if (apiError.status > 0) {
      return `${apiError.method} ${path} -> ${apiError.status}`;
    }

    return `${apiError.method} ${path} -> ${apiError.code ?? "NETWORK_ERROR"}`;
  };

  const personName = (name: string): string => {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : "Unknown contributor";
  };

  const formatCreatedAt = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return createdAtFormatter.format(parsed);
  };

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const loadPerson = async (personId: number, mode: LoadMode): Promise<void> => {
    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;

    const requestId = ++requestSequence;
    const hasPerson = person !== null;

    error = null;
    if (mode === "replace" || !hasPerson) {
      person = null;
      status = "loading";
      isRefreshing = false;
    } else {
      isRefreshing = true;
    }

    try {
      const response = await api.people.get(personId, { signal: requestController.signal });
      if (requestId !== requestSequence) return;

      person = response;
      status = "success";
    } catch (rawError) {
      const apiError = toApiErrorShape(rawError);
      if (apiError.code === "ABORTED" || requestId !== requestSequence) return;

      error = apiError;
      if (mode === "replace" || !hasPerson) {
        person = null;
        status = "error";
      }
    } finally {
      if (requestId !== requestSequence) return;

      isRefreshing = false;
      if (activeRequestController === requestController) {
        activeRequestController = null;
      }
    }
  };

  const retry = (): void => {
    if (parsedId === null) return;
    void loadPerson(parsedId, "preserve");
  };

  $: parsedId = parsePersonId(id);

  $: if (parsedId === null) {
    requestSequence += 1;
    clearActiveRequest();

    error = null;
    isRefreshing = false;
    lastLoadedId = null;
    person = null;
    status = "error";
  } else if (parsedId !== lastLoadedId) {
    lastLoadedId = parsedId;
    void loadPerson(parsedId, "replace");
  }

  $: hasInvalidId = parsedId === null;
  $: isBusy = status === "loading" || isRefreshing;
  $: isInitialLoad = status === "idle" || (status === "loading" && person === null);
  $: isNotFound = !hasInvalidId && status === "error" && error?.status === 404;

  onDestroy(() => {
    requestSequence += 1;
    clearActiveRequest();
  });
</script>

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">Person Detail</h1>

  {#if hasInvalidId}
    <ErrorState
      title="Invalid contributor ID"
      message="Person detail routes require a positive integer ID."
      detail={`Received "${id}" but expected /people/:id`}
    />
  {:else if isInitialLoad}
    <LoadingState
      title="Loading contributor profile"
      message="Names, emails, and top thread activity are loading."
    />
  {:else if isNotFound}
    <ErrorState
      title="Contributor not found"
      message="No contributor exists with this ID."
      detail={formatErrorDetail(error)}
    />
  {:else if status === "error" && person === null}
    <div class="status-block">
      <ErrorState
        title="Unable to load contributor"
        message={error?.message ?? "Contributor request failed."}
        detail={formatErrorDetail(error)}
      />
      <button class="retry-button" type="button" on:click={retry}>Retry contributor fetch</button>
    </div>
  {:else if person}
    {#if isRefreshing}
      <p class="inline-status" role="status">Refreshing contributor profile...</p>
    {/if}

    {#if error}
      <ErrorState
        title="Unable to refresh contributor data"
        message={error.message}
        detail={formatErrorDetail(error)}
      />
    {/if}

    <article class="summary-card" aria-label="Contributor metadata">
      <h3>{personName(person.name)}</h3>
      <dl>
        <div>
          <dt>Person ID</dt>
          <dd>{person.id}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatCreatedAt(person.created_at)}</dd>
        </div>
        <div>
          <dt>Known emails</dt>
          <dd>{person.emails.length}</dd>
        </div>
        <div>
          <dt>Top threads</dt>
          <dd>{person.topThreads.length}</dd>
        </div>
      </dl>
    </article>

    <section class="detail-grid">
      <PersonEmailList emails={person.emails} />
      <PersonTopThreadsList topThreads={person.topThreads} />
    </section>
  {/if}

  <p class="route-link">
    <a href={peoplePath} on:click={(event) => onLinkClick(event, peoplePath)}>Back to people</a>
  </p>
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

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

  .summary-card {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  .summary-card h3 {
    margin: 0;
    font-size: 1rem;
    color: #102a43;
    overflow-wrap: anywhere;
  }

  .summary-card dl {
    margin: 0;
    display: grid;
    gap: 0.45rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  }

  .summary-card dl div {
    display: grid;
    gap: 0.08rem;
    padding: 0.35rem 0.45rem;
    border-radius: 0.5rem;
    border: 1px solid #d9e2ec;
    background: #f8fbff;
    min-width: 0;
  }

  .summary-card dt {
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #627d98;
  }

  .summary-card dd {
    margin: 0;
    font-size: 0.9rem;
    color: #102a43;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .detail-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    min-width: 0;
  }

  .route-link {
    margin: 0;
  }

  .route-link a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
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
