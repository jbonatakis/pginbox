# Semantic Chunking

This document defines a proposed chunking and indexing strategy for semantic search in `pginbox`.

It is intentionally about corpus preparation and retrieval units, not the frontend search-session flow. That API/URL contract is described in [`docs/FRONTEND_DESIGN.md`](./FRONTEND_DESIGN.md).

## Goals

The chunking strategy should:

- preserve enough reply context for short mailing-list responses to remain meaningful
- reduce duplicate quoted history so embeddings are not dominated by repeated thread text
- handle the common PostgreSQL mailing-list pattern of quote-first replies
- handle interleaved review mails where quotes and responses alternate
- treat text-bearing attachments as first-class searchable content
- avoid using whole threads as the only semantic unit
- support hybrid retrieval and later reranking

## Non-goals

This document does not define:

- the end-user semantic query UX
- the search-session API shape
- the embedding model choice
- the final answer synthesis or citation UX

## Corpus observations

The following observations come from a read-only pass over the local development database on March 15, 2026.

- `messages`: `250,771`
- `messages` with non-empty `body`: `250,704`
- `threads`: `31,476`
- `attachments`: `78,842`
- `attachments` with non-empty `content`: `75,619`

Message body size distribution:

- median: `1,308` chars
- p90: `4,282`
- p99: `25,862`
- max: `2,123,695`

Thread message-count distribution:

- median: `1`
- p90: `18`
- p99: `94`
- max: `936`

Thread total-text distribution:

- median: `7,014` chars
- p90: `46,766`
- p99: `282,849`
- max: `2,942,034`

Attachment content size distribution:

- median: `9,472` chars
- p90: `66,147`
- p99: `318,562`
- max: `33,385,745`

Reply and quote signals:

- messages containing `>` quote lines: `209,677 / 250,704`
- messages with `in_reply_to`: `220,057 / 250,771`
- messages with `refs`: `212,908 / 250,771`

Quote-ordering signal:

- messages whose trimmed body literally starts with `>`: `12,368`
- messages with quotes later in the body: `197,348`

That last result does not mean quote-first replies are rare. In practice, many messages start with a greeting or a reply header such as `On ... wrote:` and then move into a quote block before the authored response. The chunker should therefore reason in terms of block order, not just the first byte of the message body.

## High-level approach

The primary semantic unit should be the message or attachment chunk, not the whole thread.

Whole-thread embeddings are too coarse for this corpus:

- most threads are small, but the long tail is very large
- quoted history repeats aggressively across replies
- inline review often contains multiple distinct semantic units inside one message

The recommended indexing model is:

1. parse each message body into structured blocks
2. emit one or more quote-aware chunks from the message
3. emit one or more chunks from text-bearing attachments
4. embed those chunks
5. use thread structure and keyword search for reranking and answer assembly

## Message parsing model

Each message body should be normalized and then segmented into ordered blocks.

### Normalization

Before block parsing:

- convert `\r\n` to `\n`
- trim leading and trailing blank lines
- preserve original text separately for display
- detect and mark obvious trailers such as signature separators (`-- `)
- detect common reply headers such as `On ... wrote:`

### Block types

Each contiguous run of lines should be classified as one of:

- `header`: reply headers such as `On ... wrote:`
- `quote`: lines beginning with `>`
- `author`: non-quoted prose written in the current message
- `patch_or_code`: diff hunks, code blocks, logs, stack traces, shell output
- `signature`: signatures and footer boilerplate
- `blank`: blank-line separators

### Block metadata

For each block, store at least:

- `block_index`
- `kind`
- `quote_depth` for quote blocks
- `char_length`
- `line_count`
- `start_line`
- `end_line`

For message-level metadata, store at least:

- `message_id`
- `thread_id`
- `list_id`
- `in_reply_to`
- `sent_at`
- `subject`

## Quote-aware chunking rules

The chunker should preserve nearby quote context when it is necessary for meaning, but drop deep or repeated quote history by default.

### Rule 1: Prefer authored text

If a message contains substantive authored text, that authored text is the center of the chunk.

The quote is supporting context, not the main payload, unless the message is essentially a quoted review with tiny replies.

### Rule 2: Keep a small quote anchor

For a direct reply, attach the nearest preceding `quote` block at depth `1` when:

