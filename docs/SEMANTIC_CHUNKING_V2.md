## Semantic Search Indexing Strategy for pginbox

### Message and Attachment Embedding, Cleaning, and Chunking

---

## 1. Purpose

This document summarizes the strategy we arrived at for building semantic search over pginbox’s mailing-list corpus, covering both:

* **messages**
* **attachments**

The goal is to create an index that is:

* high-signal
* cost-conscious
* retrieval-friendly
* structurally faithful to the source material
* robust to mailing-list-specific noise like quotes, boilerplate, and patch revisions

The central conclusion is that **messages and attachments should not share the same embedding/chunking pipeline**. They are different kinds of content and require different semantic units.

---

## 2. Corpus shape and key findings

### Messages

The message body distribution is compact once the giant pathological outlier is ignored.

Percentiles for `length(body)` after excluding the massive install-log quote message:

* **p50 ≈ 1073**
* **p90 ≈ 2862**
* **p95 ≈ 3915**
* **p99 ≈ 7508**
* **max ≈ 347456**

That means:

* most messages are short to medium
* nearly all messages fit comfortably into a single semantic unit
* only a small tail is long enough to justify chunking

Quoting analysis showed, on average:

* **~40 total lines/message**
* **~15.6 quoted lines/message**
* **~2.5 nested-quoted lines/message**
* **~33.5% quoted**
* **~4.75% nested quoted**

So quoting is meaningful, but **deep nested quoting is only a small part of the total**. Most quoted material is shallow single-level quoting.

### Attachments

Attachment profiling shows a very different corpus.

Attachment content percentiles:

* **p50 ≈ 8652 chars**
* **p90 ≈ 64959 chars**
* **p95 ≈ 120333 chars**
* **p99 ≈ 331420 chars**
* **max ≈ 129,414,175 chars**

Patch-ness analysis showed:

* **122,740 attachments in the larger sampled result set**
* **avg diff headers ≈ 7.7**
* **avg additions ≈ 425.7**
* **avg deletions ≈ 72.5**
* **avg diff-line ratio ≈ 43.8%**

The MIME breakdown was noisy, with many attachments labeled as `application/octet-stream`, but content-based classification fixed that. In local Postgres, after classifying by content patterns rather than MIME type, the user found:

* **87,991 patch attachments**
* **3,930 other**
* **1,714 text**
* **395 archive**
* **94,030 total**

So attachments are overwhelmingly a **patch corpus**, not a generic attachment corpus. MIME types were not trustworthy; content structure was the reliable classifier. The sample rows and MIME breakdown support this conclusion.  

Patch structural profiling showed:

* **median patch attachment: 4 files, 10 hunks**
* **p90 patch attachment: 19 files, 58 hunks**
* **max: 2060 files, 2072 hunks**

And the file-count buckets showed:

* **1–5 files: 53,008**
* **6–20 files: 27,175**
* **21–100 files: 7,408**
* **100+ files: 400**

So most patch attachments are multi-file, but the overwhelming majority are still manageable if split intelligently.

---

## 3. Core architectural conclusion

The corpus is **bimodal**.

### Messages are:

* conversational
* prose-like
* relatively short
* polluted by quoting and email cruft

### Attachments are:

* overwhelmingly patches/diffs
* large
* highly structured
* often mislabeled by MIME type
* not well represented by raw-text embeddings

Because of that, the system should use **two separate semantic indexing pipelines**:

1. **Message pipeline**
2. **Attachment pipeline**

They should share infrastructure where useful, but not a single chunking or cleaning policy.

---

## 4. Message indexing strategy

## 4.1 Guiding principle

For messages, the default semantic unit should be the **message itself**, after cleaning.

Raw messages are already small enough that heavy chunking is unnecessary in most cases. The real problem is not size. The real problem is **noise**.

### Message strategy summary

* preserve raw message for display
* derive a cleaned semantic representation
* embed cleaned message as a single unit in most cases
* emit smaller local units for inline review-style messages when detected
* only chunk unusually large cleaned messages

---

## 4.2 Why minimal chunking is correct for messages

The message percentiles strongly support a “single cleaned message = one embedding” strategy:

* p50 ~1k chars
* p95 <4k chars
* p99 <8k chars

