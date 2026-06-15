# Contributing to obsync

Thanks for your interest in obsync. This is a personal tool with open-source
intent — contributions are welcome, but the project favors simplicity and
minimal dependencies over feature breadth.

## Filing Issues

Use [GitHub Issues](https://github.com/unconumb/obsync/issues) for bugs and
feature requests. When filing a bug, include:

- obsync version (`obsync --version`)
- OS (macOS, Linux, or Windows) and Node.js version
- The command you ran and the full output (redact any paths, API keys, or
  vault contents you don't want to share)
- What you expected to happen vs. what actually happened

## Development Setup

```bash
git clone https://github.com/unconumb/obsync.git
cd obsync
npm install
npm run build
npm test
npm run typecheck
```

- `npm run build` — compiles the CLI with tsup
- `npm test` — runs the test suite (vitest)
- `npm run test:coverage` — runs tests with coverage report
- `npm run typecheck` — runs `tsc --noEmit`

## Code Style

obsync is written in TypeScript. Match the existing code style and patterns
in the file you're editing — there's no separate style guide beyond what's
already enforced by `tsc` and the existing test suite.

## Pull Request Process

1. Branch from `main`.
2. Make your change, with tests where applicable.
3. Run `npm test` and `npm run typecheck` — both must pass before review.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for
   commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`,
   `perf:`, `ci:`).
5. Open a pull request describing what changed and why.

Small, focused PRs are easier to review and merge.
