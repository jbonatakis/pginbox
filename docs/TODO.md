# TODO

## My Threads Cleanup

- Split `src/server/services/thread-progress.service.ts` by responsibility. It currently owns canonicalization, tracked-thread CRUD, progress math, tracked-thread listing, counts, and the historical backfill job.
- Simplify `src/frontend/lib/trackedThreads.ts`. The current controller/state-machine approach is heavier than the account page likely needs for one two-tab card.
- Consider folding `src/frontend/lib/threadDetailTracking.ts` back into `ThreadDetailPage.svelte` if it stays single-use. Right now it is mostly a view-model layer for one banner.
- Simplify `src/server/jobs/my-threads-historical-backfill.ts` if it remains a one-off/internal job rather than a long-lived operational tool.
