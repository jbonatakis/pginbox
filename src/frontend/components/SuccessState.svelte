<script lang="ts">
  export let title = "Success";
  export let message = "Your request completed successfully.";
  export let detail: string | null = null;
</script>

<section class="status success" role="status" aria-live="polite">
  <div class="icon" aria-hidden="true">
    <span></span>
  </div>
  <div class="copy">
    <h3>{title}</h3>
    <p>{message}</p>
    {#if detail}
      <code>{detail}</code>
    {/if}
  </div>
</section>

<style>
  .status {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid #a8d5b8;
    background: #f5fcf7;
    padding: 0.8rem 0.9rem;
  }

  .icon {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    border: 2px solid #1f8f4c;
    display: grid;
    place-items: center;
    margin-top: 0.05rem;
  }

  .icon span {
    width: 0.42rem;
    height: 0.24rem;
    border-left: 2px solid #1f8f4c;
    border-bottom: 2px solid #1f8f4c;
    transform: rotate(-45deg) translateY(-0.02rem);
  }

  .copy {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    color: #0f6b37;
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 0.89rem;
    color: #24563b;
    line-height: 1.35;
  }

  code {
    display: inline-block;
    margin-top: 0.15rem;
    padding: 0.22rem 0.38rem;
    border-radius: 0.35rem;
    border: 1px solid #a8d5b8;
    background: #fff;
    color: #154d2f;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
</style>
