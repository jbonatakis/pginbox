<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { AdminUser } from "shared/api";
  import type { ApiErrorShape } from "../../lib/api";
  import { api, toApiErrorShape } from "../../lib/api";

  export let user: AdminUser;

  const dispatch = createEventDispatcher<{
    disabled: AdminUser;
    cancel: void;
  }>();

  let reason = "";
  let submitting = false;
  let error: ApiErrorShape | null = null;

  const handleSubmit = async (): Promise<void> => {
    if (!reason.trim()) return;
    submitting = true;
    error = null;
    try {
      const updated = await api.admin.disable(user.id, reason.trim());
      dispatch("disabled", updated);
    } catch (err) {
      error = toApiErrorShape(err);
    } finally {
      submitting = false;
    }
  };

  const handleCancel = (): void => {
    dispatch("cancel");
  };
</script>

<div class="modal-backdrop" role="presentation" on:click={handleCancel} on:keydown={() => {}}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="disable-modal-title"
    on:click|stopPropagation
    on:keydown|stopPropagation
  >
    <h2 id="disable-modal-title" class="modal-title">Disable account</h2>
    <p class="modal-desc">
      Disabling <strong>{user.email}</strong> will revoke all active sessions immediately.
    </p>

    <label class="field-label" for="disable-reason">Reason <span aria-hidden="true">*</span></label>
    <textarea
      id="disable-reason"
      class="reason-input"
      bind:value={reason}
      placeholder="Explain why this account is being disabled..."
      rows={3}
      disabled={submitting}
    ></textarea>

    {#if error}
      <p class="error-msg" role="alert">{error.message}</p>
    {/if}

    <div class="modal-actions">
      <button type="button" class="btn-cancel" on:click={handleCancel} disabled={submitting}>
        Cancel
      </button>
      <button
        type="button"
        class="btn-disable"
        on:click={handleSubmit}
        disabled={submitting || !reason.trim()}
      >
        {submitting ? "Disabling..." : "Disable account"}
      </button>
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
    max-width: 28rem;
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

  .modal-desc {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
  }

  .field-label {
    font-size: 0.82rem;
    font-weight: 640;
    color: var(--text-subtle);
  }

  .reason-input {
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg);
    color: var(--text);
    font-size: 0.88rem;
    font-family: inherit;
    resize: vertical;
    box-sizing: border-box;
  }

  .reason-input:focus {
    outline: 3px solid var(--focus-ring-color);
    outline-offset: 2px;
    border-color: var(--primary);
  }

  .error-msg {
    margin: 0;
    font-size: 0.85rem;
    color: var(--danger);
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

  .btn-cancel:hover:not(:disabled) {
    background: var(--bg);
  }

  .btn-disable {
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--danger-border);
    border-radius: 0.5rem;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 0.85rem;
    font-weight: 640;
    cursor: pointer;
  }

  .btn-disable:hover:not(:disabled) {
    background: #fde8e8;
  }

  .btn-disable:disabled,
  .btn-cancel:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
