# Contributing

`main` accepts pull requests only, and squashes them: the squash commit message is the PR title. release-please derives the version from those commit types and publishes the result to npm.

## Branches

Work branches are `feat/<slug>` or `fix/<slug>`. Pipeline and docs changes branch as `<type>/<slug>`, matching the title type.

| Branch | Work | Release |
| --- | --- | --- |
| `feat/<slug>` | New behavior | minor: `0.1.0` → `0.2.0` |
| `fix/<slug>` | Bug fix | patch: `0.1.0` → `0.1.1` |
| `ci/<slug>`, `docs/<slug>`, `chore/<slug>` | Pipeline, docs, housekeeping | none |

Branch from `main` and rebase on `main` before merging: the required checks are evaluated against the current `main`.

## PR titles

A Conventional Commit title: `<type>[(scope)][!]: <summary>`. The `lint-pr-title` check rejects anything else and prints the release the title produces.

| Title type | Next release |
| --- | --- |
| `fix:`, `deps:` | patch |
| `feat:` | minor |
| `feat!:`, or a `BREAKING CHANGE:` footer in the PR body | minor while below `1.0.0`; above `1.0.0` the PR is blocked until the version is named |
| `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `build:`, `ci:`, `chore:`, `revert:` | none |

A `chore: ...` title hides a `feat:` change from the release. Retitle the PR instead of merging it.

## Version policy

- `fix:` and `deps:` move the patch version, the last number.
- `feat:` moves the minor version, the middle number.
- The major version is named by hand. `1.0.0` is never inferred from a commit.

`package.json`, `.release-please-manifest.json`, and `CHANGELOG.md` are owned by release-please: edit them only through a release PR.

To name the next version, end the PR body with a footer as its own last paragraph, after a blank line:

```
Release-As: 1.0.0
```

Squash merging copies the PR body into the commit body, and release-please reads footers only there. A `Release-As:` line anywhere else in the body is ignored, and `lint-pr-title` fails the PR.

## Release flow

1. Merge the PR. CI tests the merge commit on `main`, and the Release workflow creates or updates exactly one release PR: `chore(main): release <version>`.
2. Merge the release PR. That commit writes the version into `package.json`, appends `CHANGELOG.md`, tags `v<version>`, and opens the GitHub Release.
3. The same run tests the tagged commit and publishes it to npm with a provenance attestation.

Nothing is published without a merged release PR, so the version in `main` and the version on npm stay in step.

## One-time setup

| Where | What |
| --- | --- |
| GitHub → Settings → Secrets and variables → Actions | Secret `RELEASE_PLEASE_TOKEN`: a fine-grained PAT with `contents: write` and `pull-requests: write` on this repository |
| npmjs.com → `pi-profile-switch` → Settings → Publishing access | Trusted publisher: GitHub Actions, owner `VincentFF`, repository `pi-profile-switch`, workflow `release.yml` |

The token exists because GitHub does not start workflows for events authored by the default `GITHUB_TOKEN`. Without the secret the release PR appears with no checks reported, and branch protection keeps it unmergeable; close and reopen the release PR to run the checks by hand.

## Recovery

| Symptom | Recovery |
| --- | --- |
| The release PR proposes the wrong version | Land a PR whose body ends with `Release-As: <version>`; the pending release PR is rewritten to it |
| `test` fails on the release PR | Fix `main` with a normal PR; release-please rewrites the release PR on the next push |
| `publish-npm` fails | Re-run the failed jobs of that run. The tag and the GitHub Release already exist, so re-running the whole workflow would skip the publish job |
| npm rejects the version as already published | Publish that version by hand from the tag; the next release takes the following version |
