<script lang="ts">
  export let eyebrow = "Account";
  export let title: string;
  export let intro: string | undefined = undefined;
</script>

<section class="auth-page">
  <div class="hero">
    <p class="eyebrow">{eyebrow}</p>
    <h1 class="page-title" data-route-heading tabindex="-1">{title}</h1>
    {#if intro}<p class="intro">{intro}</p>{/if}
    <slot name="lead"></slot>
  </div>

  <div class="card">
    <slot></slot>
  </div>
</section>

<style>
  .auth-page {
    width: min(100%, 58rem);
    min-width: 0;
    display: grid;
    align-content: start;
    gap: 1rem;
    margin: 0 auto;
    padding: clamp(0.25rem, 2vw, 1rem) 0 1.5rem;
  }

  .hero {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
  }

  .eyebrow {
    margin: 0;
    color: #0b4ea2;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .page-title {
    margin: 0;
    color: #102a43;
    font-size: clamp(1.9rem, 5vw, 2.8rem);
    line-height: 1.03;
    letter-spacing: -0.04em;
  }

  .intro {
    max-width: 42rem;
    margin: 0;
    color: #486581;
    font-size: 1rem;
    line-height: 1.5;
  }

  .card {
    display: grid;
    gap: 1rem;
    padding: clamp(1rem, 2vw, 1.4rem);
    border: 1px solid rgba(188, 204, 220, 0.9);
    border-radius: 1.1rem;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 251, 255, 0.96) 100%);
    box-shadow:
      0 24px 45px -34px rgba(16, 42, 67, 0.42),
      0 1px 0 rgba(255, 255, 255, 0.88) inset;
  }

  @media (max-width: 640px) {
    .auth-page {
      padding-bottom: 1rem;
    }

    .hero {
      gap: 0.35rem;
    }

    .page-title {
      font-size: clamp(1.8rem, 10vw, 2.3rem);
    }

    .card {
      border-radius: 0.95rem;
      padding: 0.95rem;
    }
  }
</style>