This means most messages are already appropriately sized for one semantic unit.

Universal chunking would introduce unnecessary complexity and cost:

* more index rows
* worse reconstruction of conversational meaning
* fragmentation of replies that should stay together
* redundant retrieval hits for a single message

The right default is therefore:

* **no chunking for normal cleaned messages**
* **conditional chunking only for the long tail**

That default should still allow a narrow exception for review-style mail. Messages that alternate between quoted lines and short authored replies often benefit from smaller local semantic units in addition to the full cleaned-message unit.

---

## 4.3 Message cleaning strategy

The semantic quality of message embeddings depends heavily on cleaning. The most important sources of noise are:

* quoted prior messages
* nested quote chains
* mailing-list footers
* signatures
* copied headers in the message body
* logs or boilerplate pasted into replies

### Recommended stored fields

For each message, store at least:

* `raw_body`
* `cleaned_body` or `semantic_body`
* `cleaning_version`
* `cleaned_char_count`
* `quote_ratio`
* `embedding_model`
* embedding vector

This is important for reproducibility and iteration. Embeddings should be treated as a derivative artifact of a persisted cleaned representation, not the only stored output.

---

## 4.4 Quote handling

The quoting analysis showed:

* quotes matter
* nested quotes are only a small part of the total
* most quoted material is single-level

So the best initial cleaning policy is conservative but useful.

### Recommended first-pass quote strategy

1. remove signatures / footers / boilerplate
2. remove nested quotes (`>>`, `>>>`, etc.)
3. retain single-level quotes (`>`) for now
4. optionally cap retained single-level quoted text

This preserves immediate local context, which is important for inline replies, while removing the repeated thread history that pollutes embeddings.

### Why not remove all quoted text?

Many mailing-list replies are only intelligible with some local quote context, especially inline review-style messages such as:

```text
> Should this go in planner.c?

No, because the state is not available until later.
```

If all quoted content is removed, many short replies become semantically weak or ambiguous.

### Why nested-only removal is not enough on its own

Nested quoting is only ~4.75% of lines on average. So removing only nested quotes is a good first step, but it is not the main lever.

The larger issue is shallow quoting. That is why a good second-stage refinement is:

* retain only a capped amount of single-level quoted text
* or preferentially retain quotes adjacent to novel authored text

### Recommended evolution path

#### Phase 1

* remove nested quotes only
* preserve single-level quotes
* remove obvious boilerplate

#### Phase 2

* cap retained single-level quote content
* maybe retain only the first N quoted chars or lines
* maybe preserve only quote blocks near authored text

This lets the system start conservatively and then tighten as retrieval behavior is observed.

### Review-style message exception

Some mailing-list messages are not ordinary prose replies. They are interleaved review messages where the semantic unit is often:

* a quoted question or code fragment
* the immediate authored reply beneath it

For those messages, the system should keep the whole cleaned message unit, but may also emit smaller derived quote/reply units when the line structure strongly suggests inline review.

---

## 4.5 Message chunking thresholds

Chunking should be based on **cleaned** text, not raw text.

A message that is long only because it contains quotes or boilerplate should not be chunked before cleaning.

### Recommended v1 message chunking policy

* if `length(cleaned_body) <= 8k chars`: embed as one unit
* if `length(cleaned_body) > 8k chars`: split into overlapping chunks
* for extremely large messages, treat them as exceptional cases

### Suggested chunk settings for long cleaned messages

* chunk size: roughly **2k–3k chars**
* overlap: roughly **200–500 chars**

This keeps chunks semantically coherent without over-fragmenting.

### Important note

Given the current distribution, only a small minority of messages should hit the chunking path at all. That is desirable.

---

## 4.6 Message retrieval model

Each message should usually have one semantic unit. Long cleaned messages may have multiple chunk units.

Review-style messages may additionally have smaller derived local units. These should be additive, not a replacement for the parent message unit.

Suggested semantic record model:

* `message_id`
* `unit_type = 'message' | 'chunk' | 'quote_reply_pair'`
* `unit_index`
* `semantic_text`
* `raw_text_reference`
* `cleaning_version`
* `embedding_model`
* embedding vector

For ranking, prefer non-chunked message hits when possible, since they represent the full message cleanly.

