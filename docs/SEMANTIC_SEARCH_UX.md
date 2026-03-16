# Semantic Search UX

This document defines the intended user experience for semantic and hybrid search in `pginbox`.

It is intentionally about product behavior, interaction design, and page states. It is not the corpus-chunking spec and it is not the final search-session API contract.

Related documents:

- [`docs/FRONTEND_DESIGN.md`](./FRONTEND_DESIGN.md) for route/state model and overall frontend direction
- [`docs/SEMANTIC_CHUNKING.md`](./SEMANTIC_CHUNKING.md) for message/attachment chunking and retrieval-unit design
- [`docs/SEARCH.md`](./SEARCH.md) for the current subject-search behavior

## Product stance

Semantic search in `pginbox` should feel like a better way to locate and inspect the right threads, not like chatting with an opaque AI.

The archive remains the product. Semantic search is an access layer over that archive.

That implies:

- retrieval-first, not answer-first
- provenance-first, not opaque synthesis
- thread-centric presentation, even if ranking starts at the chunk/message level
- summaries as a second layer, not the default primary output

## Goals

The first semantic-search UX should help users:

- find relevant discussions when they do not know the exact subject line
- locate message-level evidence inside large or noisy threads
- surface patch review and attachment-heavy discussions more effectively
- understand why a thread matched
- move from a semantic query into the normal thread-reading flow without losing context

## Non-goals

The first semantic-search UX should not try to be:

- a general chatbot for PostgreSQL questions
- a replacement for thread detail pages
- a source-free answer box
- a separate product detached from the existing `/threads` explorer
- a fully shareable public search result system by default

## Primary user journeys

### 1. Topic discovery

Example:

- "Find discussions about logical decoding on standbys"

User need:

- concept search without exact keywords

Best output:

- ranked thread results with message snippets showing where the idea was actually discussed

### 2. Historical position research

Example:

- "Find threads where contributors argued against async I/O bypassing the buffer manager"

User need:

- understand how a position emerged over time

Best output:

- results with dates, authors, and enough snippet context to show how the idea changed

### 3. Problem or diagnostic research

Example:

- "Threads similar to this WAL corruption error"

User need:

- match by meaning, symptoms, or phrasing rather than exact subject text

Best output:

- message-level matches grouped into threads, with logs/code/attachments surfaced where relevant

### 4. Patch and design archaeology

Example:

- "Find the patch review threads that led to this feature"

User need:

- connect design discussion, review messages, and attachments

Best output:

- thread results with clear attachment and patch-match provenance

## UX placement

Semantic search should live inside the existing thread explorer, not on a separate AI page.

Primary location:

- `/threads`

The main search area on `/threads` should support two modes:

- `Subject search`
- `Advanced search`

This keeps the existing mental model intact:

- users are still searching the archive
- they are still landing in the threads explorer
- list/date filters still apply

## Search-mode model

### Subject search

Current behavior remains:

- single-line query
- `q` in the URL
- thread-subject substring search

### Advanced search

Advanced search is the semantic and hybrid mode.

UI behavior:

- multi-line prompt field
- still visible list/date filters
- optional lightweight guidance text
- submit creates a search session

The prompt body itself should not become canonical URL state.

Canonical URL state should remain:

- `/threads?search=srch_...`

## Query-entry experience

The advanced search input should feel like a research prompt, not like a chat composer.

The input should support:

- one natural-language prompt
- optional pasted error text, log snippet, or short design description
- explicit note that results will link back to original threads and messages

Good helper copy:

- "Describe the discussion, behavior, patch topic, or argument you are looking for."

Bad helper copy:

- "Ask anything"

The UI should avoid implying that the system will always synthesize a single authoritative answer.

## Core result model

Retrieval should happen at the message or chunk level, but presentation should be grouped by thread.

That aligns with the chunking strategy in [`docs/SEMANTIC_CHUNKING.md`](./SEMANTIC_CHUNKING.md), where the semantic unit is not the whole thread.

The first result page should therefore show:

- ranked thread cards
- each card backed by one or more matching chunks/messages
- visible provenance for why the thread matched

### Why thread grouping is the right first presentation

- the rest of the product is already thread-first
- users often want the broader conversation, not only one isolated message
- message-level evidence can still be shown inside each result card
- opening a thread detail page remains the natural next step

## Result-card structure

Each semantic result card should include:

- thread subject
- list name
- thread start or last-activity date
- message count
- one to three ranked evidence snippets
- author and date for each snippet
- a short provenance label for the snippet source

Possible provenance labels:

- `message`
- `review reply`
- `patch attachment`
- `quoted reply`

Those labels should map back to chunk kinds or source types defined by the chunking/indexing layer.

### Evidence snippet rules

Evidence snippets should:

- come from the actual matching message or attachment chunk
- be short and readable
- preserve enough context to make the match understandable
- highlight query-relevant terms or spans where possible

They should not:

- be rewritten into paraphrases by default
- hide the fact that the match came from an attachment rather than the message body

## Result-page layout

The semantic result page on `/threads?search=...` should have four layers.

### 1. Search summary strip

At the top:

- original prompt
- active list/date filters
- search mode label, for example `Advanced search`
- optional metadata such as `hybrid ranking`

This tells the user exactly what they are looking at.

### 2. Result list

Main body:

- ranked thread cards
- infinite scroll or current thread pagination model, whichever stays most consistent with the explorer

### 3. Optional interpretation panel

Secondary content, not required for v1:

- major themes in the result set
- recurring authors
- visible time clustering

This should remain clearly downstream of retrieval, not the main result itself.

