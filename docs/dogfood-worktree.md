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

5. Stop the server (`uiux artifacts gc` refuses a Workspace a server serves), then select what to commit (`pnpm dogfood:worktree select`). It prints the exact `git add -- ...` list; add `--stage` to run it. It selects:

   - every changed canonical resource under `.uiux/` (a deleted one is staged as a deletion), and
   - the new Evidence blobs under `.uiux/artifacts/sha256/` that survive `uiux artifacts gc --dry-run` with an empty `UIUX_HOME`, run against the `.uiux/` as it would be committed (HEAD's plus the selected changes, `history/` from HEAD only).

   It never selects `.uiux/history/**` or an unreferenced blob (those are listed as skipped), and it warns about a tracked blob that changed or vanished (`git restore -- <path>`; blobs are content-addressed). It runs no deletion: unreferenced blobs and the Baseline Checkpoint stay as untracked files in the disposable worktree. Never `git add -A` or `git add .`.

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

## `.gitattributes` `-merge`

`.gitattributes` holds `.uiux/**/*.json -merge`. With `merge` unset, Git does not run a content merge on those files: when both branches changed one, the merge stops with the file unmerged and the current branch's version in the working tree (no conflict markers). It was checked in a scratch repository: two branches edit different lines of `.uiux/workspace.json`, `.uiux/views/<id>.json` and a nested `.uiux/reviews/deep/a.json`, and `git merge` exits 1 with the file unmerged; without the attribute the same edits merge cleanly, and a JSON file outside `.uiux/` still merges. `tests/dogfood-guard.test.ts` runs that experiment. Blobs have no `.json` suffix and are content-addressed, so they never conflict.

## Limits

- The guards judge the committed files, not the author's intent: a blob that a Review submission or the newest Evidence reaches passes even if it is no longer wanted.
- The blob guard's roots are the ones gc has with an empty host history: Review submissions, committed Checkpoints, and the latest Evidence of each View and render context. An Evidence blob that only a local host history keeps is flagged, which is the point.
- Merge-base is taken against the base ref you give; fetch it first (`git fetch origin`) when running locally.
