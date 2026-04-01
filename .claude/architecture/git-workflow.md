# Git Workflow — Worktree, Merge Strategy, and Release Discipline

Reference for managing the `gina-dev` ↔ `develop` worktree pair and deciding when/how to merge.

---

## 1. Worktree Layout

| Worktree | Path | Branch |
|---|---|---|
| **Main** (live global install) | `~/.npm-global/lib/node_modules/gina` | `develop` |
| **Linked** (day-to-day work) | `~/Sites/gina/gina-dev` | `dev/wip` or feature branch |

**Critical rules:**
- `git checkout develop` from `gina-dev` always fails — `develop` is permanently checked out in the main worktree.
- `git mv framework/v{old}/ framework/v{new}/` renames files in the **live global install** once `develop` is fast-forwarded. Think through impact before bumping the framework version directory.
- Never `git reset --hard` or force-push `develop` — it corrupts the live global install.

---

## 2. Merge Frequency Policy

| Work type | Merge frequency |
|---|---|
| Bug fix, feature addition, docs, alpha patch (0.x.x-alpha.N) | **After every feature** — merge `dev/wip` → `develop` once the feature is stable and docs are updated |
| Minor version boundary (e.g. 0.3.x → 0.4.x) | **Hold** until the full release is prepared: changelog, roadmap, migration doc, version bump |
| Major version boundary (e.g. 0.x.x → 1.x.x) | **Hold** — `git mv framework/v*/` is a live deployment; test thoroughly before merging |

**Rationale for version boundaries:** `git mv framework/v{old} framework/v{new}` during merge is simultaneously a rename in the live `~/.npm-global` install. A botched merge at a version boundary breaks the globally-installed CLI.

---

## 3. Fast-Forward vs Merge Commit

```
# Preferred for incremental patch/alpha work when branches haven't diverged:
git merge --ff-only dev/wip

# Required when branches have diverged (unique commits on both sides):
git merge dev/wip --no-ff
```

To diagnose divergence before attempting:
```bash
git log develop..dev/wip   # commits unique to dev/wip (would be brought in)
git log dev/wip..develop   # commits unique to develop (would not be in ff)
```

If `git log dev/wip..develop` is non-empty → branches have diverged → `--ff-only` will fail.

---

## 4. Rebase vs Merge Confidence Assessment

When branches have diverged, choose between:
- **Option A — Merge commit**: Always safe. Use when confidence in rebase is < ~90%.
- **Option B — Rebase dev/wip onto develop**: Cleaner history. Risky when:
  - `develop` contains cherry-picked or duplicate commits of commits already in `dev/wip` (different hashes, same intent) — `patch-id` matching may mis-attribute conflicts.
  - Both branches modified the same large, frequently-edited files (`llms.txt`, `CHANGELOG.md`) in overlapping sections — conflict context shifts after each replayed commit.
  - `dev/wip` has many commits (≥ 4) that touch shared files — each replayed commit is a new conflict opportunity.

**Rule of thumb:** If `develop` has commits that are "the same work" as commits already on `dev/wip` (CB-BUG-4 duplicates are a real example), rebase confidence drops significantly. Choose the merge.

---

## 5. Resolving Merge Conflicts

Common conflict sites and resolution strategies:

| File | Conflict type | Resolution |
|---|---|---|
| `ROADMAP.md` footer | Both sides added a "last updated" line | Combine into one line with both messages |
| `llms.txt` gotchas | Both sides renumbered or added different gotchas | Keep ALL gotchas from both sides; renumber sequentially |
| `CHANGELOG.md` | Both added entries at the top | Keep both entries; sort by feature order |

General principle: **never discard content from either side** — merge conflicts in documentation files are almost always "both are right" situations.

---

## 6. Post-Merge Sync-Back

After resolving conflicts in the **main worktree** (`develop`), the linked worktree (`dev/wip`) will be missing the conflict resolutions.

Required sync-back pattern:
1. Identify what changed during conflict resolution (new content added to `develop` that `dev/wip` lacks).
2. Manually copy the additions to `dev/wip`.
3. Commit as `"Sync <content> from develop"` on `dev/wip`.

**Why:** The linked worktree has its own working tree. Merging `develop` back into `dev/wip` would require a reverse merge, creating unnecessary history. Targeted sync commits are cleaner.

---

## 7. The `docs/repo` Separate Repository

`~/Sites/gina/docs/repo` is a **separate git repository** (the Docusaurus docs site). It cannot be staged or committed from within `gina-dev`.

```bash
# This will FAIL (outside repository):
cd ~/Sites/gina/gina-dev
git add ~/Sites/gina/docs/repo/docs/roadmap.md   # ERROR

# Correct approach:
cd ~/Sites/gina/docs/repo
git add docs/roadmap.md
git commit -m "Update roadmap for 0.3.0-alpha.1"
```

Files in `docs/repo` that are frequently updated alongside `gina-dev`:
- `docs/roadmap.md` — must stay in sync with `gina-dev/ROADMAP.md`
- `docs/security.md` — CVE coverage page
- `docs/guides/controller.md`, `docs/cli/bundle.md`, etc.

---

## 8. README Convention

`README.md` is a landing page, not a tutorial. Target length: **~80 lines**.

Contents:
- Badges (CI, npm, license)
- One-line tagline
- 3 bullet highlights (top features)
- Feature table (what the framework includes)
- Quick start (≤ 10 lines, `npm install` + `gina bundle:start`)
- "What's new in X.Y.Z" section (current release highlights, ≤ 12 bullets)
- Documentation links (≤ 5 links)
- Governance + license

**Do NOT include** in README:
- Step-by-step tutorials (→ Docusaurus docs)
- Certificate chain guides (→ `docs/guides/https.md`)
- Environment variable lists (→ `docs/reference/settings.md`)
- Troubleshooting (→ docs or issues)

---

## 9. Docusaurus Sidebar Icons

Icons for the sidebar are injected by `docs/repo/src/theme/Root.js` via the `SidebarManager`'s `NAV_ICONS` map.

**Key rule:** The map key must be the **lowercase** value of the page's `sidebar_label` frontmatter.

```js
// frontmatter: sidebar_label: Security
// ↓ key is lowercase of that value
'security': `<svg .../>`,

// frontmatter: sidebar_label: Getting Started
'getting started': `<svg .../>`,
```

If an icon does not appear, the first thing to check is whether the key case matches `sidebar_label.toLowerCase()`.