- the authored block is short or medium length
- the quote is adjacent or separated only by a reply header or blank line
- the quote provides the local point being answered

Default behavior:

- keep one nearby depth-`1` quote block
- drop depth `>= 2` quote history
- cap the kept quote anchor to a modest size

A good first-pass cap is:

- keep up to `800` chars of quote anchor by default
- allow up to `1,500` chars when the authored reply is very short

### Rule 3: Drop deep quote history aggressively

Quoted history should be treated as compression candidates.

Default behavior:

- drop depth `>= 2` quote blocks
- drop repeated quote tails after the first relevant anchor
- drop long quoted preambles if the message later contains a more local quote/reply pair

### Rule 4: Pair interleaved review blocks

If a message alternates between quote and authored reply:

```text
> quoted point A
reply A

> quoted point B
reply B
```

emit separate chunks for each quote/reply pair rather than one chunk for the entire email.

This is especially important for:

- review threads
- patch review
- design point-by-point feedback
- bug triage mail

### Rule 5: Expand short replies

Very short cleaned replies often become ambiguous if embedded alone.

If the authored text is small after cleaning, do not embed it by itself.

A good first-pass threshold is:

- if cleaned authored text is `< 200` chars, embed `quote anchor + reply`
- if there is no usable quote anchor, expand with parent-message context via `in_reply_to`

### Rule 6: Do not index quote-only messages as standalone semantic units

If a message has little or no authored text after removing signatures and deep quotes, it should usually not produce an independent chunk.

Instead:

- rely on the parent message or neighboring chunks for retrieval
- keep the raw message for display and thread reconstruction

## Message chunk types

The implementation should emit a small number of explicit chunk kinds.

### `authored_message`

Use when the message is mostly prose written by the current author and does not contain meaningful interleaving.

Chunk body:

- optional short quote anchor
- authored prose

### `quote_reply_pair`

Use when a local quote is clearly being answered.

Chunk body:

- quoted anchor
- authored reply

This is the default for direct replies that would lose meaning if the quote were removed.

### `review_pair`

Use when the message is interleaved review or patch feedback.

Chunk body:

- local quoted snippet or code hunk
- corresponding reply text

Emit one chunk per pair.

### `long_authored_segment`

Use when the authored portion is too large for one chunk even after quote cleanup.

Split by:

1. paragraph boundaries
2. sentence boundaries
3. line windows as a last resort

Keep a small overlap between neighboring chunks.

### `attachment_segment`

Use for `attachments.content`.

These should be chunked independently from the message body.

## Size guidance

This repository already contains char-length signals, so the initial implementation can use character-based thresholds instead of tokenizer-specific logic.

Recommended first-pass thresholds for messages:

- `<= 2,000` cleaned chars: emit one chunk
- `2,001 - 8,000`: split by paragraphs with small overlap
- `> 8,000`: recursive split by paragraphs, then sentences, then line windows

Recommended overlap:

- `200 - 400` chars for long prose chunks
- no overlap for distinct quote/reply pair chunks

Recommended first-pass thresholds for attachments:

- `<= 8,000` chars: emit one chunk
- `8,001 - 32,000`: split by file sections
- `> 32,000`: chunk recursively by syntax-aware boundaries if possible

## Quote-first handling

The chunker must handle the common mailing-list pattern:

```text
On ...
> big quote
reply
```

This should usually produce:

- one `quote_reply_pair` chunk using the last relevant depth-`1` quote block and the following authored block

The chunker should not require the message to start with `>` literally. A short greeting or reply header before the quote should still be treated as quote-first structure.

## Response-first handling

Some messages follow the opposite order:

```text
reply

> old quoted history
```

In that case:

- treat the leading authored block as primary
- use later quotes only if they are tightly tied to a subsequent authored block
- otherwise ignore the trailing quote block for embedding purposes

## Interleaved review handling

For interleaved review, the parser should walk block-by-block and emit chunks whenever it sees:

- `quote` or `patch_or_code`
- followed by `author`

This should work for patterns like:

```text
> comment
response

> other comment
other response
```

and:

```text
@@ code hunk
review feedback
```

The emitted chunk should preserve the local anchor and local reply together.

## Patch and code handling

