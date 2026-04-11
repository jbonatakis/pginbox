const JMAP_CORE_CAPABILITY = "urn:ietf:params:jmap:core";
const JMAP_MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

interface JmapSessionResponse {
  apiUrl?: string;
  capabilities?: Record<string, Record<string, unknown>>;
  downloadUrl?: string;
  eventSourceUrl?: string;
  primaryAccounts?: Record<string, string>;
}

interface JmapMethodResponseEnvelope {
  methodResponses?: Array<[string, Record<string, unknown>, string]>;
}

interface JmapMailboxRecord {
  id: string;
  name: string;
  parentId: string | null;
}

interface JmapEmailGetRecord {
  blobId: string;
  id: string;
  mailboxIds?: Record<string, boolean>;
  receivedAt?: string | null;
  "header:Message-ID:asText"?: string | null;
}

interface JmapQueryChangesResponse {
  added?: Array<{ id?: string; index?: number }>;
  newQueryState?: string;
}

interface JmapQueryResponse {
  ids?: string[];
  queryState?: string;
}

interface JmapGetResponse<T> {
  list?: T[];
}

export interface FastmailRuntimeConfig {
  apiToken: string;
  pushPingSeconds: number;
  queryPageSize: number;
  sessionUrl: string;
}

export interface TrackedMailboxRecord {
  listId: number;
  listName: string;
  sourceFolder: string;
}

export interface ResolvedTrackedMailbox extends TrackedMailboxRecord {
  mailboxId: string;
}

export interface FastmailMessageEnvelope {
  blobId: string;
  id: string;
  mailboxIds: string[];
  messageIdHeader: string | null;
  receivedAt: string | null;
}

export interface MailboxQueryPage {
  messages: FastmailMessageEnvelope[];
  queryState: string;
}

export interface FastmailPushEvent {
  data: string;
  event: string;
  id: string | null;
}

export interface FastmailSession {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  eventSourceUrl: string;
  maxObjectsInGet: number | null;
}

export class FastmailJmapError extends Error {
  constructor(
    message: string,
    readonly details: {
      description?: string;
      methodName?: string;
      type?: string;
    } = {},
  ) {
    const decoratedMessage =
      details.type || details.description
        ? `${message}${
            details.type ? ` [${details.type}]` : ""
          }${details.description ? ` ${details.description}` : ""}`
        : message;
    super(decoratedMessage);
    this.name = "FastmailJmapError";
  }
}

export function buildMailboxPathMap(
  mailboxes: readonly Pick<JmapMailboxRecord, "id" | "name" | "parentId">[],
): Map<string, string> {
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const cache = new Map<string, string>();

  const resolvePath = (mailboxId: string): string => {
    const cached = cache.get(mailboxId);
    if (cached) {
      return cached;
    }

    const mailbox = byId.get(mailboxId);
    if (!mailbox) {
      throw new FastmailJmapError(`Mailbox ${mailboxId} is missing from Mailbox/get`);
    }

    const path = mailbox.parentId ? `${resolvePath(mailbox.parentId)}/${mailbox.name}` : mailbox.name;
    cache.set(mailboxId, path);
    return path;
  };

  for (const mailbox of mailboxes) {
    resolvePath(mailbox.id);
  }

  return cache;
}

