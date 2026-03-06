# Contributing to OpenAPI Sync Action

## Working with code

We prefer using [pnpm](https://pnpm.io/) for installing dependencies and running scripts.

The main branch is locked for the push action. For proposing changes, use the standard [pull request approach](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request). It's recommended to discuss fixes or new functionality in the Issues, first.

### Setup

```shell
pnpm install
```

### Running tests

```shell
pnpm test
```

To run tests in watch mode:

```shell
pnpm test:watch
```

To run tests with coverage:

```shell
pnpm test:coverage
```

### Building

```shell
pnpm build
```

This bundles the TypeScript source into `dist/index.js` using esbuild.

### Linting

```shell
pnpm lint
```

To auto-fix linting issues:

```shell
pnpm lint:fix
```

### Type checking

```shell
pnpm typecheck
```

### Committing changes

We follow [Conventional Commits](https://conventionalcommits.org/) for committing changes. We use git hooks to check that the commit message is correct.

### Adding a changeset

We use [changesets](https://github.com/changesets/changesets) for versioning and release management. When making changes that should trigger a new release, add a changeset:

```shell
pnpm exec changeset
```

This will prompt you to select the type of version bump (patch, minor, major) and write a summary of the change. The changeset file will be committed alongside your code changes.

### How to publish

Releases are automated via changesets. On every push to `main`, the release workflow checks for pending changesets. If found, it creates a "Version Packages" PR. When that PR is merged, a new GitHub release and git tag are created automatically.

### Further help

If you have questions or need guidance, feel free to open an issue.
