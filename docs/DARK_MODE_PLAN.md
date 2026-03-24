# Dark Mode Implementation Plan

This document captures what it would take to add dark mode to the current `pginbox` frontend without changing the product scope beyond theme support.

Investigation date: 2026-03-23

## Recommendation

Implement dark mode in two phases:

1. local browser persisted theme support: `light | dark | system`
2. optional account synced appearance preference later

The first phase is frontend only and should come first. The current codebase does not have any existing theme store, `localStorage` theme persistence, or `prefers-color-scheme` handling, so there is no benefit to coupling the first rollout to backend work.

## Current state

There is already a partial token system in `src/frontend/App.svelte`:

- root variables for background, text, border, primary, danger, and focus colors
- some screens already use those variables consistently
- some screens still hardcode large numbers of light theme colors locally

High level findings from the audit:

- the frontend source still contains roughly 542 hardcoded color and gradient literals across 41 Svelte files
- the current token set is not wide enough for a full dark theme
- there is no first paint theme bootstrap in `src/frontend/index.html`
- there is no runtime theme store in `src/frontend/lib/state/*`

Largest source hotspots:

- `src/frontend/pages/AccountPage.svelte`
- `src/frontend/components/thread/AttachmentPreviewOverlay.svelte`
- `src/frontend/pages/ThreadDetailPage.svelte`
- `src/frontend/pages/LoginPage.svelte`
- `src/frontend/pages/VerifyEmailPage.svelte`
- `src/frontend/components/thread/ThreadTimelineItem.svelte`
- `src/frontend/components/thread/ThreadMessageAttachments.svelte`
- `src/frontend/pages/HomePage.svelte`
- `src/frontend/components/auth/AuthPageLayout.svelte`

Some sections are already close to theme ready and show the right direction:

- `src/frontend/pages/AdminPage.svelte`
- `src/frontend/components/people/PeopleList.svelte`

## Scope decisions

Recommended phase 1 behavior:

- support `light`, `dark`, and `system`
- persist the selected theme in `localStorage`
- resolve `system` from `matchMedia("(prefers-color-scheme: dark)")`
- apply the theme to the root document before the app mounts
- expose one global theme control in the shell

Recommended phase 1 non-goals:

- no backend persistence
- no database changes
- no user profile appearance field
- no redesign of unrelated layout or component structure

## Phase 1 plan

### 1. Define the theme contract

Primary file:

- `src/frontend/App.svelte`

Tasks:

- keep the existing root variables and expand them into a fuller semantic token set
- add a dark theme token block, ideally on `:root[data-theme="dark"]`
- keep light theme tokens explicit as the default
- set `color-scheme` based on the resolved theme

Add missing semantic tokens for:

- stronger and softer surfaces
- elevated surfaces
- hover and selected fills
- overlay and backdrop colors
- tooltip colors
- success colors
- warning colors
- muted control colors
- code preview colors
- diff colors for add, remove, hunk, and metadata rows
- shadow values that work in both themes

Important detail:

- convert remaining shell-specific literals in `App.svelte` to semantic tokens, including background gradients, nav surfaces, skip link styles, and footer separators

### 2. Add first paint theme bootstrap

Primary files:

- `src/frontend/index.html`
- `src/frontend/main.ts`

Tasks:

- add a tiny inline bootstrap script in `index.html` that reads the saved theme selection before the app loads
- resolve `system` to light or dark immediately
- set `document.documentElement.dataset.theme`
- set `document.documentElement.style.colorScheme`

Reason:

- without this, the app will paint light mode first and then switch after hydration
- this matters for the page background, inputs, dialogs, and any component using root tokens

### 3. Introduce a theme store

Proposed new file:

- `src/frontend/lib/state/theme.ts`

Tasks:

- implement a small Svelte store following the same general pattern used by `auth.ts`
- expose selected theme and resolved theme separately
- persist selected theme to `localStorage`
- listen for system theme changes when the selected mode is `system`
- provide a single function that applies the resolved theme to the document root

Expected shape:

- selected theme: `light | dark | system`
- resolved theme: `light | dark`

### 4. Add the theme control UI

Primary file:

- `src/frontend/App.svelte`

Recommendation:

- put the control in the global shell, not only on the account page
- keep it reachable before login

Acceptable UI options:

- compact segmented control
- popover menu
- small cycle button if visual space is tight

Functional requirements:

- keyboard accessible
- clear current selection
- updates immediately without page reload
- works on mobile nav as well as desktop shell

### 5. Convert shared auth surfaces first

Primary files:

- `src/frontend/components/auth/AuthPageLayout.svelte`
- `src/frontend/pages/LoginPage.svelte`
- `src/frontend/pages/RegisterPage.svelte`
- `src/frontend/pages/ForgotPasswordPage.svelte`
- `src/frontend/pages/ResetPasswordPage.svelte`
- `src/frontend/pages/VerifyEmailPage.svelte`
- `src/frontend/components/SuccessState.svelte`
- `src/frontend/components/ErrorState.svelte`
- `src/frontend/components/LoadingState.svelte`