function buildAuthHeaders(apiToken: string, extraHeaders?: HeadersInit): Headers {
  const headers = new Headers(extraHeaders);
  headers.set("authorization", `Bearer ${apiToken}`);
  return headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new FastmailJmapError(`Fastmail request failed with HTTP ${response.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

function buildDownloadUrl(downloadUrlTemplate: string, accountId: string, blobId: string): string {
  return downloadUrlTemplate
    .replaceAll("{accountId}", encodeURIComponent(accountId))
    .replaceAll("{blobId}", encodeURIComponent(blobId))
    .replaceAll("{name}", encodeURIComponent("message.eml"))
    .replaceAll("{type}", encodeURIComponent("message/rfc822"));
}

function buildEventSourceUrl(template: string, types: string, pingSeconds: number): string {
  return template
    .replaceAll("{types}", encodeURIComponent(types))
    .replaceAll("{closeafter}", encodeURIComponent("no"))
    .replaceAll("{ping}", encodeURIComponent(String(pingSeconds)));
}

async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<FastmailPushEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId: string | null = null;
  let eventName = "message";
  let dataLines: string[] = [];

  const flush = (): FastmailPushEvent | null => {
    if (dataLines.length === 0 && eventId == null && eventName === "message") {
      return null;
    }

    const event: FastmailPushEvent = {
      data: dataLines.join("\n"),
      event: eventName,
      id: eventId,
    };
    eventId = null;
    eventName = "message";
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          const event = flush();
          if (event) {
            yield event;
          }
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        const separatorIndex = line.indexOf(":");
        const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
        const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
        const valueText = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

        if (field === "data") {
          dataLines.push(valueText);
        } else if (field === "event") {
          eventName = valueText || "message";
        } else if (field === "id") {
          eventId = valueText || null;
        }
      }
    }

    if (buffer.length > 0) {
      const trailingLines = buffer.split(/\r?\n/);
      for (const line of trailingLines) {
        if (!line) {
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }

    const trailingEvent = flush();
    if (trailingEvent) {
      yield trailingEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

export class FastmailJmapClient {
  #sessionPromise: Promise<FastmailSession> | null = null;

  constructor(
    private readonly runtime: FastmailRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getSession(): Promise<FastmailSession> {
    if (this.#sessionPromise) {
      return this.#sessionPromise;
    }

    this.#sessionPromise = (async () => {
      const response = await this.fetchImpl(this.runtime.sessionUrl, {
        headers: buildAuthHeaders(this.runtime.apiToken, {
          accept: "application/json",
        }),
      });
      const session = await parseJsonResponse<JmapSessionResponse>(response);
      const accountId = session.primaryAccounts?.[JMAP_MAIL_CAPABILITY];
      if (!accountId || !session.apiUrl || !session.downloadUrl || !session.eventSourceUrl) {
        throw new FastmailJmapError("Fastmail session response is missing required JMAP mail fields");
      }

      const maxObjectsInGetRaw = session.capabilities?.[JMAP_CORE_CAPABILITY]?.maxObjectsInGet;
      const maxObjectsInGet =
        typeof maxObjectsInGetRaw === "number" && Number.isFinite(maxObjectsInGetRaw)
          ? maxObjectsInGetRaw
          : null;

      return {
        accountId,
        apiUrl: session.apiUrl,
        downloadUrl: session.downloadUrl,
        eventSourceUrl: session.eventSourceUrl,
        maxObjectsInGet,
      };
    })();

    return this.#sessionPromise;
  }

  async resolveTrackedMailboxes(
    trackedMailboxes: readonly TrackedMailboxRecord[],
  ): Promise<ResolvedTrackedMailbox[]> {
    if (trackedMailboxes.length === 0) {
      return [];
    }

    const { accountId } = await this.getSession();
    const response = await this.#callMethod<JmapGetResponse<JmapMailboxRecord>>("Mailbox/get", {
      accountId,
      properties: ["id", "name", "parentId"],
    });

    const mailboxes = response.list ?? [];
    const pathMap = buildMailboxPathMap(mailboxes);
    const mailboxIdByPath = new Map<string, string>();
    for (const [mailboxId, path] of pathMap.entries()) {
      mailboxIdByPath.set(path, mailboxId);
    }

    return trackedMailboxes.map((trackedMailbox) => {
      const mailboxId = mailboxIdByPath.get(trackedMailbox.sourceFolder);
      if (!mailboxId) {
        throw new FastmailJmapError(
          `Fastmail mailbox "${trackedMailbox.sourceFolder}" was not found`,
          { type: "mailboxNotFound" },
        );
      }

      return {
        ...trackedMailbox,
        mailboxId,
      };
    });
  }

  async queryMailboxPage(
    mailboxId: string,
    options: {
      limit?: number;
      position?: number;
    } = {},
  ): Promise<MailboxQueryPage> {
    const limit = options.limit ?? this.runtime.queryPageSize;
    const position = options.position ?? 0;
    const { accountId } = await this.getSession();
    const query = await this.#callMethod<JmapQueryResponse>("Email/query", {
      accountId,
      calculateTotal: false,
      filter: { inMailbox: mailboxId },
      limit,
      position,
      sort: [{ isAscending: true, property: "receivedAt" }],
    });

    const ids = query.ids ?? [];
    const messages = await this.#getEmailsByIds(accountId, ids);
    return {
      messages: this.#sortMessagesOldestFirst(messages),
      queryState: query.queryState ?? "",
    };
  }

  async queryMailboxChanges(
    mailboxId: string,
    sinceQueryState: string,
  ): Promise<{ messages: FastmailMessageEnvelope[]; queryState: string }> {
    const { accountId } = await this.getSession();
    const changes = await this.#callMethod<JmapQueryChangesResponse>("Email/queryChanges", {
      accountId,
      calculateTotal: false,
      filter: { inMailbox: mailboxId },
      sinceQueryState,
      sort: [{ isAscending: true, property: "receivedAt" }],
    });

    const addedIds = (changes.added ?? [])
      .slice()
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .flatMap((entry) => (entry.id ? [entry.id] : []));
    const messages = await this.#getEmailsByIds(accountId, addedIds);
    return {
      messages: this.#sortMessagesOldestFirst(messages),
      queryState: changes.newQueryState ?? sinceQueryState,
    };
  }

  async downloadMessageBlob(blobId: string): Promise<Uint8Array> {
    const session = await this.getSession();
    const response = await this.fetchImpl(
      buildDownloadUrl(session.downloadUrl, session.accountId, blobId),
      {
        headers: buildAuthHeaders(this.runtime.apiToken),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new FastmailJmapError(
        `Fastmail blob download failed with HTTP ${response.status}: ${text}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async *streamPushEvents(lastEventId: string | null): AsyncGenerator<FastmailPushEvent> {
    const session = await this.getSession();
    const response = await this.fetchImpl(
      buildEventSourceUrl(session.eventSourceUrl, "Mailbox,Email", this.runtime.pushPingSeconds),
      {
        headers: buildAuthHeaders(this.runtime.apiToken, {
          accept: "text/event-stream",
          ...(lastEventId ? { "last-event-id": lastEventId } : {}),
        }),
      },
    );

    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new FastmailJmapError(
        `Fastmail push stream failed with HTTP ${response.status}: ${text}`,
      );
    }

    yield* readServerSentEvents(response.body);
  }

  async #callMethod<T>(
    methodName: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<T> {
    const session = await this.getSession();
    const response = await this.fetchImpl(session.apiUrl, {
      body: JSON.stringify({
        methodCalls: [[methodName, argumentsObject, "0"]],
        using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
      }),
      headers: buildAuthHeaders(this.runtime.apiToken, {
        accept: "application/json",
        "content-type": "application/json",
      }),
      method: "POST",
    });
    const envelope = await parseJsonResponse<JmapMethodResponseEnvelope>(response);
    const methodResponse = envelope.methodResponses?.[0];
    if (!methodResponse) {
      throw new FastmailJmapError(`Fastmail JMAP response for ${methodName} was empty`);
    }

    const [responseName, payload] = methodResponse;
    if (responseName === "error") {
      throw new FastmailJmapError(
        `Fastmail JMAP ${methodName} failed`,
        {
          description:
            typeof payload.description === "string" ? payload.description : undefined,
          methodName,
          type: typeof payload.type === "string" ? payload.type : undefined,
        },
      );
    }

    return payload as T;
  }

  async #getEmailsByIds(accountId: string, ids: readonly string[]): Promise<FastmailMessageEnvelope[]> {
    if (ids.length === 0) {
      return [];
    }

    const session = await this.getSession();
    const chunkSize = Math.max(1, session.maxObjectsInGet ?? 50);
    const messages: FastmailMessageEnvelope[] = [];

    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const response = await this.#callMethod<JmapGetResponse<JmapEmailGetRecord>>("Email/get", {
        accountId,
        ids: chunk,
        properties: ["id", "blobId", "receivedAt", "mailboxIds"],
      });

      for (const item of response.list ?? []) {
        messages.push({
          blobId: item.blobId,
          id: item.id,
          mailboxIds: Object.keys(item.mailboxIds ?? {}),
          messageIdHeader: null,
          receivedAt: item.receivedAt ?? null,
        });
      }
    }

    return messages;
  }

  #sortMessagesOldestFirst(messages: readonly FastmailMessageEnvelope[]): FastmailMessageEnvelope[] {
    return messages.slice().sort((left, right) => {
      const leftKey = left.receivedAt ?? "";
      const rightKey = right.receivedAt ?? "";
      if (leftKey !== rightKey) {
        return leftKey.localeCompare(rightKey);
      }

      return left.id.localeCompare(right.id);
    });
  }
}