---

## 5. Attachment indexing strategy

## 5.1 Guiding principle

Attachments are not just “longer messages.” They are structurally different.

The overwhelming majority of attachments are patches. Therefore, attachments should be indexed around **patch structure**, not raw text length.

### Attachment strategy summary

* classify by content, not MIME type
* treat patches as the primary content type
* split patch attachments by file diff
* only split to hunk level when a file diff is too large
* skip or metadata-index archives/binaries
* treat revisioned patches as related but distinct

---

## 5.2 Classification strategy

MIME type is not reliable enough for deciding semantic treatment. Many patches are labeled as generic `application/octet-stream` or similar. The correct attachment classification must be **content-based**.

### Recommended content-based categories

* `patch`
* `text`
* `archive`
* `other`

### Patch detection signals

A patch can be detected by structural markers like:

* `diff --git`
* `@@`
* `+++ `
* `--- `

This approach successfully reclassified the attachment corpus into an overwhelmingly patch-heavy corpus in the user’s local analysis.

Detection and parsing should not assume every patch is a clean git patch with `diff --git` headers. Some attachments will instead be:

* unified diffs that only expose `---` / `+++` / `@@`
* binary git patches
* rename-only or mode-change diffs
* malformed or truncated patch text

So patch handling needs both content-based classification and explicit parser fallback behavior.

---

## 5.3 Why whole-attachment embeddings are wrong for patches

The patch structure analysis showed:

* median patch attachment = 4 files / 10 hunks
* p90 = 19 files / 58 hunks

That means a whole-attachment embedding usually mixes too many unrelated changes together:

* docs
* tests
* backend code
* build scripts
* comments
* multiple paths

Whole-attachment embeddings are too coarse and will blur distinct semantic units.

At the other extreme, hunk-level-only indexing is usually too fine and can generate too many tiny results.

Therefore the correct default unit is:

* **file diff**

And the fallback unit is:

* **hunk**

---

## 5.4 Primary semantic unit for attachments: file diff

A patch attachment should first be split into file-level units, preferably using `diff --git` when available.

This is the right default because:

* it matches the natural structure of patches
* it gives manageable unit counts for most attachments
* it keeps related hunks in one file together
* it improves retrieval precision dramatically over attachment-level embeddings
* it avoids the fragmentation of universal hunk-level indexing

In practice this means supporting at least:

* git-patch parsing via `diff --git`
* unified-diff fallback parsing via `---` / `+++` boundaries when `diff --git` is absent

If neither parser yields trustworthy file units, the system should still emit a coarse patch-level record with parse-status metadata rather than silently dropping the attachment from the semantic index.

### Suggested file-diff stored fields

For each file diff:

* `attachment_id`
* `patch_revision_id`
* `file_index`
* `old_path`
* `new_path`
* raw file diff text
* additions count
* deletions count
* hunk_count
* `parse_mode`
* `parse_status`
* derived semantic representation
* embedding vector

---

## 5.5 Fallback semantic unit: hunk

A file diff should be split into hunks only when it is too large to represent as one semantic unit.

### Suggested reasons to split a file diff into hunks

* file diff exceeds a char/token threshold
* file diff contains many hunks
* file diff is obviously too broad semantically

### Good initial thresholds

Reasonable v1 starting thresholds:

* if `file_diff_chars <= 12k` and `hunk_count <= 10`: embed as one file unit
* otherwise: split on `@@` and embed hunks

These are not final truths, but they are sensible starting points based on the corpus shape.

---

## 5.6 Handling the long tail of giant patches

Most patch attachments are manageable:

* ~91% have 20 files or fewer
* only 400 are in the `100+ files` bucket

So the indexing policy should optimize for the common case, not let the pathological tail dictate the whole design.

### Recommended attachment-size routing

#### Small / normal patch attachments

`file_count <= 20`

* split into file diffs
* embed each file diff unless individually oversized

#### Large patch attachments

`21 <= file_count <= 100`

* split into file diffs
* allow hunk splitting for oversized file diffs
* maybe add more aggressive filtering/deduplication if needed

#### Giant patch attachments

`file_count > 100`

