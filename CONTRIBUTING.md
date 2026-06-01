# Contributing to BenchAGI CLI

Thanks for helping improve `@benchagi/cli`. This package publishes two commands from one install: `benchagi` (the V2 streaming-aware CLI and the preferred command going forward) and `bench` (a deprecated back-compat alias that still supports the existing everyday verbs).

## Prerequisites

- Node.js `>=20.10` (from `package.json` engines)
- npm (the repository includes `package-lock.json` and npm scripts)
- A local OpenClaw setup if you want to exercise end-to-end CLI flows (`benchagi doctor` / `bench setup`)

## Local setup

From the repository root:

```bash
npm install
npm run build
```

Run the CLIs locally from source:

```bash
node ./bin/benchagi.mjs doctor
node ./bin/bench.mjs setup
```

## Testing

Use the existing package scripts:

```bash
npm test
npm run test:v2
```

Optional local script checks:

```bash
npm run lint
```

## Pull request workflow

1. Create a focused branch for one scoped change.
2. Keep changes small and aligned with existing patterns in this repo.
3. Before opening a PR, run:
   - `npm run build`
   - `npm test`
   - `npm run test:v2`
   - (`npm run lint` is recommended)
4. Open a draft PR with a clear summary, validation notes, and any follow-ups.
