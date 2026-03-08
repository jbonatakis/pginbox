<script lang="ts">
  export let title = "Something went wrong";
  export let message = "Please retry in a moment.";
  export let detail: string | null = null;
</script>

<section class="status error" role="alert">
  <div class="icon" aria-hidden="true">!</div>
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
    border: 1px solid #e7b4b8;
    background: #fff6f6;
    padding: 0.8rem 0.9rem;
  }

  .icon {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    border: 2px solid #d64545;
    color: #b42318;
    font-size: 0.67rem;
    font-weight: 700;
    display: grid;
    place-items: center;
    margin-top: 0.05rem;
  }

  .copy {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    color: #8a1c1c;
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 0.89rem;
    color: #7a1e21;
    line-height: 1.35;
  }

  code {
    display: inline-block;
    margin-top: 0.15rem;
    padding: 0.22rem 0.38rem;
    border-radius: 0.35rem;
    border: 1px solid #e7b4b8;
    background: #fff;
    color: #5d1018;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
</style>
