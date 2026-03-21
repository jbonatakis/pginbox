<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { AdminStats, AdminUser } from "shared/api";
  import AdminDisableModal from "../components/admin/AdminDisableModal.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import LoadingState from "../components/LoadingState.svelte";
  import { api, toApiErrorShape, type ApiErrorShape } from "../lib/api";
  import { authStore } from "../lib/state/auth";

  const UserRole = { Member: "member", Admin: "admin" } as const;

  type PageStatus = "idle" | "loading" | "success" | "error";

  let pageStatus: PageStatus = "idle";
  let pageError: ApiErrorShape | null = null;

  let stats: AdminStats | null = null;
  let users: AdminUser[] = [];
  let nextCursor: string | null = null;
  let cursorHistory: Array<string | undefined> = [undefined];
  let currentPageIndex = 0;

  let searchQuery = "";
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  let actionInProgress: string | null = null;
  let actionError: Record<string, string> = {};

  let disableModalUser: AdminUser | null = null;

  let activeRequestController: AbortController | null = null;

  const clearActiveRequest = (): void => {
    activeRequestController?.abort();
    activeRequestController = null;
  };

  const loadPage = async (cursor: string | undefined, resetHistory = false): Promise<void> => {
    clearActiveRequest();
    const controller = new AbortController();
    activeRequestController = controller;

    pageStatus = "loading";
    pageError = null;

    try {
      const [statsResult, usersResult] = await Promise.all([
        stats ? Promise.resolve(stats) : api.admin.getStats({ signal: controller.signal }),
        api.admin.listUsers(
          { q: searchQuery.trim() || undefined, cursor, limit: 25 },
          { signal: controller.signal }
        ),
      ]);

      stats = statsResult;
      users = usersResult.items;
      nextCursor = usersResult.nextCursor;

      if (resetHistory) {
        cursorHistory = [undefined];
        currentPageIndex = 0;
      }

      pageStatus = "success";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      pageError = toApiErrorShape(err);
      pageStatus = "error";
    }
  };

  const handleSearch = (): void => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      void loadPage(undefined, true);
    }, 300);
  };

  const handleNextPage = (): void => {
    if (!nextCursor) return;
    cursorHistory = [...cursorHistory.slice(0, currentPageIndex + 1), nextCursor];
    currentPageIndex += 1;
    void loadPage(nextCursor);
  };

  const handlePrevPage = (): void => {
    if (currentPageIndex === 0) return;
    currentPageIndex -= 1;
    void loadPage(cursorHistory[currentPageIndex]);
  };

  const handleDisable = (user: AdminUser): void => {
    disableModalUser = user;
  };

  const handleDisabled = (event: CustomEvent<AdminUser>): void => {
    const updated = event.detail;
    disableModalUser = null;
    users = users.map((u) => (u.id === updated.id ? updated : u));
  };

  const handleEnable = async (user: AdminUser): Promise<void> => {
    actionInProgress = `enable-${user.id}`;
    actionError = { ...actionError };
    delete actionError[user.id];
    try {
      const updated = await api.admin.enable(user.id);
      users = users.map((u) =>
        u.id === updated.id ? { ...u, status: updated.status } : u
      );
    } catch (err) {
      actionError = { ...actionError, [user.id]: toApiErrorShape(err).message };
    } finally {
      actionInProgress = null;
    }
  };

  const handleResetPassword = async (user: AdminUser): Promise<void> => {
    actionInProgress = `reset-${user.id}`;
    actionError = { ...actionError };
    delete actionError[user.id];
    try {
      await api.admin.resetPassword(user.id);
    } catch (err) {
      actionError = { ...actionError, [user.id]: toApiErrorShape(err).message };
    } finally {
      actionInProgress = null;
    }
  };

  const handleRoleChange = async (user: AdminUser, role: string): Promise<void> => {
    actionInProgress = `role-${user.id}`;
    actionError = { ...actionError };
    delete actionError[user.id];
    try {
      const updated = await api.admin.setRole(user.id, role);
      users = users.map((u) =>
        u.id === updated.id ? { ...u, role: updated.role } : u
      );
    } catch (err) {
      actionError = { ...actionError, [user.id]: toApiErrorShape(err).message };
    } finally {
      actionInProgress = null;
    }
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatDateTime = (iso: string | null): string => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatCount = (n: number): string =>
    n.toLocaleString("en-US");

  onMount(() => {
    void loadPage(undefined, true);
  });

  onDestroy(() => {
    clearActiveRequest();
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  $: isInitialLoad = pageStatus === "idle" || (pageStatus === "loading" && users.length === 0);
  $: isLoading = pageStatus === "loading";
</script>

{#if disableModalUser}
  <AdminDisableModal
    user={disableModalUser}
    on:disabled={handleDisabled}
    on:cancel={() => { disableModalUser = null; }}
  />
{/if}

<section class="page">
  <h1 class="sr-only" data-route-heading tabindex="-1">Admin</h1>

  {#if isInitialLoad}
    <LoadingState title="Loading admin panel" message="Fetching users and system stats." />
  {:else if pageStatus === "error" && !stats}
    <ErrorState
      title="Unable to load admin panel"
      message={pageError?.message ?? "Request failed."}
    />
  {:else}
    {#if stats}
      <div class="stats-bar" aria-label="System stats">
        <div class="stat-card">
          <span class="stat-label">Users</span>
          <strong class="stat-value">{formatCount(stats.userCount)}</strong>
        </div>
        {#if stats.pendingVerificationCount > 0}
          <div class="stat-card stat-card-warn">
            <span class="stat-label">Pending verification</span>
            <strong class="stat-value">{formatCount(stats.pendingVerificationCount)}</strong>
          </div>
        {/if}
        <div class="stat-card">
          <span class="stat-label">Messages</span>
          <strong class="stat-value">{formatCount(stats.messageCount)}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Threads</span>
          <strong class="stat-value">{formatCount(stats.threadCount)}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Latest message</span>
          <strong class="stat-value">{formatDate(stats.latestMessageAt)}</strong>
        </div>
      </div>
    {/if}

    <section class="panel" aria-labelledby="users-heading">
      <div class="panel-header">
        <h2 id="users-heading" class="panel-title">Users</h2>
        <div class="search-wrap">
          <label class="sr-only" for="user-search">Search users</label>
          <input
            id="user-search"
            type="search"
            class="search-input"
            placeholder="Search by email or name..."
            bind:value={searchQuery}
            on:input={handleSearch}
          />
        </div>
      </div>

      {#if pageStatus === "error"}
        <p class="inline-error" role="alert">{pageError?.message ?? "Failed to load users."}</p>
      {:else if users.length === 0 && !isLoading}
        <p class="empty-msg">No users found{searchQuery ? " matching your search" : ""}.</p>
      {:else}
        <div class="table-wrap" aria-busy={isLoading}>
          <table class="user-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Verified</th>
                <th scope="col">Joined</th>
                <th scope="col">Sessions</th>
                <th scope="col">Last seen</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each users as user (user.id)}
                {@const rowKey = user.id}
                {@const rowError = actionError[rowKey]}
                {@const isBusy =
                  actionInProgress === `enable-${rowKey}` ||
                  actionInProgress === `reset-${rowKey}` ||
                  actionInProgress === `role-${rowKey}`}
                <tr class:row-disabled={user.status === "disabled"}>
                  <td class="cell-user">
                    <span class="user-email">{user.email}</span>
                    {#if user.displayName}
                      <span class="user-name">{user.displayName}</span>
                    {/if}
                  </td>
                  <td class="cell-role">
                    <select
                      class="role-select"
                      value={user.role}
                      disabled={isBusy || user.id === $authStore.user?.id}
                      aria-label="Role for {user.email}"
                      title={user.id === $authStore.user?.id ? "You cannot change your own role" : undefined}
                      on:change={(e) => handleRoleChange(user, e.currentTarget.value)}
                    >
                      <option value={UserRole.Member}>Member</option>
                      <option value={UserRole.Admin}>Admin</option>
                    </select>
                  </td>
                  <td class="cell-status">
                    <span class="badge badge-{user.status}">{user.status.replace("_", " ")}</span>
                  </td>
                  <td class="cell-verified">
                    {#if user.emailVerifiedAt}
                      <span class="verified-yes" title={formatDateTime(user.emailVerifiedAt)}>Yes</span>
                    {:else}
                      <span class="verified-no">No</span>
                    {/if}
                  </td>
                  <td class="cell-date">{formatDate(user.createdAt)}</td>
                  <td class="cell-num">{user.activeSessionCount}</td>
                  <td class="cell-date">{formatDateTime(user.lastSeenAt)}</td>
                  <td class="cell-actions">
                    <div class="action-group">
                      {#if user.status === "disabled"}
                        <button
                          type="button"
                          class="action-btn"
                          disabled={isBusy}
                          on:click={() => handleEnable(user)}
                        >Enable</button>
                      {:else}
                        <button
                          type="button"
                          class="action-btn action-btn-danger"
                          disabled={isBusy}
                          on:click={() => handleDisable(user)}
                        >Disable</button>
                      {/if}
                      <button
                        type="button"
                        class="action-btn"
                        disabled={isBusy}
                        on:click={() => handleResetPassword(user)}
                      >Reset pw</button>
                    </div>
                    {#if rowError}
                      <p class="row-error" role="alert">{rowError}</p>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="pagination">
          <button
            type="button"
            class="page-btn"
            disabled={currentPageIndex === 0 || isLoading}
            on:click={handlePrevPage}
          >Previous</button>
          <span class="page-info">Page {currentPageIndex + 1}</span>
          <button
            type="button"
            class="page-btn"
            disabled={!nextCursor || isLoading}
            on:click={handleNextPage}
          >Next</button>
        </div>
      {/if}
    </section>

    <section class="panel panel-muted" aria-labelledby="ingestion-heading">
      <h2 id="ingestion-heading" class="panel-title">Ingestion</h2>
      <p class="placeholder-msg">
        Ingestion run tracking is not yet implemented. The latest message date above is currently
        the best proxy for ingestion health — if no new messages appear over an extended period,
        investigate the ingestion pipeline.
      </p>
    </section>
  {/if}
</section>

<style>
  .page {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Stats bar */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
    gap: 0.6rem;
  }

  .stat-card {
    display: grid;
    gap: 0.18rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--border-soft);
    border-radius: 0.65rem;
    background: var(--bg-elevated);
  }

  .stat-card-warn {
    border-color: #f5e09a;
    background: #fef9e7;
  }

  .stat-card-warn .stat-label {
    color: #7d5a00;
  }

  .stat-card-warn .stat-value {
    color: #7d5a00;
  }

  .stat-label {
    font-size: 0.72rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .stat-value {
    font-size: 1.2rem;
    font-weight: 760;
    color: var(--text);
    line-height: 1.1;
  }

  /* Panel */
  .panel {
    background: var(--bg-elevated);
    border: 1px solid var(--border-soft);
    border-radius: 0.75rem;
    padding: 1.1rem 1.2rem;
    display: grid;
    gap: 0.85rem;
    min-width: 0;
  }

  .panel-muted {
    background: var(--surface-muted);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .panel-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
  }

  .search-wrap {
    flex: 1 1 16rem;
    max-width: 22rem;
  }

  .search-input {
    width: 100%;
    padding: 0.42rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg);
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
    box-sizing: border-box;
  }

  .search-input:focus {
    outline: 3px solid var(--focus-ring-color);
    outline-offset: 2px;
    border-color: var(--primary);
  }

  /* Table */
  .table-wrap {
    overflow-x: auto;
    min-width: 0;
  }

  .table-wrap[aria-busy="true"] {
    opacity: 0.7;
  }

  .user-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.84rem;
  }

  .user-table th {
    padding: 0.45rem 0.7rem;
    text-align: left;
    font-size: 0.72rem;
    font-weight: 640;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-soft);
    white-space: nowrap;
  }

  .user-table td {
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid var(--border-soft);
    vertical-align: top;
    color: var(--text);
  }

  .user-table tr:last-child td {
    border-bottom: none;
  }

  .row-disabled td {
    opacity: 0.6;
  }

  .cell-user {
    display: grid;
    gap: 0.1rem;
  }

  .user-email {
    font-weight: 600;
    word-break: break-all;
  }

  .user-name {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .cell-date {
    white-space: nowrap;
    color: var(--text-subtle);
    font-size: 0.82rem;
  }

  .cell-num {
    text-align: center;
  }

  /* Role select */
  .role-select {
    padding: 0.28rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg);
    color: var(--text);
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }

  .role-select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Status badges */
  .badge {
    display: inline-block;
    padding: 0.18rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 640;
    white-space: nowrap;
  }

  .badge-active {
    background: #e6f9ee;
    color: #166534;
    border: 1px solid #b3e8c8;
  }

  .badge-disabled {
    background: var(--danger-soft);
    color: var(--danger);
    border: 1px solid var(--danger-border);
  }

  .badge-pending_verification {
    background: #fef9e7;
    color: #7d5a00;
    border: 1px solid #f5e09a;
  }

  .verified-yes {
    color: #166534;
    font-size: 0.82rem;
  }

  .verified-no {
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  /* Actions */
  .cell-actions {
    min-width: 10rem;
  }

  .action-group {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .action-btn {
    padding: 0.28rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text-subtle);
    font-size: 0.78rem;
    font-weight: 640;
    cursor: pointer;
    white-space: nowrap;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--primary-soft);
    border-color: rgba(111, 159, 221, 0.6);
    color: var(--primary);
  }

  .action-btn-danger:hover:not(:disabled) {
    background: var(--danger-soft);
    border-color: var(--danger-border);
    color: var(--danger);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .row-error {
    margin: 0.35rem 0 0;
    font-size: 0.78rem;
    color: var(--danger);
  }

  /* Pagination */
  .pagination {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    justify-content: center;
  }

  .page-btn {
    padding: 0.38rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-elevated);
    color: var(--text-subtle);
    font-size: 0.84rem;
    font-weight: 640;
    cursor: pointer;
  }

  .page-btn:hover:not(:disabled) {
    background: var(--primary-soft);
    border-color: rgba(111, 159, 221, 0.6);
    color: var(--primary);
  }

  .page-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .page-info {
    font-size: 0.84rem;
    color: var(--text-muted);
  }

  /* Misc */
  .inline-error {
    margin: 0;
    font-size: 0.85rem;
    color: var(--danger);
  }

  .empty-msg {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
  }

  .placeholder-msg {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-muted);
    line-height: 1.55;
  }
</style>
