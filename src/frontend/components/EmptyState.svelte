<script lang="ts">
  export let title = "No results";
  export let message = "Try adjusting filters or expanding your search.";
</script>

<section class="status empty" role="status" aria-live="polite">
  <div class="icon" aria-hidden="true">o</div>
  <div class="copy">
    <h3>{title}</h3>
    <p>{message}</p>
  </div>
</section>

<style>
  .status {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    background: #fbfcfe;
    padding: 0.8rem 0.9rem;
  }

  .icon {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    border: 2px solid #7b8794;
    color: #7b8794;
    font-size: 0;
    margin-top: 0.15rem;
  }

  .copy {
    display: grid;
    gap: 0.15rem;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text);
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 0.89rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
</style>
