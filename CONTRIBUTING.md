# Contributing to DeepADB

DeepADB is open source and contributions are welcome. This guide covers the
practical mechanics; for how the codebase fits together, read ARCHITECTURE.md
first.

## Prerequisites

- Node.js 22.13 or newer on the Node 22 line, or Node 24+, for development
  including ESLint. The published runtime requirement remains Node >= 22;
  c8 12 coverage alone requires Node 22.12 or newer on the Node 22 line.
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
node --test tests/ci/emulator-reporting.test.mjs # CI reporting, no device access
```

The device-free suites (`test-boundaries`, `test-next-version`,
`test-result-handles`, `test-supply-chain`, `test-transports`,
`test-sanitize-fuzz`) run without any hardware and are the fastest way to
validate a change. A single suite can be run directly, e.g.
`node tests/test-next-version.mjs`. Device-facing changes should also run the
relevant hardware suite; the focused diagnostics use
`node tests/test-next-version-device.mjs`.

Some device-free suites also run optional hardware assertions when an
authorized device is visible. Disconnect USB and wireless devices, or use an
isolated ADB configuration, when you need a strictly device-free local run.

## CI and repository safeguards

- The Test workflow builds, lints, and runs device-free regressions on Node 22
  and 24, with a separate coverage job. Mocked emulator-reporting checks run
  separately from the server regression suites.
- Dependency auditing checks both production and development dependencies;
  high and critical advisories fail the audit job. Lower-severity findings
  remain visible in its output.
- CodeQL analyzes JavaScript/TypeScript and GitHub Actions on pull requests,
  main-branch pushes, and a weekly schedule.
- The weekly emulator lane is informational, not a merge gate. Its job
  summary reports the actual pass/fail/skip counts and execution status;
  unsupported physical-device capabilities can still fail assertions.
  A successful informational job is not proof that every test passed.
- Dependabot groups compatible development patch/minor updates. Major
  updates are reviewed separately, and TypeScript 7 is deferred until the
  lint stack supports it.

The protected `main` branch requires an up-to-date pull request, passing
Node 22/24 test jobs and coverage, and resolved review conversations. These
rules also apply to administrators; force pushes and branch deletion are
disabled. No additional approving reviewer is required for the solo-maintainer
workflow. New audit and analysis jobs must be validated on GitHub before they
are considered for required-check enforcement.

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