Patch-heavy content should not be treated like ordinary prose.

For message bodies:

- detect diff markers such as `diff --git`, `@@`, `---`, `+++`
- detect code/log blocks by line shape
- emit smaller local review chunks around hunks that receive comments

For attachments:

- treat patch and diff files as high-value semantic content
- split by file header first, then by hunk if needed
- preserve filename and hunk metadata

Text-bearing attachment types already present in the corpus include:

- `text/x-patch`
- `text/x-diff`
- `text/plain`
- `application/sql`
- several gzip-backed formats whose content has already been extracted as text

Large build artifacts and logs should still be chunked, but they should likely receive weaker ranking than prose and patch-review chunks unless the query clearly looks diagnostic.

## Storage model

The index should store both raw and cleaned forms.

Suggested fields for a `semantic_chunks` table:

- `id`
- `source_kind`
- `source_id`
- `message_id`
- `attachment_id`
- `thread_id`
- `list_id`
- `chunk_kind`
- `chunk_index`
- `chunk_count`
- `text_display`
- `text_embed`
- `char_count`
- `quote_anchor_chars`
- `quote_depth_max`
- `has_patch_markers`
- `is_quote_heavy`
- `embedding`
- `embedding_model`
- `embedding_created_at`

The raw message and attachment tables remain the source of truth. The chunk table is a derived search structure.

## Retrieval strategy

Semantic retrieval should be hybrid, not pure vector search.

Recommended flow:

1. vector search over `semantic_chunks.text_embed`
2. keyword or full-text search over raw message and attachment text
3. fuse results
4. rerank using thread context, recency, chunk kind, and exact keyword hits
5. expand top results with parent or neighboring messages for answer synthesis

This is important because:

- patch and API names are often better handled by lexical search
- reply context may live in a parent message
- mailing-list answers often need thread-local reconstruction

## Chunk-emission examples

### Example 1: direct reply with top quote

Input:

```text
On Tue, ...
> Should we rename this field?

I do not think so, because it breaks the existing ABI.
```

Emit:

- `quote_reply_pair`

Embedded text:

```text
Quoted point:
Should we rename this field?

Reply:
I do not think so, because it breaks the existing ABI.
```

### Example 2: long nested quote history

Input:

```text
On Tue, ...
> On Mon, ...
> > older history
> local point

My response.
```

Emit:

- keep `local point`
- drop the deeper history
- emit one `quote_reply_pair`

### Example 3: interleaved patch review

Input:

```text
> rename this variable
I agree.

> move the check earlier
I do not think that is safe during recovery.
```

Emit:

- one `review_pair` for the first point
- one `review_pair` for the second point

### Example 4: response first, quote later

Input:

```text
This looks reasonable to me.

> old quoted thread history
```

Emit:

- one `authored_message`
- ignore the trailing quote for embedding

## Initial heuristics

A first implementation should be intentionally simple and measurable.

Suggested starting heuristics:

- keep at most one adjacent depth-`1` quote anchor per authored chunk
- drop depth-`>= 2` quotes by default
- split interleaved quote/reply messages into multiple chunks
- do not embed quote-only messages standalone
- if cleaned authored text is `< 200` chars, expand with local quote or parent context
- if cleaned message text exceeds `2,000` chars, split it
- if attachment text exceeds `8,000` chars, split it

These values should be treated as tuning defaults, not API contracts.

## Evaluation plan

The chunker should be validated against real mailing-list queries, not just abstract retrieval benchmarks.

Measure at least:

- retrieval quality for short direct replies
- retrieval quality for patch-review discussions
- duplicate result rate from quoted history
- percentage of chunks that are nearly all quote text
- percentage of retrieved chunks that require parent expansion to make sense

Manual evaluation sets should include:

- direct design discussion replies
- bug triage threads
- patch review threads
- long multi-message architectural debates
- attachment-heavy threads

## Implementation guidance

The initial chunker should be built in an existing project language, not a new systems-language sidecar.

Recommended default:

- implement chunking in Python near the ingestion pipeline
- keep the semantic search API and session flow in the existing Bun/TypeScript server
- do not introduce Go unless profiling shows the chunk parser itself is a real bottleneck

Why this is the default:

