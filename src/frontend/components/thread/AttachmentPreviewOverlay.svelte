<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { AttachmentSummary } from "shared/api";
  import { attachmentDownloadPath } from "../../lib/api";

  export let attachment: AttachmentSummary;
  export let canGoNext = false;
  export let canGoPrevious = false;
  export let currentIndex: number | null = null;
  export let content: string | null = null;
  export let errorMessage: string | null = null;
  export let isLoading = false;
  export let totalCount = 0;

  const dispatch = createEventDispatcher<{ close: void; next: void; previous: void }>();
  const sizeFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  });
  const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const HUNK_HEADER_ANYWHERE_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
  const GIT_DIFF_ANYWHERE_RE = /^diff --git /m;
  const BINARY_PATCH_ANYWHERE_RE = /^GIT binary patch$/m;
  const OLD_FILE_HEADER_ANYWHERE_RE = /^--- (?:a\/|\/dev\/null|\S+)/m;
  const NEW_FILE_HEADER_ANYWHERE_RE = /^\+\+\+ (?:b\/|\/dev\/null|\S+)/m;

  type PatchLineKind =
    | "file-meta"
    | "file-old"
    | "file-new"
    | "hunk"
    | "add"
    | "remove"
    | "context"
    | "plain"
    | "notice";

  interface PatchPreviewLine {
    kind: PatchLineKind;
    newLineNumber: number | null;
    oldLineNumber: number | null;
    raw: string;
  }

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

  const attachmentExtension = (value: AttachmentSummary): string => {
    const filename = value.filename?.trim() ?? "";
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex === -1 || dotIndex === filename.length - 1) return "";
    return filename.slice(dotIndex + 1).toLowerCase();
  };

  const hasPatchStructure = (previewContent: string | null): boolean => {
    const normalized = previewContent?.replace(/\r\n/g, "\n") ?? "";
    if (normalized.length === 0) return false;

    if (GIT_DIFF_ANYWHERE_RE.test(normalized)) return true;

    const hasUnifiedFileHeaders =
      OLD_FILE_HEADER_ANYWHERE_RE.test(normalized) &&
      NEW_FILE_HEADER_ANYWHERE_RE.test(normalized);
    const hasHunkHeaders = HUNK_HEADER_ANYWHERE_RE.test(normalized);
    if (hasUnifiedFileHeaders && hasHunkHeaders) return true;

    return hasUnifiedFileHeaders && BINARY_PATCH_ANYWHERE_RE.test(normalized);
  };

  const isPatchAttachment = (value: AttachmentSummary, previewContent: string | null): boolean => {
    const contentType = value.content_type?.toLowerCase() ?? "";
    const extension = attachmentExtension(value);

    if (
      contentType.includes("patch") ||
      contentType.includes("diff") ||
      extension === "patch" ||
      extension === "diff"
    ) {
      return true;
    }

    return hasPatchStructure(previewContent);
  };

  const parsePatchPreview = (previewContent: string): PatchPreviewLine[] => {
    const normalized = previewContent.replace(/\r\n/g, "\n");
    const lines = normalized.endsWith("\n")
      ? normalized.slice(0, -1).split("\n")
      : normalized.split("\n");
    const parsed: PatchPreviewLine[] = [];
    let oldLineNumber: number | null = null;
    let newLineNumber: number | null = null;
    let inHunk = false;

    for (const raw of lines) {
      const hunkHeaderMatch = raw.match(HUNK_HEADER_RE);
      if (hunkHeaderMatch) {
        oldLineNumber = Number(hunkHeaderMatch[1]);
        newLineNumber = Number(hunkHeaderMatch[2]);
        inHunk = true;
        parsed.push({
          kind: "hunk",
          oldLineNumber: null,
          newLineNumber: null,
          raw,
        });
        continue;
      }

      if (
        raw.startsWith("diff --git ") ||
        raw.startsWith("index ") ||
        raw.startsWith("new file mode ") ||
        raw.startsWith("deleted file mode ") ||
        raw.startsWith("similarity index ") ||
        raw.startsWith("rename from ") ||
        raw.startsWith("rename to ") ||
        raw.startsWith("Binary files ") ||
        raw.startsWith("GIT binary patch")
      ) {
        oldLineNumber = null;
        newLineNumber = null;
        inHunk = false;
        parsed.push({
          kind: "file-meta",
          oldLineNumber: null,
          newLineNumber: null,
          raw,
        });
        continue;
      }

      if (raw.startsWith("--- ")) {
        inHunk = false;
        parsed.push({
          kind: "file-old",
          oldLineNumber: null,
          newLineNumber: null,
          raw,
        });
        continue;
      }

      if (raw.startsWith("+++ ")) {
        inHunk = false;
        parsed.push({
          kind: "file-new",
          oldLineNumber: null,
          newLineNumber: null,
          raw,
        });
        continue;
      }

      if (raw === "\\ No newline at end of file") {
        parsed.push({
          kind: "notice",
          oldLineNumber: null,
          newLineNumber: null,
          raw,
        });
        continue;
      }

      if (inHunk && raw.startsWith("+")) {
        parsed.push({
          kind: "add",
          oldLineNumber: null,
          newLineNumber,
          raw,
        });
        if (newLineNumber !== null) newLineNumber += 1;
        continue;
      }

      if (inHunk && raw.startsWith("-")) {
        parsed.push({
          kind: "remove",
          oldLineNumber,
          newLineNumber: null,
          raw,
        });
        if (oldLineNumber !== null) oldLineNumber += 1;
        continue;
      }

      if (inHunk && raw.startsWith(" ")) {
        parsed.push({
          kind: "context",
          oldLineNumber,
          newLineNumber,
          raw,
        });
        if (oldLineNumber !== null) oldLineNumber += 1;
        if (newLineNumber !== null) newLineNumber += 1;
        continue;
      }

      parsed.push({
        kind: inHunk ? "file-meta" : "plain",
        oldLineNumber: null,
        newLineNumber: null,
        raw,
      });
    }

    return parsed;
  };

  const formatLineNumber = (value: number | null): string => (value === null ? "" : String(value));

  const close = (): void => {
    dispatch("close");
  };

  const goPrevious = (): void => {
    if (!canGoPrevious) return;
    dispatch("previous");
  };

  const goNext = (): void => {
    if (!canGoNext) return;
    dispatch("next");
  };

  const handleBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) close();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goPrevious();
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      goNext();
    }
  };

  $: showPatchPreview = content !== null && content !== "" && isPatchAttachment(attachment, content);
  $: patchLines = showPatchPreview && content ? parsePatchPreview(content) : [];
  $: attachmentPositionLabel =
    currentIndex === null || totalCount <= 1 ? null : `${currentIndex + 1} of ${totalCount}`;
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="overlay" role="presentation" on:click={handleBackdropClick}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-preview-title">
    <header class="dialog-header">
      <div class="header-copy">
        <h3 id="attachment-preview-title">{attachmentName(attachment)}</h3>
        <p>
          {#if attachmentPositionLabel}
            <span>{attachmentPositionLabel}</span>
          {/if}
          {#if formatBytes(attachment.size_bytes)}
            <span>{formatBytes(attachment.size_bytes)}</span>
          {/if}
          {#if attachment.content_type}
            <span>{attachment.content_type}</span>
          {/if}
        </p>
      </div>

      <div class="header-actions">
        <div class="nav-actions">
          <button class="nav-button" type="button" disabled={!canGoPrevious} on:click={goPrevious}
            >←</button
          >
          <button class="nav-button" type="button" disabled={!canGoNext} on:click={goNext}>→</button>
        </div>
        {#if attachment.has_content}
          <a class="download-button" href={attachmentDownloadPath(attachment.id)}>Download</a>
        {/if}
        <button class="close-button" type="button" on:click={close}>Close</button>
      </div>
    </header>

    {#if isLoading}
      <p class="status">Loading attachment preview…</p>
    {:else if errorMessage}
      <p class="status error">{errorMessage}</p>
    {:else if content === null || content === ""}
      <p class="status">No extracted attachment preview is available.</p>
    {:else if showPatchPreview}
      <div class="patch-preview" role="region" aria-label="Patch preview">
        {#each patchLines as line, index (`${index}:${line.kind}:${line.raw}`)}
          <div class={`patch-row patch-row-${line.kind}`}>
            <span class="line-no line-no-old">{formatLineNumber(line.oldLineNumber)}</span>
            <span class="line-no line-no-new">{formatLineNumber(line.newLineNumber)}</span>
            <code class="patch-code">{line.raw}</code>
          </div>
        {/each}
      </div>
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
    height: min(88vh, 60rem);
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

  .nav-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .nav-button,
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

  .nav-button {
    min-width: 2.2rem;
    cursor: pointer;
  }

  .download-button {
    text-decoration: none;
  }

  .nav-button:hover:not(:disabled),
  .download-button:hover,
  .close-button:hover {
    background: #dcedff;
  }

  .nav-button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .close-button {
    cursor: pointer;
  }

  .nav-button:focus-visible,
  .download-button:focus-visible,
  .close-button:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .status {
    margin: 0;
    padding: 1rem;
    height: 100%;
    color: #486581;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
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

  .patch-preview {
    overflow: auto;
    background: #f8fafc;
    color: #102a43;
    font-size: 0.84rem;
    line-height: 1.45;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    border-top: 1px solid #d9e2ec;
  }

  .patch-row {
    display: grid;
    grid-template-columns: 4.5rem 4.5rem minmax(0, 1fr);
    min-width: max-content;
  }

  .line-no {
    padding: 0 0.75rem;
    text-align: right;
    color: #7b8794;
    background: #f1f5f9;
    user-select: none;
    border-right: 1px solid #d9e2ec;
  }

  .patch-code {
    display: block;
    padding: 0 1rem;
    white-space: pre;
    color: inherit;
    font-family: inherit;
  }

  .patch-row-file-meta .patch-code,
  .patch-row-file-old .patch-code,
  .patch-row-file-new .patch-code,
  .patch-row-hunk .patch-code,
  .patch-row-plain .patch-code,
  .patch-row-notice .patch-code {
    padding-top: 0.12rem;
    padding-bottom: 0.12rem;
  }

  .patch-row-file-meta .line-no,
  .patch-row-file-old .line-no,
  .patch-row-file-new .line-no,
  .patch-row-hunk .line-no,
  .patch-row-plain .line-no,
  .patch-row-notice .line-no {
    color: transparent;
  }

  .patch-row-file-meta {
    background: #e9eef5;
    color: #243b53;
  }

  .patch-row-file-old {
    background: #fecaca;
    color: #7f1d1d;
  }

  .patch-row-file-new {
    background: #bbf7d0;
    color: #14532d;
  }

  .patch-row-hunk {
    background: #edf4ff;
    color: #1d4ed8;
  }

  .patch-row-add {
    background: #bbf7d0;
    color: #14532d;
  }

  .patch-row-remove {
    background: #fecaca;
    color: #7f1d1d;
  }

  .patch-row-context {
    background: #f8fafc;
    color: #1f2937;
  }

  .patch-row-plain {
    background: #f8fafc;
    color: #243b53;
  }

  .patch-row-notice {
    background: #f3f4f6;
    color: #4b5563;
    font-style: italic;
  }

  .patch-row-add .line-no {
    background: #86efac;
    color: #14532d;
  }

  .patch-row-remove .line-no {
    background: #fca5a5;
    color: #7f1d1d;
  }

  @media (max-width: 640px) {
    .overlay {
      padding: 0.5rem;
    }

    .dialog {
      height: 92vh;
    }

    .dialog-header {
      padding: 0.75rem 0.8rem;
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      justify-content: space-between;
    }

    .preview {
      padding: 0.85rem;
      font-size: 0.78rem;
    }

    .patch-preview {
      font-size: 0.78rem;
    }

    .patch-row {
      grid-template-columns: 3.4rem 3.4rem minmax(0, 1fr);
    }

    .line-no {
      padding: 0 0.45rem;
    }

    .patch-code {
      padding: 0 0.8rem;
    }
  }
</style>
