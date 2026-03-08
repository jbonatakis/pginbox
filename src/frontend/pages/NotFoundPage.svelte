<script lang="ts">
  import ErrorState from "../components/ErrorState.svelte";
  import { onLinkClick, threadsPath } from "../router";

  export let pathname: string;
</script>

<section class="page">
  <header>
    <h1 class="page-title" data-route-heading tabindex="-1">Not Found</h1>
    <p>Route mismatch detected.</p>
  </header>

  <ErrorState title="Route not found" message="No route matched this path." detail={pathname} />

  <p class="route-link">
    <a href={threadsPath} on:click={(event) => onLinkClick(event, threadsPath)}>Go to threads</a>
  </p>
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  header {
    display: grid;
    gap: 0.2rem;
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
  }

  .route-link a {
    color: #0b4ea2;
    font-weight: 600;
    text-decoration-thickness: 1px;
  }
</style>
