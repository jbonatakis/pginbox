<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AttachmentSummary } from "shared/api";
  import AttachmentPreviewOverlay from "./AttachmentPreviewOverlay.svelte";
  import { api, attachmentDownloadPath, toApiErrorShape } from "../../lib/api";

  export let attachments: AttachmentSummary[] = [];

  const countFormatter = new Intl.NumberFormat("en-US");
  const numberFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  });

  const attachmentCountLabel = (count: number): string => {
    if (count === 1) return "1 attachment";
    return `${countFormatter.format(count)} attachments`;
  };

  const attachmentName = (attachment: AttachmentSummary): string => {
    const filename = attachment.filename?.trim() ?? "";
    if (filename.length > 0) return filename;
    const contentType = attachment.content_type?.trim() ?? "";
    if (contentType.length > 0) return contentType;
    return "Unnamed attachment";
  };

  const attachmentExtension = (attachment: AttachmentSummary): string => {
    const filename = attachment.filename?.trim() ?? "";
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex === -1 || dotIndex === filename.length - 1) return "";
    return filename.slice(dotIndex + 1).toLowerCase();
  };

  const attachmentFamily = (attachment: AttachmentSummary): string => {
    const contentType = attachment.content_type?.toLowerCase() ?? "";
    const ext = attachmentExtension(attachment);

    if (
      contentType.includes("patch") ||
      contentType.includes("diff") ||
      ext === "patch" ||
      ext === "diff"
    ) {
      return "Patch";
    }
    if (contentType.startsWith("image/")) return "Image";
    if (contentType === "application/pdf" || ext === "pdf") return "PDF";
    if (
      contentType.includes("gzip") ||
      contentType.includes("zip") ||
      contentType.includes("tar") ||
      ext === "gz" ||
      ext === "tgz" ||
      ext === "zip" ||
      ext === "bz2"
    ) {
      return "Archive";
    }
    if (contentType.startsWith("text/") || contentType.includes("sql") || ext === "txt" || ext === "sql") {
      return "Text";
    }
    return "File";
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
    return `${numberFormatter.format(size)} ${units[unitIndex]}`;
  };

  const availabilityLabel = (attachment: AttachmentSummary): string =>
    attachment.has_content ? "Extracted text" : "Metadata only";

  const isPreviewable = (attachment: AttachmentSummary): boolean => attachment.has_content;

  let activeRequestController: AbortController | null = null;
  let previewAttachment: AttachmentSummary | null = null;
  let previewContent: string | null = null;
  let previewError: string | null = null;
  let previewLoading = false;

  const clearActiveRequest = (): void => {
    if (!activeRequestController) return;
    activeRequestController.abort();
    activeRequestController = null;
  };

  const closePreview = (): void => {
    clearActiveRequest();
    previewAttachment = null;
    previewContent = null;
    previewError = null;
    previewLoading = false;
  };

  const openPreview = async (attachment: AttachmentSummary): Promise<void> => {
    if (!isPreviewable(attachment)) return;

    clearActiveRequest();
    const requestController = new AbortController();
    activeRequestController = requestController;
    previewAttachment = attachment;
    previewContent = null;
    previewError = null;
    previewLoading = true;

    try {
      const detail = await api.attachments.get(attachment.id, {
        signal: requestController.signal,
      });
      if (activeRequestController !== requestController) return;
      previewContent = detail.content;
    } catch (rawError) {
      const error = toApiErrorShape(rawError);
      if (error.code === "ABORTED") return;
      if (activeRequestController !== requestController) return;
      previewError = error.message;
    } finally {
      if (activeRequestController === requestController) {
        activeRequestController = null;
      }
      if (previewAttachment?.id === attachment.id) {
        previewLoading = false;
      }
    }
  };

  onDestroy(() => {
    clearActiveRequest();
  });
</script>

