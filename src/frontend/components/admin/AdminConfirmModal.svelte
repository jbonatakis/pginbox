<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let title: string;
  export let message: string;
  export let confirmLabel = "Confirm";
  export let danger = false;

  const dispatch = createEventDispatcher<{ confirm: void; cancel: void }>();
</script>

<div class="modal-backdrop" role="presentation" on:click={() => dispatch("cancel")} on:keydown={() => {}}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-modal-title"
    on:click|stopPropagation
    on:keydown|stopPropagation
  >
    <h2 id="confirm-modal-title" class="modal-title">{title}</h2>
    <p class="modal-message">{message}</p>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" on:click={() => dispatch("cancel")}>Cancel</button>
      <button
        type="button"
        class="btn-confirm"
        class:btn-confirm-danger={danger}
        on:click={() => dispatch("confirm")}
      >{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(16, 42, 67, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.5rem;
    width: 100%;
    max-width: 24rem;
    display: grid;
    gap: 0.75rem;
    box-shadow:
      0 20px 40px -12px rgba(16, 42, 67, 0.3),
      0 8px 16px -8px rgba(16, 42, 67, 0.2);
  }

  .modal-title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text);
  }

  .modal-message {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .modal-actions {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-end;
    margin-top: 0.25rem;
  }

  .btn-cancel {
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-elevated);
    color: var(--text-subtle);
    font-size: 0.85rem;
    font-weight: 640;
    cursor: pointer;
  }

  .btn-cancel:hover {
    background: var(--bg);
  }

  .btn-confirm {
    padding: 0.45rem 0.9rem;
    border: 1px solid rgba(111, 159, 221, 0.76);
    border-radius: 0.5rem;
    background: var(--primary-soft);
    color: var(--primary);
    font-size: 0.85rem;
    font-weight: 640;
    cursor: pointer;
  }

  .btn-confirm:hover {
    background: #d4e8ff;
  }

  .btn-confirm-danger {
    border-color: var(--danger-border);
    background: var(--danger-soft);
    color: var(--danger);
  }

  .btn-confirm-danger:hover {
    background: #fde8e8;
  }
</style>
