# Contributing to DeepADB

DeepADB is open source and contributions are welcome. This guide covers the
practical mechanics; for how the codebase fits together, read ARCHITECTURE.md
first.

## Prerequisites

- Node.js >= 22 (the project uses ESM and modern language features). Running
  coverage with c8 12 requires Node 22.12 or newer.
- `npm`.
- For device-dependent tests: the Android SDK platform-tools (`adb`) on PATH,
  and a connected device or running emulator. The device-free suites need
  neither.

## Setup

```
npm ci          # install exact, locked dependencies (incl. dev deps)
npm run build   # compile src/ to build/ with tsc
```

## Running tests

```
npm test          # full suite (device-dependent parts need a device)
npm run test:ci   # device-free suites only (what CI runs)
npm run coverage  # full suite under c8; writes coverage/ (lcov + summary)
```

The device-free suites (`test-boundaries`, `test-result-handles`,
`test-supply-chain`, `test-transports`, `test-sanitize-fuzz`) run without any
hardware and are the fastest way to validate a change. A single suite can be
run directly, e.g. `node tests/test-boundaries.mjs`.

## Build discipline

Land changes with zero errors and zero warnings. The project compiles under a
strict `tsconfig` (`strict`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`); a clean `npm run build` is
a hard requirement before opening a PR. The harness runs the compiled output,
so rebuild after changing anything under `src/`.

## Coding conventions

- Every source file starts with the SPDX header and a module docstring.
- Never interpolate raw user input into a shell command. Pass it through
  `shellQuote()` (or reject it with `validateShellArg()`); this is the
  command-injection boundary and is not optional. See SECURITY.md.
- Every `z.number()` parameter has an explicit `.min()/.max()`. Every parameter
  has a `.describe()` with a concrete example where it helps.
- Use ESM import specifiers ending in `.js` (NodeNext resolution), e.g.
  `import { x } from "./middleware/sanitize.js"`.
- Line endings are LF, enforced by `.gitattributes`.

## Adding a tool

See the step-by-step list in ARCHITECTURE.md ("Adding a tool"). In short:
create or extend a module in `src/tools/` exporting `registerXxxTools(ctx)`,
register it in `server.ts`, add a device-free boundary test plus on-device
coverage, and update the README tool list and CHANGELOG.

## Commits and pull requests

- Keep commits small and focused; write what changed and why.
- Before opening a PR, confirm `npm run build` is clean and
  `npm run test:ci` passes. Run the relevant device-dependent suites locally
  if your change touches device behavior.
- Update documentation in the same PR as the code: the README tool list for
  new or renamed tools, and a CHANGELOG entry for any user-visible change.

## Security

Do not introduce raw shell interpolation or widen the on-device `su` allowlist.
To report a vulnerability, follow the process in SECURITY.md rather than opening
a public issue.

## License

DeepADB is licensed under Apache-2.0. By contributing, you agree that your
contributions are licensed under the same terms.
