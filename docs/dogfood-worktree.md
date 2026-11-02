# Authoring the dogfood Workspace in a worktree

The dogfood Workspace is `<repo>/.uiux/`. An Agent changes it in a `git worktree` of this repository, never in the owner's checkout, and Git is the base, diff, merge and conflict detection. The rule and its rulings are in AGENTS.md (Discussion #379, owner ruling 1: https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19236211); this page is the procedure. There is no `uiux workspace apply` command.

Never run `uiux dev`, `uiux artifacts gc` or any authoring against the owner's checkout. `scripts/dogfood-worktree.mjs` refuses a primary checkout.

## Procedure

1. Create the worktree on a new branch from the current `main`, and install:

   ```sh
   git fetch origin
   git worktree add ../uiux-dogfood-<topic> -b dogfood/<topic> origin/main
   cd ../uiux-dogfood-<topic>
   pnpm install --frozen-lockfile
   ```

2. Prepare it (`pnpm dogfood:worktree prepare [--home <dir>] [--no-build]`). It makes a temporary `UIUX_HOME` outside the worktree (mode 0700; never `~/.uiux`), runs `pnpm build` when `.output/` is missing, and creates an Agent member `dogfood-agent` (Editor preset) with a one-day Token in that home. It prints the Token, the exact `uiux dev` command and the clean-up commands. If `.uiux/kit/package.json` declares a kit project, install the kit's dependencies yourself; `uiux dev` runs the declared build.

3. Start the server with the printed `UIUX_HOME`, in a second terminal, against the worktree's Workspace only:

   ```sh
   UIUX_HOME=<printed home> node bin/uiux.mjs dev --workspace "$PWD/.uiux"
   ```

   The first start writes a Baseline Checkpoint into the worktree's `.uiux/history/`. That is expected and is never committed.