Why this comes first:

- these files repeat the same light theme form and card patterns
- converting them early gives broad coverage quickly
- it will force the token set to be usable for real forms, cards, buttons, notices, and validation states

Specific work:

- replace hardcoded inputs, cards, pills, helper links, and notice backgrounds with tokens
- unify success and warning semantics under shared tokens
- convert gradient and shadow values in `AuthPageLayout`

### 6. Convert high impact app screens

Primary files:

- `src/frontend/pages/AccountPage.svelte`
- `src/frontend/pages/ThreadDetailPage.svelte`
- `src/frontend/components/thread/ThreadTimelineItem.svelte`
- `src/frontend/components/thread/ThreadMessageAttachments.svelte`
- `src/frontend/components/thread/AttachmentPreviewOverlay.svelte`
- `src/frontend/pages/HomePage.svelte`
- `src/frontend/pages/PersonDetailPage.svelte`
- `src/frontend/components/thread/ThreadPageControls.svelte`
- `src/frontend/components/account/TrackedThreadList.svelte`
- `src/frontend/components/people/PersonTopThreadsList.svelte`
- `src/frontend/components/people/PersonEmailList.svelte`

This is the manual part of the project. These files are not just generic cards and inputs.

Special handling required:

- `AttachmentPreviewOverlay.svelte` has code preview and patch diff colors that need explicit dark tokens
- `ThreadTimelineItem.svelte` has quote stripes and text emphasis that should not be inverted blindly
- `ThreadMessageAttachments.svelte` has attachment badges and download controls
- `HomePage.svelte` has decorative gradients and translucent surfaces
- `AccountPage.svelte` has many badges, pills, overlays, and form controls with duplicated light state styling

### 7. Cleanup pass across the remaining app

Primary files:

- `src/frontend/pages/AdminPage.svelte`
- `src/frontend/pages/AnalyticsPage.svelte`
- `src/frontend/components/analytics/*`
- `src/frontend/components/threads/*`
- `src/frontend/components/people/*`
- `src/frontend/pages/ThreadsPage.svelte`
- `src/frontend/pages/PeoplePage.svelte`
- `src/frontend/pages/MessagePermalinkPage.svelte`
- `src/frontend/pages/NotFoundPage.svelte`

Goals:

- remove the remaining hardcoded theme-specific values
- keep intentional exceptions small and documented
- make all hover, selected, and disabled states theme aware

## Verification plan

### Static validation

Run:

- `npm run svelte-check` in `src/frontend`
- `npm run build` in `src/frontend`

Reason:

- the repo has type and build validation, but no dedicated frontend test suite for visual theme regressions

### Manual QA checklist

Verify each page in light and dark:

- home
- login
- register
- forgot password
- reset password
- verify email
- account
- threads list
- thread detail
- person detail
- analytics
- admin

Verify specific behavior:

- no flash of incorrect theme on hard refresh
- native controls match the selected theme
- focus rings remain visible
- all text meets readable contrast
- banners and notices remain distinguishable
- hover and selected states are clear
- dialogs and backdrops read correctly
- attachment preview overlay works in both normal and fullscreen modes
- diff rows remain semantically readable in dark mode
- mobile navigation and responsive layouts still look correct

## Done criteria

Phase 1 is done when all of the following are true:

- theme can be changed between light, dark, and system without reload
- selection persists across refreshes
- first paint uses the correct resolved theme
- the shell, auth pages, thread pages, overlays, and main list pages all render correctly in both themes
- all major status tones use semantic tokens instead of one-off literals
- hardcoded light-only values are reduced to intentional exceptions only

## Phase 2 optional account synced appearance

This phase should happen only after phase 1 is stable.

Primary files and systems involved:

- `src/shared/api.ts`
- `src/frontend/lib/api.ts`
- `src/frontend/lib/state/auth.ts`
- `src/server/routes/account.ts`
- `src/server/services/auth.service.ts`
- `src/server/serialize.ts`
- database schema and migration files

Required changes:

- add an appearance field to the shared user shape
- extend the account update request and response contract
- persist the preference server side
- include the value in auth bootstrap and profile updates
- decide precedence between account preference and local browser state

Recommended precedence rule if phase 2 is implemented:

- authenticated user account preference wins unless the product explicitly wants per-device override behavior

## Rough estimate

Phase 1, local only:

- about 1.5 to 3 engineering days

Phase 2, account synced preference:

- about 1 to 2 additional engineering days

The biggest variable is not the store or the bootstrap. It is the manual component audit and the amount of polish required for overlays, diffs, gradients, and state styling.
