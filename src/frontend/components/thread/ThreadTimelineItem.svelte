<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { MessageWithAttachments } from "shared/api";
  import { parseMessageBody, type MessageBodyBlock } from "../../lib/messageBody";
  import { postgresqlArchiveMessageUrl } from "../../lib/postgresqlArchive";
  import ThreadMessageAttachments from "./ThreadMessageAttachments.svelte";

  export let message: MessageWithAttachments;
  export let index: number;
  export let anchorId: string;
  export let isCollapsed = false;

  let sender = "Unknown sender";
  let subject: string | null = null;
  let validTimestamp = false;
  let sentAtLabel = "Unknown time";
  let bodyBlocks: MessageBodyBlock[] = [];
  let archiveUrl: string | null = null;
  const dispatch = createEventDispatcher<{ toggle: void }>();

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const senderLabel = (fromName: string | null, fromEmail: string | null): string => {
    const normalizedName = fromName?.trim() ?? "";
    const normalizedEmail = fromEmail?.trim() ?? "";

    if (normalizedName.length > 0 && normalizedEmail.length > 0) {
      return `${normalizedName} <${normalizedEmail}>`;
    }
    if (normalizedName.length > 0) return normalizedName;
    if (normalizedEmail.length > 0) return normalizedEmail;
    return "Unknown sender";
  };

  const normalizedSubject = (subject: string | null): string | null => {
    const normalized = subject?.trim() ?? "";
    return normalized.length > 0 ? normalized : null;
  };

  const isValidTimestamp = (value: string | null): boolean => {
    if (!value) return false;
    return !Number.isNaN(new Date(value).getTime());
  };

  const timestampLabel = (value: string | null): string => {
    if (!value) return "Unknown time";

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown time";
    return dateFormatter.format(parsed);
  };

  const collapseToggleLabel = (collapsed: boolean, messageIndex: number): string =>
    collapsed ? `Expand message ${messageIndex + 1}` : `Collapse message ${messageIndex + 1}`;

  $: sender = senderLabel(message.from_name, message.from_email);
  $: subject = normalizedSubject(message.subject);
  $: validTimestamp = isValidTimestamp(message.sent_at);
  $: sentAtLabel = timestampLabel(message.sent_at);
  $: bodyBlocks = parseMessageBody(message.body);
  $: archiveUrl = postgresqlArchiveMessageUrl(message.message_id);
</script>

<article class="timeline-item" id={anchorId} aria-labelledby={`${anchorId}-heading`}>
  <header class="timeline-item-header">
    <div class="title-row">
      <h4 id={`${anchorId}-heading`}>
        <a class="anchor-link" href={`#${anchorId}`}>#{index + 1}</a>
      </h4>

      <button
        class="collapse-toggle"
        type="button"
        aria-controls={`${anchorId}-content`}
        aria-expanded={!isCollapsed}
        aria-label={collapseToggleLabel(isCollapsed, index)}
        title={collapseToggleLabel(isCollapsed, index)}
        on:click={() => dispatch("toggle")}
      >
        <svg
          class:collapse-icon={true}
          class:collapse-icon--expanded={!isCollapsed}
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path
            d="M7 4l6 6-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <p class="meta">
      <span class="sender">{sender}</span>
      <span aria-hidden="true">·</span>
      {#if validTimestamp && message.sent_at}
        <time datetime={message.sent_at}>{sentAtLabel}</time>
      {:else}
        <span>{sentAtLabel}</span>
      {/if}
      {#if archiveUrl}
        <span aria-hidden="true">·</span>
        <a
          class="meta-link"
          href={archiveUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open original message in PostgreSQL mailing archive"
        >
          View in archive
        </a>
      {/if}
    </p>

    {#if subject}
      <p class="subject">
        <span>Subject:</span> {subject}
      </p>
    {/if}
  </header>

  <div class="message-content" id={`${anchorId}-content`} hidden={isCollapsed}>
    <div class="body" aria-label="Message body">
      {#each bodyBlocks as block}
        <div
          class:body-block={true}
          class:body-block--quote={block.type === "quote"}
          style={block.type === "quote" ? `--quote-depth: ${block.depth};` : undefined}
        >
          {#each block.parts as part}
            {#if part.type === "link"}
              <a class="body-link" href={part.href} target="_blank" rel="noopener noreferrer"
                >{part.value}</a
              >
            {:else}
              {part.value}
            {/if}
          {/each}
        </div>
      {/each}
    </div>

    <ThreadMessageAttachments attachments={message.attachments} />
  </div>
</article>

<style>
  .timeline-item {
    border: 1px solid #d9e2ec;
    border-radius: 0.65rem;
    background: #f8fbff;
    padding: 0.7rem;
    display: grid;
    gap: 0.55rem;
    min-width: 0;
    scroll-margin-top: 1rem;
  }

  .timeline-item-header {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }

  h4 {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1.25;
    min-width: 0;
  }

  .anchor-link {
    color: #0b4ea2;
    text-decoration-thickness: 1px;
  }

  .anchor-link:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .collapse-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    flex: 0 0 auto;
    border: 1px solid #bcccdc;
    border-radius: 999px;
    background: #ffffff;
    color: #486581;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      color 120ms ease,
      background-color 120ms ease;
  }

  .collapse-toggle:hover {
    border-color: #9fb3c8;
    background: #f0f7ff;
    color: #102a43;
  }

  .collapse-toggle:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .collapse-icon {
    width: 0.95rem;
    height: 0.95rem;
    transition: transform 160ms ease;
  }

  .collapse-icon--expanded {
    transform: rotate(90deg);
  }

  .meta {
    margin: 0;
    font-size: 0.82rem;
    color: #486581;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem;
    min-width: 0;
  }

  .sender {
    font-weight: 600;
    color: #102a43;
    overflow-wrap: anywhere;
  }

  .meta time,
  .meta span {
    overflow-wrap: anywhere;
  }

  .meta-link {
    color: #627d98;
    font-weight: 500;
    text-decoration-thickness: 1px;
    text-decoration-color: rgba(98, 125, 152, 0.45);
  }

  .meta-link:hover {
    color: #486581;
    text-decoration-color: currentColor;
  }

  .meta-link:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }

  .subject {
    margin: 0;
    font-size: 0.84rem;
    color: #334e68;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .subject span {
    font-weight: 700;
  }

  .message-content {
    display: grid;
    gap: 0.55rem;
    min-width: 0;
  }

  .message-content[hidden] {
    display: none;
  }

  .body {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  .body-block {
    font-size: 0.9rem;
    line-height: 1.45;
    color: #102a43;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
  }

  .body-block--quote {
    --quote-step: 0.9rem;
    color: #486581;
    padding-left: calc(0.7rem + (var(--quote-depth, 1) * var(--quote-step)));
    background-image: repeating-linear-gradient(
      to right,
      #9fb3c8 0,
      #9fb3c8 0.18rem,
      transparent 0.18rem,
      transparent var(--quote-step)
    );
    background-repeat: no-repeat;
    background-size: calc(var(--quote-depth, 1) * var(--quote-step)) 100%;
  }

  .body-link {
    color: #0b4ea2;
    text-decoration-thickness: 1px;
  }

  .body-link:focus-visible {
    outline: 2px solid #0b4ea2;
    outline-offset: 2px;
  }
</style>
