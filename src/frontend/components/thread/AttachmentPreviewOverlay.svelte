<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { AttachmentSummary } from "shared/api";
  import { attachmentDownloadPath } from "../../lib/api";

  export let attachment: AttachmentSummary;
  export let content: string | null = null;
  export let errorMessage: string | null = null;
  export let isLoading = false;

  const dispatch = createEventDispatcher<{ close: void }>();
  const sizeFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  });

  const attachmentName = (value: AttachmentSummary): string => {
    const filename = value.filename?.trim() ?? "";
    if (filename.length > 0) return filename;
    const contentType = value.content_type?.trim() ?? "";
    if (contentType.length > 0) return contentType;
    return "Unnamed attachment";
  };

  const formatBytes = (value: number | null): string | null => {
    if (value === null || value < 0) return null;
    if (value < 1024) return `${value} B`;

    const units = ["KB", "MB", "GB"];
    let size = value / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${sizeFormatter.format(size)} ${units[unitIndex]}`;
  };

  const close = (): void => {
    dispatch("close");
  };

  const handleBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) close();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="overlay" role="presentation" on:click={handleBackdropClick}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title">
    <header class="dialog-header">
      <div class="header-copy">
        <h3 id="attachment-preview-title">{attachmentName(attachment)}</h3>
        <p>
          {#if formatBytes(attachment.size_bytes)}
            <span>{formatBytes(attachment.size_bytes)}</span>
          {/if}
          {#if attachment.content_type}
            <span>{attachment.content_type}</span>
          {/if}
        </p>
      </div>

      <div class="header-actions">
        <a class="download-button" href={attachmentDownloadPath(attachment.id)}>Download</a>
        <button class="close-button" type="button" on:click={close}>Close</button>
      </div>
    </header>

    {#if isLoading}
      <p class="status">Loading attachment preview…</p>
    {:else if errorMessage}
      <p class="status error">{errorMessage}</p>
    {:else if content === null || content === ""}
      <p class="status">No extracted attachment preview is available.</p>
    {:else}
      <pre class="preview"><code>{content}</code></pre>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.62);
    display: grid;
    place-items: center;
    padding: 1rem;
  }

  .dialog {
    width: min(72rem, 100%);
    max-height: min(88vh, 60rem);
    background: #f8fbff;
    border: 1px solid #bcccdc;
    border-radius: 0.9rem;
    box-shadow: 0 24px 80px rgba(15, 23, 42, 0.32);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .dialog-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.85rem 0.95rem;
    border-bottom: 1px solid #d9e2ec;
    background: #ffffff;
  }

  .header-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    color: #102a43;
    overflow-wrap: anywhere;
  }

  p {
    margin: 0;
    color: #486581;
    font-size: 0.8rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  p span + span::before {
    content: "/";
    margin-right: 0.35rem;
    color: #9fb3c8;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .download-button,
  .close-button {
    border: 1px solid #6f9fdd;
    border-radius: 0.55rem;
    background: #e8f2ff;
    color: #0b4ea2;
    font-weight: 650;
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.45rem 0.65rem;
    white-space: nowrap;
  }

  .download-button {
    text-decoration: none;
  }

  .download-button:hover,
  .close-button:hover {
    background: #dcedff;
  }

  .close-button {
    cursor: pointer;
  }

  .download-button:focus-visible,
  .close-button:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .status {
    margin: 0;
    padding: 1rem;
    color: #486581;
    font-size: 0.9rem;
  }

  .error {
    color: #9b1c1c;
  }

  .preview {
    margin: 0;
    padding: 1rem;
    overflow: auto;
    background: #102a43;
    color: #f0f4f8;
    font-size: 0.84rem;
    line-height: 1.45;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre;
  }

  .preview code {
    font-family: inherit;
  }

  @media (max-width: 640px) {
    .overlay {
      padding: 0.5rem;
    }

    .dialog {
      max-height: 92vh;
    }

    .dialog-header {
      padding: 0.75rem 0.8rem;
    }

    .preview {
      padding: 0.85rem;
      font-size: 0.78rem;
    }
  }
</style>
