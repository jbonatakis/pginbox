<script lang="ts">
  export let emails: string[] = [];

  const emailHref = (email: string): string => `mailto:${encodeURIComponent(email)}`;

  $: normalizedEmails = Array.from(
    new Set(
      emails
        .map((email) => email.trim())
        .filter((email) => email.length > 0)
    )
  );
</script>

<article class="card" aria-label="Contributor emails">
  <h3>Associated emails</h3>

  {#if normalizedEmails.length > 0}
    <ul class="email-list">
      {#each normalizedEmails as email (email)}
        <li>
          <a href={emailHref(email)}>{email}</a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-message">No associated email addresses are available.</p>
  {/if}
</article>

<style>
  .card {
    margin: 0;
    border: 1px solid #d9e2ec;
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.92);
    padding: 0.75rem 0.85rem;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.96rem;
    color: #102a43;
  }

  .email-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .email-list li {
    margin: 0;
    padding: 0.32rem 0.45rem;
    border-radius: 0.45rem;
    border: 1px solid #d9e2ec;
    background: #f8fbff;
    min-width: 0;
  }

  .email-list a {
    color: #0b4ea2;
    font-size: 0.86rem;
    font-weight: 600;
    text-decoration-thickness: 1px;
    overflow-wrap: anywhere;
  }

  .email-list a:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
    border-radius: 0.15rem;
  }

  .empty-message {
    margin: 0;
    color: #627d98;
    font-size: 0.88rem;
    line-height: 1.35;
  }
</style>