* do not naively embed every file diff in v1
* always emit a coarse attachment-level searchable record
* optionally embed only a selected subset of high-signal files
* defer exhaustive file-level embedding if cost is too high

Because there are only 400 such attachments, it is reasonable to special-case them in v1, but they should not disappear entirely from recall.

---

## 5.7 What to embed for patches

Raw diff text is noisy. Roughly 44% of lines are diff lines. A raw embedding over `+` and `-` syntax is not ideal.

### Recommended semantic representation for a file diff

Instead of embedding the raw patch text alone, derive a structured semantic text that includes:

* file path
* file type if inferable
* additions/deletions counts
* hunk headers
* short cleaned excerpts
* possibly a generated or rule-based summary of the change

Example conceptual representation:

```text
Patch subject: Add support for X
Revision: v3
File: src/backend/utils/foo.c

Change summary:
- adds validation for snapshot state
- removes older fallback logic
- updates error handling path

Hunks:
- @@ validate snapshot before use
- @@ remove legacy branch
```

This representation will retrieve better than a raw wall of diff syntax.

### Suggested v1 approach

For v1, even a simple rule-based representation is better than raw diff text only.

For example:

* prepend patch subject and file path
* include hunk headers
* include truncated context from the diff
* include stats

A later iteration can add LLM-generated summaries.

The retrieval path should remain hybrid from the start. File paths, symbols, hunk headers, and exact patch tags often match better lexically than semantically, so the embedding text should complement rather than replace lexical search features.

---

## 5.8 Non-patch attachments

These are a minority once content-based classification is used.

### Text attachments

* treat somewhat like messages
* clean lightly
* usually no chunking or light chunking
* good candidates for embedding

### Archives

* do not embed in v1
* store metadata only

### Other

* inspect and sample
* likely includes malformed patches, binaries, oddball files
* not worth a complex initial semantic policy

---

## 6. Patch revision handling

## 6.1 Why revisions should not be deduped away

Patch series often appear as:

* v1
* v2
* v3
* etc.

These are not simple duplicates. Later revisions often differ materially:

* bug fixes after feedback
* changed approach
* narrowed scope
* renamed files/functions
* added tests or docs
* revised rationale

Therefore, revisions should be **kept as distinct indexed artifacts**.

---

## 6.2 Recommended revision model

Use three conceptual layers:

### Patch family / series

Logical group of related revisions of the same proposal.

### Patch revision

Specific revision, such as v1 or v3.

### Patch semantic units

The file diffs or hunks derived from that revision.

### Suggested metadata

Per revision:

* `patch_family_key`
* `revision_number`
* `attachment_id`
* `message_id`
* `subject`
* `sent_at`
* `is_cover_letter`
* `is_latest_in_family`

Per unit:

* `patch_revision_id`
* `unit_type = 'file' | 'hunk'`
* `file_path`
* `hunk_header`
* `semantic_text`
* `content_hash`
* embedding vector

If two revisions produce the same normalized semantic text for a file or hunk unit, the system should be able to reuse the same embedding artifact. Revisions remain distinct records; only the embedding work is deduplicated.

---

## 6.3 Family grouping

Patch revisions should be grouped heuristically using normalized subjects plus surrounding context.

Normalize by stripping patterns like:

* `[PATCH]`
* `[PATCH v2]`
* `0/5`, `2/7`
* `Re:`
* list tags

Then derive:

* base family key
* revision number
* patch number within series, if present

Subject normalization should be the starting point, not the entire key. Grouping should also consider:

* thread relationships
* sender identity
* list identity
* send-time proximity

This will still not be perfect, but it is materially safer than subject-only grouping.

---

## 6.4 Retrieval behavior for revisions

### Recommended retrieval policy

* search across **all revisions**
* do not pre-delete or pre-collapse older revisions

### Recommended ranking/display policy

* mildly prefer the latest revision when multiple revisions are similar
* collapse near-duplicate hits across revisions at display time
* surface family-level context in the UI

This preserves recall while keeping results readable.

---

## 7. Storage and schema recommendations

## 7.1 Messages

Suggested fields:

### `messages`

* `id`
* `raw_body`
* `cleaned_body`
* `cleaning_version`
* `cleaned_char_count`
* `quote_ratio`
* metadata

### `message_semantic_units`