- ingestion already exists in Python
- the chunking work is mostly sequential text parsing, block classification, and string slicing
- most message bodies are small enough that parser CPU should not be the first bottleneck
- introducing a third implementation language increases operational and maintenance cost immediately

JavaScript or TypeScript would also be viable from a raw performance perspective. Python is preferred mainly because it fits the existing ingestion boundary and leaves room for local embedding/model tooling later.

### What is likely to be expensive

The expected hot spots are not the same as the core quote-aware parser.

Likely bottlenecks:

- embedding generation, especially if it calls a remote API
- reading and writing large batches of chunks
- very large extracted attachments, logs, and patch artifacts
- retry behavior and queue backpressure

Less likely early bottlenecks:

- line-by-line parsing of normal message bodies
- quote-depth detection
- short-block classification

Given the current corpus shape, the parser should be cheap for the common case:

- median message body is `1,308` chars
- p90 message body is `4,282`
- only a small tail of messages is extremely large
- the biggest outliers are disproportionately attachments and extracted artifacts

### Performance posture

The first implementation should optimize for predictable throughput, not maximum single-process speed.

Practical rules:

- make parsing linear in input size
- scan once where possible instead of repeatedly applying whole-body regexes
- batch writes to the database
- keep chunk generation separate from embedding generation
- place hard limits on inline processing for oversized attachments

The goal is to keep ordinary mail cheap and push pathological inputs onto a slower background path.

## Operational model

Chunking should be a derived pipeline stage, not an ad hoc step embedded directly inside request handling.

Recommended stages:

1. ingest raw message and attachments
2. enqueue a chunking job
3. persist emitted semantic chunks
4. enqueue embedding jobs for those chunks
5. update search-ready state when embeddings are complete

This separation allows:

- raw ingestion to remain durable even if semantic processing is delayed
- backfills and live traffic to share the same chunker
- embeddings to be retried independently from parsing
- large attachments to be deferred without blocking normal mail

### Fast lane and slow lane

The chunker should use at least two processing lanes.

Fast lane:

- normal message bodies
- small text attachments
- expected to run in near-real-time

Slow lane:

- very large extracted attachments
- giant logs and test artifacts
- unusually large message bodies
- expected to run asynchronously without blocking the rest of the corpus

The exact thresholds are implementation details, but a good first-pass policy is:

- process typical message bodies immediately
- process small and medium text attachments immediately
- defer very large extracted text blobs to a background queue

### Real-time versus backlog

Backfill processing and live processing can use the same parser with different scheduling priorities.

For backfill:

- maximize throughput
- run chunking and embedding workers in bulk
- allow the queue to drain over time

For live or hourly batch ingestion:

- prioritize low latency for normal messages
- keep large attachments off the critical path
- accept eventual consistency for semantic search readiness

In practice, it is acceptable if raw messages appear before semantic search chunks are ready, as long as the lag stays bounded and observable.

## When to revisit the language choice

Go or another systems language should be considered only if profiling shows that the parser itself is materially limiting throughput after the obvious architectural fixes are in place.

Those fixes include:

- batched database writes
- background jobs
- oversized-attachment deferral
- chunk and embedding pipeline separation
- avoiding repeated full-body regex passes

A new implementation language becomes more defensible if:

- parser CPU dominates end-to-end processing time
- a single worker cannot keep up even after batching and queueing improvements
- the workload is local-model-heavy and bound by preprocessing rather than embedding calls
- the maintenance cost of a separate service is clearly justified by measured throughput gains

Until then, adding Go is likely to create more complexity than value.

## Open questions

The first implementation can proceed without resolving everything below, but these should be revisited:

- whether to summarize very large quote blocks instead of dropping them outright
- whether to generate separate thread-window chunks for reranking only
- whether patch hunks should use a dedicated embedding model later
- how much lexical score should influence final ranking for symbol-heavy queries
- whether to skip very large extracted log artifacts from vector indexing entirely

## Summary

The right default for `pginbox` is quote-aware message and attachment chunking.

In plain terms:

- do not embed whole threads as the only unit
- do not strip all quotes blindly
- preserve a small local quote anchor when the reply depends on it
- split interleaved review mail into local quote/reply chunks
- treat attachments, especially patches and diffs, as a first-class corpus
- use thread structure for reranking and answer reconstruction