4. Author through MCP (`/mcp`, `Authorization: Bearer <Token>`) with the domain-specific operations of AGENTS.md. Do not edit canonical files by hand. The `.uiux/kit/` sources are code and may be edited directly.

   Formal Evidence can be recaptured through MCP (`capture_formal_evidence`) or, with the same Token, from a shell against the running server: `node bin/uiux.mjs evidence capture --all --token-file <file holding the Token> --workspace "$PWD/.uiux"` captures the base context of every View x Locale x viewport x theme, which are the contexts `pnpm dogfood:check` requires (it captures a View's Variants only when you pass `--variant`). Keep the Token in a file only you can read (the Token `prepare` printed, in a file outside the worktree) rather than in your shell history; it is never an argument. The command prints one line per context, stops at the first request the server refuses or answers with 422, and exits 1 when any context fails or is not attempted.

5. Stop the server (`uiux artifacts gc` refuses a Workspace a server serves), then select what to commit (`pnpm dogfood:worktree select`). It prints the exact `git add -- ...` list; add `--stage` to run it. It selects:

   - every changed canonical resource under `.uiux/` (a deleted one is staged as a deletion), and
   - the new Evidence blobs under `.uiux/artifacts/sha256/` that survive `uiux artifacts gc --dry-run` with an empty `UIUX_HOME`, run against the `.uiux/` as it would be committed (HEAD's plus the selected changes, `history/` from HEAD only).

   It never selects `.uiux/history/**` or an unreferenced blob (those are listed as skipped), and it warns about a tracked blob that changed or vanished (`git restore -- <path>`; blobs are content-addressed). Unreferenced new blobs and the Baseline Checkpoint stay as untracked files in the disposable worktree. Never `git add -A` or `git add .`.

   After a recapture, the same gc dry-run on the as-committed tree also finds the *tracked* blobs it would now collect (the Evidence the recapture superseded). `select` prints them as a `git rm -q -- ...` list, and `--stage` runs it, so the PR deletes them with the recapture and `.uiux/artifacts` does not grow without bound. A tracked blob you already deleted in the working tree is not flagged as damage when gc would collect it, and a deletion already staged is not listed again. `pnpm dogfood:check` prints a report-only `collectable tracked blobs: <n>` header line (the same dry-run on HEAD's committed `.uiux/`); it never fails the check. To collect in bulk without a recapture, run `uiux artifacts gc` with an empty temporary `UIUX_HOME` against the worktree's `.uiux/` (server stopped), then `git add -u .uiux/artifacts`; `.uiux/history/` stays untouched.

6. Commit, run the guards, push and open the PR:

   ```sh
   git commit -m "chore(dogfood): <what changed>"
   pnpm dogfood:guard
   ```

7. Clean up: `rm -rf <printed home>` and `git worktree remove <worktree>`.

If another PR changed the same `.uiux/` file first, the merge conflicts at file level (below). Rebase the worktree on the new `main` and re-author through MCP on that base instead of resolving JSON by hand.

## CI guards

`pnpm dogfood:guard [--base <ref>] [--head <ref>] [--allow-history]` (`scripts/dogfood-guard.mjs`) compares `merge-base(base, head)..head`; `--head` defaults to `HEAD`, `--base` to `origin/$GITHUB_BASE_REF`, else `origin/main`, else `main`. It reads the committed head, so commit first. CI runs it as the `dogfood-guard` job of `.github/workflows/ci.yml` on every pull request (full history checkout).

1. History guard: the PR adds or changes no `.uiux/history/**` file. A deletion is allowed.
2. Blob guard: `uiux artifacts gc --dry-run`, run with an empty `UIUX_HOME` against an export of the head's committed `.uiux/`, lists none of the Evidence blobs the PR adds. A blob the base already holds is not the PR's. When the PR adds no blob, gc is not run.

History escape hatch (history guard only): the owner's host legitimately writes Baseline Checkpoints and history under `.uiux/history/`, and the owner commits them. A PR carrying the `dogfood-history` label skips the history guard in CI (the `dogfood-guard` job also runs on `labeled` and `unlabeled`, and reads the labels from the event payload, so adding or removing the label reruns it); locally the same is `pnpm dogfood:guard --allow-history`. The output then prints `SKIP  history: skipped because --allow-history was given ...` with the number of history files the PR changes. Only the owner applies the `dogfood-history` label; an Agent never does, and an Agent's worktree-authored PR never carries history. The blob guard has no escape hatch. Modified history files are flagged as well as added ones.

Exit codes: 0 both pass, 1 a guard failed (the paths are listed), 2 usage or environment (no base ref, gc refused). The tests are `tests/dogfood-guard.test.ts`; `main` passes both guards (an empty PR, and the last dogfood Evidence commit `9084c39`, whose 48 added blobs are all reached).

## Drift check (`pnpm dogfood:check`)

`pnpm dogfood:check [--source <dir>] [--base <ref>] [--keep]` (`scripts/dogfood-check.mjs`, issue #383, Discussion #379 P4) answers whether the checked-in `.uiux/` is still the Workspace its Evidence was captured against, and whether the app, the Kit and the design tokens agree. It needs no owner host, recaptures nothing and never touches `.uiux/`; a PR author can run it in the worktree (the packaged server must be built: `pnpm build`, which the script runs when `.output/` is missing).

1. It copies `.uiux/` to a temporary directory without runtime files (`.server-hold*`, `.persistence*`, `.transactions/`), `kit/dist/` and `kit/node_modules/`, with a temporary `UIUX_HOME` and an explicit `--workspace` on every command. The copy links `kit/node_modules` to the repository's, because the kit build imports `esbuild` and `vue`.
2. It starts `uiux dev` on loopback against the copy (which runs the declared kit build there), creates a read-only member and a Token by CLI, and reads what the Workbench reads: `GET /api/evidence/list` (the formal captures with the current Adapter and Product Kit provenance), the Locale and View lists, and `POST /api/handoff/assess` for the Workspace root.
3. **Evidence.** Required render contexts are every View x Locale x viewport preset x theme of the Workspace, base context only (a Variant capture is an explicit extra, never implied). A context passes when at least one formal capture of it is fresh by the Workbench's own judgement (`evidenceFreshness` of `app/utils/readiness.ts`, bundled from the source with esbuild, so there is no second copy of the rule); a context with only stale or unknown captures is `STALE`, one with none is `MISSING`. Older captures that a fresh one supersedes are not listed (records carry no capture time, and `uiux artifacts gc` collects them). The Handoff readiness assessment must report no `handoff.stale_view_evidence`, `handoff.missing_view_evidence` or `handoff.incomplete_view_evidence`; its other blocking diagnostics (an open Review) are notes. A stale report names the Adapter `contentDigest` and Product Kit `outputDigest` now against the ones the stale captures recorded.
4. It runs the Kit registry and import scan (`checkProductKitAgainstKit`: any refusal or finding fails), `uiux components diff --check` (app against Kit, project = this repository) and `pnpm design:tokens --check`.
5. It fails if any file under the checked-out `.uiux/` (ignored files included) was added, removed or changed by the run (content, not file times).
6. **Requirement coverage** (`scripts/dogfood-coverage.mjs`). The copy gets a copy of `.spec/` and a `git init` of its own (the `spec` provider reads only a `.spec/` inside the Git work tree that holds the Workspace), and the check reads `GET /api/requirements`, the body of the `uiux://requirements` Resource (Clause 01a18120-f903-7f8d-9b44-d581ab520c0d). It fails when the provider `status` is not `ok`, when any ID is `unresolved` or `unverified`, when an ID is both referenced and `noUi`, and when the number of UI Rules left unreferenced (total - noUi - referenced, `counts.unreferenced`) is larger than at the merge base. Coverage is a ratchet, not 100%: it may only improve. The baseline is not a committed file; the script exports the merge base's own `.uiux/` and `.spec/` from Git (`git archive`, `--base <ref>`, default `origin/$GITHUB_BASE_REF`, `origin/main`, `main`; the CI job checks out with `fetch-depth: 0`) and runs the same coverage service on it, so no baseline can drift or be edited to hide a regression. When there is nothing to compare with (the checkout is the merge base itself, the base predates requirement references, no Git history) the ratchet is reported as not applied and the other conditions still hold. A `.spec/` PR that adds Rules raises the unreferenced count, so it must reference the new Rules from a View, Variant or Flow, or mark them `noUi` with a reason, in the same PR; a grown `noUi` count is printed as a note and judged by the reviewer. The report and the step summary print `referenced`, `noUi`, `remaining` and the ratio (today: referenced 211, noUi 341, remaining 359, ratio 37.0% of 570 UI Rules).
7. **Route coverage.** Every page under `app/pages/` must have an entry in `scripts/dogfood-routes.json`, keyed by its Nuxt route (`index.vue` is its directory, `[viewId].vue` is `:viewId`): `{ "views": [<View id>, ...] }` (every id must be a View of the Workspace; an empty list or an unknown id fails), `{ "exempt": "<reason>" }` for a page that is not a screen (the `/workspace` redirect) or `{ "todo": "<reason> #<issue>" }` for a surface that has no View yet, which is a warning, not a failure (none today). A page with no entry fails, and so does an entry for a route that no longer has a page. Views carry no route field (a schema change nobody accepted), so the mapping lives in the repository. When you add, rename or remove a page, update `scripts/dogfood-routes.json` in the same PR: map the page to the Views that show it (author them in the worktree first), or add an `exempt` with its reason, or a `todo` that names an issue. `tests/dogfood-check.test.ts` runs the same assessment on the real pages, so `pnpm test` fails on an unmapped page too.

Exit codes: 0 every check passes (a `WARN` passes), 1 a check failed, 2 usage or environment. The report goes to stdout and, in CI, to the step summary. CI runs it as the `dogfood-check` job of `.github/workflows/ci.yml`, report-only (`continue-on-error: true`) until 2026-11-11, then a required check (owner ruling 8 of Discussion #379). The tests of the decision logic are `tests/dogfood-check.test.ts`.

Cross-OS: freshness reads digests, not the platform. The View condition is a digest of the View's render input, a Locale condition is a revision hashed from the file's bytes, and the Adapter and Product Kit conditions are digests of the kit build output (`kit/dist/`) and `product-kit.json`; the Adapter `contentDigest` hashes the bytes of the `dist/` files and no host path. So Evidence captured on macOS is fresh on Linux exactly when the Linux kit build is byte-identical. The script prints the toolchain and the sha256 of every `kit/dist/` file so two hosts can be compared. Checked on the dogfood Kit (2026-10-28): the build output is identical across esbuild darwin-arm64 and darwin-x64 binaries, Node 22.22 and 24.15, and different build paths, and the CI job on Linux (node 24.20, linux-x64) reproduced the macOS Adapter and Product Kit digests exactly, so the Evidence captured on macOS was fresh there. A job that fails with `adapterChanged` on every context means the Kit changed without a recapture or the build stopped being byte-identical.

## `.gitattributes` `-merge`

`.gitattributes` holds `.uiux/**/*.json -merge`. With `merge` unset, Git does not run a content merge on those files: when both branches changed one, the merge stops with the file unmerged and the current branch's version in the working tree (no conflict markers). It was checked in a scratch repository: two branches edit different lines of `.uiux/workspace.json`, `.uiux/views/<id>.json` and a nested `.uiux/reviews/deep/a.json`, and `git merge` exits 1 with the file unmerged; without the attribute the same edits merge cleanly, and a JSON file outside `.uiux/` still merges. `tests/dogfood-guard.test.ts` runs that experiment. Blobs have no `.json` suffix and are content-addressed, so they never conflict.

## Limits

- The guards judge the committed files, not the author's intent: a blob that a Review submission or the newest Evidence reaches passes even if it is no longer wanted.
- The blob guard's roots are the ones gc has with an empty host history: Review submissions, committed Checkpoints, and the latest Evidence of each View and render context. An Evidence blob that only a local host history keeps is flagged, which is the point.
- Merge-base is taken against the base ref you give; fetch it first (`git fetch origin`) when running locally.