* `id`
* `message_id`
* `unit_type`
* `unit_index`
* `semantic_text`
* `embedding_model`
* `cleaning_version`
* embedding vector

If review-local units are emitted, this table should also carry enough metadata to map them back to the parent message span or quote/reply segment.

---

## 7.2 Attachments

Suggested fields:

### `attachments`

* `id`
* `filename`
* `content_type`
* `content`
* `category`
* metadata

### `patch_families`

* `id`
* `family_key`
* normalized topic/subject

### `patch_revisions`

* `id`
* `patch_family_id`
* `attachment_id`
* `message_id`
* `revision_number`
* `subject`
* `is_cover_letter`
* `is_latest`

### `attachment_semantic_units`

* `id`
* `attachment_id`
* `patch_revision_id`
* `unit_type`
* `file_index`
* `hunk_index`
* `old_path`
* `new_path`
* `hunk_header`
* `raw_text`
* `semantic_text`
* `content_hash`
* `parse_mode`
* `parse_status`
* `transform_version`
* `embedding_model`
* embedding vector

Lexical retrieval fields for subjects, file paths, hunk headers, and exact symbols should be treated as part of the same retrieval design, not a separate afterthought.

---

## 8. Recommended v1 implementation plan

## Phase 1: messages

1. persist `cleaned_body`
2. remove boilerplate/signatures
3. remove nested quotes
4. keep single-level quotes initially
5. embed cleaned message as one unit unless cleaned length exceeds threshold
6. emit additional quote/reply units for inline review mail when detected
7. chunk only long cleaned messages

## Phase 2: attachment classification

1. classify attachments by content, not MIME type
2. identify `patch`, `text`, `archive`, `other`
3. focus on `patch` first

## Phase 3: patch parsing

1. split patch attachments by `diff --git` when available
2. fall back to unified-diff parsing when `diff --git` is absent
3. store one row per file diff when parsing succeeds
4. gather metadata like file paths, additions, deletions, hunk count, and parse status

## Phase 4: patch unit embedding

1. embed file diffs by default
2. split oversized file diffs by `@@`
3. embed hunk units only when needed

## Phase 5: revision grouping

1. derive patch family keys from normalized subjects
2. parse revision numbers
3. incorporate thread, sender, list, and time-window heuristics
4. reuse embeddings for unchanged units across revisions via content hashes
5. rank/display later revisions preferentially while keeping all revisions searchable

## Phase 6: tail handling

1. special-case giant `100+ file` patch attachments with at least a coarse searchable record
2. skip archives for embedding
3. inspect `other` as a small cleanup queue

## Phase 7: retrieval and observability

1. keep lexical retrieval paths for subjects, file paths, hunk headers, and exact symbols
2. log parse failures, unit counts, and threshold-triggered hunk splits
3. measure retrieval quality separately for prose, inline review, and patch queries
4. tune thresholds from observed token counts and retrieval outcomes rather than freezing initial char limits permanently

---

## 9. Final strategy summary

## Messages

* clean aggressively enough to reduce quote pollution
* store cleaned text before embedding
* default to one embedding per cleaned message
* emit smaller review-local units when inline review structure is detected
* only chunk the small long-tail of very large cleaned messages

## Attachments

* classify by content, not MIME type
* treat the corpus as primarily a patch corpus
* split patch attachments by file diff
* support non-`diff --git` parser fallback and explicit parse-status tracking
* use file diff as the default semantic unit
* split to hunk level only for oversized file diffs
* keep revisions distinct but grouped
* reuse embeddings for unchanged units across revisions
* special-case giant patches so they remain searchable
* skip archives for embedding

---

## 10. Bottom line

The analysis points to a clear architecture:

* **Messages:** mostly single cleaned-message embeddings with minimal chunking
* **Attachments:** structurally parsed patch indexing with file-diff units, selective hunk fallback, and parser fallbacks for non-ideal diffs

This strategy fits the actual shape of the corpus, minimizes wasted embeddings, preserves semantic fidelity, and should produce far better retrieval quality than a generic “chunk everything into windows” approach.

If you want this turned into a tighter internal design doc format with sections like goals, non-goals, schema, pipeline, ranking, and rollout plan, I can rewrite it in that style.
