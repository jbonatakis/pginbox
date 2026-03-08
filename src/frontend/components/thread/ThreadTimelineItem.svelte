<script lang="ts">
  import type { Message } from "shared/api";

  export let message: Message;
  export let index: number;
  export let anchorId: string;

  let sender = "Unknown sender";
  let subject: string | null = null;
  let validTimestamp = false;
  let sentAtLabel = "Unknown time";

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

  const bodyText = (value: string | null): string => {
    if (value === null || value === "") return "No message body available.";
    return value;
  };

  $: sender = senderLabel(message.from_name, message.from_email);
  $: subject = normalizedSubject(message.subject);
  $: validTimestamp = isValidTimestamp(message.sent_at);
  $: sentAtLabel = timestampLabel(message.sent_at);
</script>

<article class="timeline-item" id={anchorId} aria-labelledby={`${anchorId}-heading`}>
  <header class="timeline-item-header">
    <h4 id={`${anchorId}-heading`}>
      <a class="anchor-link" href={`#${anchorId}`}>Message {index + 1}</a>
    </h4>

    <p class="meta">
      <span class="sender">{sender}</span>
      <span aria-hidden="true">·</span>
      {#if validTimestamp && message.sent_at}
        <time datetime={message.sent_at}>{sentAtLabel}</time>
      {:else}
        <span>{sentAtLabel}</span>
      {/if}
    </p>

    {#if subject}
      <p class="subject">
        <span>Subject:</span> {subject}
      </p>
    {/if}
  </header>

  <p class="body">{bodyText(message.body)}</p>
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

  .body {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.45;
    color: #102a43;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
</style>
