<script lang="ts">
  import ErrorState from "../components/ErrorState.svelte";
</script>

<section class="page">
  <header>
    <h1 class="page-title" data-route-heading tabindex="-1">Page not found</h1>
  </header>

  <ErrorState title="There's no page here" message="Check the URL or use the navigation above." />
</section>

<style>
  .page {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
  }

  .page-title {
    margin: 0;
    font-size: 1.2rem;
    color: #102a43;
  }
</style>
