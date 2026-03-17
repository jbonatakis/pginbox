<script lang="ts">
  export let title = "Loading";
  export let message = "Fetching data.";
</script>

<section class="status loading" role="status" aria-live="polite">
  <div class="spinner" aria-hidden="true"></div>
  <div class="copy">
    <h3>{title}</h3>
    <p>{message}</p>
  </div>
</section>

<style>
  .status {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background: var(--surface-muted);
    padding: 0.8rem 0.9rem;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    border: 2px solid #9fbde3;
    border-top-color: var(--primary);
    animation: spin 800ms linear infinite;
  }

  .copy {
    display: grid;
    gap: 0.15rem;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    color: var(--primary);
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 0.89rem;
    color: var(--text-subtle);
    line-height: 1.35;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }
</style>
