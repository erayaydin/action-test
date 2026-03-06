# OpenAPI Sync Action

A GitHub Action that synchronizes OpenAPI schema files between repositories with automatic internal content filtering. It resolves `$ref` graphs, strips `x-internal` marked content, and creates PRs with only meaningful changes.

## Features

- **`$ref` graph resolution** — Walks the reference graph from an entrypoint to discover all reachable files
- **Internal content filtering** — Removes files and fields marked with `x-internal: true`
- **Smart diffing** — Only creates PRs when there are meaningful (non-whitespace) changes
- **Multi-mode support** — Handles both multi-file (unbundled) and bundled (single-file) schemas
- **PR lifecycle management** — Links source and target PRs, adds warnings when source is unmerged
- **Scoped file cleanup** — Deletes target files no longer reachable from the source, without touching unmanaged files

## Usage

```yaml
- name: Sync OpenAPI Schema
  uses: fingerprintjs/openapi-sync-action@v1
  with:
    config_path: openapi-sync.config.yaml
    target_repo: your-org/your-openapi-repo
    target_branch: sync-openapi
    pr_title: 'Sync OpenAPI Schema'
    github_token: ${{ secrets.TARGET_REPO_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `config_path` | Yes | — | Path to the sync config file (YAML) relative to source repo |
| `source_path` | No | `.` | Path to the source repo checkout |
| `target_repo` | Yes | — | Target repository (`owner/repo`) |
| `target_path` | No | `target` | Path to the target repo checkout |
| `target_branch` | Yes | — | Branch name for the PR in target repo |
| `github_token` | Yes | — | GitHub token for target repo access and PR operations |
| `pr_title` | Yes | `Sync OpenAPI Schema` | Pull Request title |
| `commit_message` | No | `chore: sync OpenAPI schema` | Commit message |
| `labels` | No | — | Comma-separated PR labels |
| `dry_run` | No | `false` | Only report diff, do not create PR |
| `source_pr_number` | No | — | Source PR number (for commenting with target PR link) |
| `source_repo` | No | — | Source repository (`owner/repo`, for commenting on source PR) |
| `source_pr_merged` | No | `true` | Whether the source PR is merged. If `false`, adds a warning to the target PR |

## Outputs

| Output | Description |
|---|---|
| `has_diff` | Whether meaningful changes were detected (`true`/`false`) |
| `diff_summary` | Human-readable summary of changes (e.g., `3 files modified, 1 added, 1 deleted`) |
| `target_pr_number` | PR number created/updated in target repo |

## Config File

The sync config file lives in the source repo and is referenced via the `config_path` input.

### Multi-file mode

```yaml
entrypoint: api/server-api.yaml
mode: multi_file

file_mappings:
  # Exact file mapping (e.g. rename the entrypoint)
  - source: api/server-api.yaml
    target: schemas/server-api.yaml

  # Directory mappings
  - source_dir: api/components
    target_dir: schemas/components

  - source_dir: api/paths
    target_dir: schemas/paths

internal:
  file_marker: x-internal
  strip_fields:
    - x-internal
  exclude_patterns: []
```

### Bundled mode

For pre-bundled single-file schemas:

```yaml
entrypoint: api/server-api.yaml
mode: bundled
bundled_file: api/dist/server-api.yaml

file_mappings:
  - source: api/dist/server-api.yaml
    target: schemas/server-api.yaml

internal:
  file_marker: x-internal
  strip_fields:
    - x-internal
  exclude_patterns: []
```

In bundled mode the action reads the pre-built `bundled_file`, strips internal fields, and writes a single cleaned file to the target. No `$ref` resolution is needed.

## Filtering

The action filters internal content at multiple levels:

**File-level** — Skip entire file if top-level `x-internal: true` is present, or if the file path matches an `exclude_patterns` glob.

**Path operations** — Remove operations (GET, POST, etc.) marked `x-internal: true`. If all operations on a path are internal, the entire path is removed.

**Parameters** — Remove individual parameters marked `x-internal: true`.

**Schema properties** — Remove properties marked `x-internal: true`.

**Dangling `$ref` cleanup** — After filtering, any `$ref` pointing to an excluded file is removed automatically.

**Field stripping** — All keys listed in `strip_fields` are removed from the output.

## Full Workflow Example

```yaml
name: Sync OpenAPI Schema

on:
  pull_request:
    types: [closed, labeled]
    branches: [main]
    paths:
      - 'api/**'
  workflow_dispatch:
    inputs:
      target_branch:
        description: 'Target branch name in OpenAPI repo'
        required: true
        default: 'sync-openapi'
      pr_title:
        description: 'PR Title'
        required: true
        default: 'Sync OpenAPI Schema'
      dry_run:
        description: 'Dry run (no PR created)'
        type: boolean
        default: false

jobs:
  sync:
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'workflow_dispatch' ||
      (github.event.action == 'closed' && github.event.pull_request.merged) ||
      (github.event.action == 'labeled' && github.event.label.name == 'OpenAPI')
    steps:
      - uses: actions/checkout@v4

      - name: Get GitHub App Token
        uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ vars.SYNC_APP_ID }}
          private-key: ${{ secrets.SYNC_APP_PRIVATE_KEY }}
          repositories: 'your-openapi-repo'

      - name: Sync OpenAPI
        uses: fingerprintjs/openapi-sync-action@v1
        with:
          config_path: openapi-sync.config.yaml
          target_repo: your-org/your-openapi-repo
          target_branch: ${{ inputs.target_branch || format('sync-{0}', github.event.pull_request.number) }}
          pr_title: ${{ inputs.pr_title || format('Sync OpenAPI Schema (#{0})', github.event.pull_request.number) }}
          github_token: ${{ steps.app-token.outputs.token }}
          source_pr_number: ${{ github.event.pull_request.number }}
          source_repo: ${{ github.repository }}
          source_pr_merged: ${{ github.event.pull_request.merged || 'true' }}
          dry_run: ${{ inputs.dry_run || false }}
```

## Development

```bash
pnpm install
pnpm test
pnpm build
```

## License

MIT