### 4. Refinement controls

Still visible:

- list filter
- from/to date filters
- clear search
- switch back to subject search

Semantic search should refine inside the same explorer model, not replace it.

## Thread-detail handoff

Opening a thread from semantic results should preserve search context.

Desired behavior:

- thread detail opens normally
- the matched messages or chunks are highlighted
- the first/highest-ranked matching message is easy to find
- back navigation returns the user to the semantic result list intact

The thread detail page should not become an AI summary page. It should remain a readable message timeline with semantic match context layered on top.

Useful detail-page affordances:

- "Matched here" marker on messages
- jump-to-next-match control
- attachment match indicator where relevant

## Summaries and synthesis

Summaries are useful, but they should be optional and clearly subordinate to retrieval.

Recommended first-phase stance:

- no large answer block at the top of every search result
- no free-form assistant response before the user has seen evidence

Recommended second-phase enhancements:

- "Summarize these results"
- "Show major themes"
- "Compare viewpoints"
- "What changed over time?"

Those actions should operate on retrieved evidence, not on the entire corpus without visible provenance.

## Auth and gating behavior

Advanced search is account-only because it consumes paid embedding or model resources.

Public browsing remains open.

### Logged-out behavior

Recommended:

- advanced-search mode is visible
- the user can understand what it is
- submitting a semantic query prompts sign-in

The system should not hide the feature completely, but it also should not spend model budget for anonymous users.

### Logged-in behavior

Recommended:

- semantic search just works
- no special account friction once signed in

Future account UI can later show:

- usage
- quotas
- moderation status

## Search-session model in the UX

Semantic search should use session-backed results.

Flow:

1. user submits advanced search prompt
2. frontend `POST`s search session
3. server returns `searchSessionId`
4. frontend navigates to `/threads?search=srch_...`
5. result page loads from session id

The session id becomes the durable handle for:

- reloads
- pagination
- browser back/forward
- optional later sharing semantics

## My Searches

`My Searches` is a good fit for this product, but it should be modeled as user-visible search history and explicit saved searches, not as permanent retention of every semantic run forever.

The UX should distinguish three related concepts:

### Search session

- created for each advanced-search run
- powers the `/threads?search=srch_...` result flow
- may expire according to the session TTL policy

### Recent searches

- user-visible history of recent semantic runs
- useful for returning to multi-day research work
- should show prompt, created time, filters, and whether the session is still available
- should support reopen, rerun, and delete-from-history actions

### Saved searches

- explicitly bookmarked or pinned by the user
- intended for longer-lived reference
- should be a separate user action, not the default for every query

Recommended first-phase product behavior:

- every semantic search creates a session
- recent semantic sessions appear in `My Searches`
- old sessions may expire and show an `expired` state
- important sessions can later be promoted to an explicit saved-search model

This keeps the feature useful without forcing the product into indefinite retention, ambiguous session semantics, or a noisy library of low-value queries.

## Empty, loading, and failure states

These states matter a lot because semantic search will be slower and more failure-prone than subject search.

### Loading

Show:

- "Running advanced search"
- brief note that ranking can take longer than subject search
- keep the prompt visible

Do not show:

- fake streaming assistant text

### Empty results

Show:

- that no strong matches were found
- the original prompt
- suggestions to narrow by list/date or simplify the prompt

### Expired or invalid session

Show:

- that the semantic session is no longer available
- the original prompt only if it is still locally available
- an action to rerun search
- a fallback path back to normal thread exploration

### Authorization failure

Show:

- sign-in required if anonymous
- clear account-state error if the account is disabled or otherwise blocked

## Mobile behavior

The mobile version should stay list-first.

That means:

- prompt at top
- summary strip compressed
- result cards remain readable with one or two evidence snippets
- thread handoff remains the main path

Avoid trying to build a mobile chat UI just because semantic search exists.

## Query normalization and interpretation

Typical user queries should be embedded as a single unit, not chunked like corpus documents.

However, the UX may later support lightweight preprocessing such as:

- query rewrite for retrieval quality
- filter extraction
- intent classification between topic search and diagnostic search

Those behaviors should remain invisible unless they materially affect user trust.

If the system rewrites or interprets a query in a significant way, the UI should expose that in a restrained form.

## What "hybrid" should mean to the user

Users do not need to see vector jargon.

The product language should emphasize:

- semantic relevance
- original thread evidence
- classic filters still apply

Internal implementation may combine:

- semantic chunk retrieval
- keyword search
- thread-level reranking

But the user-facing promise should remain simple:

- "Find related discussions even when the wording differs."

## First-phase implementation recommendation

The first production semantic-search UX should include:

- advanced-search mode on `/threads`
- session-backed result URLs
- thread-grouped result cards
- evidence snippets from matching messages or attachments
- highlighted thread-detail handoff
- login gating

It should not include yet:

- default generated answer blocks
- open sharing of semantic sessions
- multi-turn conversation UI
- large settings panels for ranking behavior

## Open product decisions

These decisions should be resolved before implementation starts:

- should semantic results be sorted purely by relevance, or relevance with a freshness bias?
- how many evidence snippets should a thread card show by default?
- should attachments appear inline in a thread card, or only as provenance labels?
- should a semantic session be private to the current user by default?
- should expired sessions be rerunnable from stored prompt text, or simply fail closed?
- when summaries are added, should they be explicit user actions or automatic panels?

## Recommended product definition

If this feature needs a concise north-star description:

- Advanced search in `pginbox` is a better way to locate and inspect the right archive threads, with semantic ranking and visible evidence, not a chatbot layered over mailing-list history.