{#if attachments.length > 0}
  {#if attachments.length <= 3}
    <section class="attachments" aria-label="Attachments">
      <p class="attachments-title">{attachmentCountLabel(attachments.length)}</p>

      <ul class="attachments-list">
        {#each attachments as attachment (`${attachment.id}:${attachment.filename ?? ""}:${attachment.content_type ?? ""}:${attachment.size_bytes ?? -1}`)}
          <li class="attachment-item">
            <div class="attachment-primary">
              <span class="family-pill">{attachmentFamily(attachment)}</span>
              {#if isPreviewable(attachment)}
                <div class="attachment-actions">
                  <button
                    class="attachment-open"
                    type="button"
                    aria-haspopup="dialog"
                    on:click={() => void openPreview(attachment)}
                  >
                    {attachmentName(attachment)}
                  </button>
                  <a class="attachment-download" href={attachmentDownloadPath(attachment.id)}>Download</a>
                </div>
              {:else}
                <strong>{attachmentName(attachment)}</strong>
              {/if}
            </div>

            <p class="attachment-meta">
              {#if formatBytes(attachment.size_bytes)}
                <span>{formatBytes(attachment.size_bytes)}</span>
              {/if}
              {#if attachment.content_type}
                <span>{attachment.content_type}</span>
              {/if}
              <span class:metadata-only={!attachment.has_content}>{availabilityLabel(attachment)}</span>
            </p>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <details class="attachments">
      <summary>{attachmentCountLabel(attachments.length)}</summary>

      <ul class="attachments-list">
        {#each attachments as attachment (`${attachment.id}:${attachment.filename ?? ""}:${attachment.content_type ?? ""}:${attachment.size_bytes ?? -1}`)}
          <li class="attachment-item">
            <div class="attachment-primary">
              <span class="family-pill">{attachmentFamily(attachment)}</span>
              {#if isPreviewable(attachment)}
                <div class="attachment-actions">
                  <button
                    class="attachment-open"
                    type="button"
                    aria-haspopup="dialog"
                    on:click={() => void openPreview(attachment)}
                  >
                    {attachmentName(attachment)}
                  </button>
                  <a class="attachment-download" href={attachmentDownloadPath(attachment.id)}>Download</a>
                </div>
              {:else}
                <strong>{attachmentName(attachment)}</strong>
              {/if}
            </div>

            <p class="attachment-meta">
              {#if formatBytes(attachment.size_bytes)}
                <span>{formatBytes(attachment.size_bytes)}</span>
              {/if}
              {#if attachment.content_type}
                <span>{attachment.content_type}</span>
              {/if}
              <span class:metadata-only={!attachment.has_content}>{availabilityLabel(attachment)}</span>
            </p>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
{/if}

{#if previewAttachment}
  <AttachmentPreviewOverlay
    attachment={previewAttachment}
    content={previewContent}
    errorMessage={previewError}
    isLoading={previewLoading}
    on:close={closePreview}
  />
{/if}

<style>
  .attachments {
    border-top: 1px solid #d9e2ec;
    padding-top: 0.55rem;
    display: grid;
    gap: 0.45rem;
  }

  .attachments-title {
    margin: 0;
    color: #0b4ea2;
    font-size: 0.84rem;
    font-weight: 700;
  }

  summary {
    cursor: pointer;
    color: #0b4ea2;
    font-size: 0.84rem;
    font-weight: 700;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: "+";
    display: inline-block;
    width: 0.9rem;
    margin-right: 0.15rem;
  }

  details[open] summary::before {
    content: "-";
  }

  .attachments-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.45rem;
  }

  .attachment-item {
    border: 1px solid #d9e2ec;
    border-radius: 0.55rem;
    background: #ffffff;
    padding: 0.5rem 0.6rem;
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .attachment-primary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
    min-width: 0;
  }

  strong {
    font-size: 0.84rem;
    color: #102a43;
    overflow-wrap: anywhere;
  }

  .attachment-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .attachment-open {
    border: 0;
    background: transparent;
    padding: 0;
    font: inherit;
    font-size: 0.84rem;
    font-weight: 700;
    color: #0b4ea2;
    cursor: pointer;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .attachment-open:hover {
    text-decoration: underline;
  }

  .attachment-open:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
    border-radius: 0.15rem;
  }

  .attachment-download {
    border: 1px solid #6f9fdd;
    border-radius: 999px;
    background: #e8f2ff;
    color: #0b4ea2;
    font-size: 0.74rem;
    font-weight: 700;
    line-height: 1;
    padding: 0.2rem 0.42rem;
    text-decoration: none;
    white-space: nowrap;
  }

  .attachment-download:hover {
    background: #dcedff;
  }

  .attachment-download:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .family-pill {
    border: 1px solid #bcccdc;
    border-radius: 999px;
    background: #f0f7ff;
    color: #243b53;
    font-size: 0.71rem;
    font-weight: 700;
    line-height: 1;
    padding: 0.18rem 0.38rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .attachment-meta {
    margin: 0;
    color: #486581;
    font-size: 0.78rem;
    line-height: 1.35;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    min-width: 0;
  }

  .attachment-meta span {
    overflow-wrap: anywhere;
  }

  .attachment-meta span + span::before {
    content: "/";
    margin-right: 0.35rem;
    color: #9fb3c8;
  }

  .metadata-only {
    color: #7b8794;
  }
</style>
