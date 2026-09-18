# Engineering quality alignment — implementation status

Work started from fresh `origin/main`: Mobius Chat `352ae5f`, Mobius `94c544a`.
Both repositories use branch `refactor/moxt-alignment`.

## Implemented

- Combined Istanbul reporting scripts with informational targets: Chat 95%, Mobius
  100%, independently on lines, statements, functions, and branches.
- Production TS/TSX denominators include files that no test imports.
- Mobius root integration/e2e discovery restored to the required check.
- Build-before-test ordering avoids concurrent replacement of browser assets.
- Executable storage/infra/entity dependency restrictions, including type-only
  imports and indirect paths through barrels.
- Shared Slack contracts moved below services; Mobius hosting storage uses the
  lower-level Relay contracts entrypoint. Authentication composition is explicitly
  owned by the hosting composition directory.
- Informational Codecov configurations and combined coverage artifacts on
  main/PR/merge-group runs. GitHub-owned artifact uploads respect the Actions
  allowlist and are non-blocking. Chat deployment now depends on `check`.
- Repaired stale Platform tenant provisioning, Runtime credential fixtures,
  Runtime WebSocket authentication, pairing-response decoding, and deterministic
  process-deadline synchronization in existing acceptance scenarios.

## Verified findings

- Chat: 90 Worker tests and 40 web-package tests pass. Its combined baseline is
  21.57% lines, 20.93% statements, 15.89% functions, and 11.58% branches in the
  latest run. Typechecking, build, lint, architecture, and a separate Knip run pass;
   this baseline was collected before coverage thresholds became informational.
- Both architecture checks pass with real TypeScript dependency extraction.
- Both Mobius Cloudflare suites pass with package-local coverage collection.
- Mobius: all 292 tests pass (root 152, web 47, Standalone 60, Platform 33).
  Failed and cancelled native imports no longer publish a destination Session;
  failed local preparation removes its provisional link. Cancellation finishes
  process teardown before a following prompt can start. Preview results do not
  delete an unpublished destination. Discovery fixtures use deterministic time.
- Mobius's full check emits a combined report: 56.02% lines, 56.07% statements,
  58.96% functions, and 43.19% branches. Static checks and builds pass; the command
   originally exited nonzero at the 100% coverage gate, now informational.
- Root coverage does not collect execution inside separately launched processes,
  bundled Workers, or browsers. Shared Relay-core coverage from Cloudflare pools
  also needs repair: `allowExternal` caused report generation to fail.

These findings are a baseline, not completion of the quality requirements.

## Remaining work

1. Collect browser, subprocess, and shared Worker execution into compatible maps.
   Keep all source in the denominator while those collectors are missing.
2. Add user-visible acceptance scenarios for uncovered behavior until both targets
   are achieved. Chat's existing web-package tests exercise almost none of its UI.
3. Enable Codecov uploads if the organization's Actions allowlist permits them.
4. Obtain green `pnpm ci:check` results before coordinated delivery.

GitHub inspection found existing required `check` and `title` statuses in both
repositories; Mobius additionally has a merge-queue ruleset. Repository protection
settings have not been changed. Mobius commit `9a3936e` is published in
[PR #216](https://github.com/moxt-ai/mobius/pull/216); Chat references the
published Mobius branch. Per the delivery request, coverage targets and Codecov
statuses are informational; test failures and invalid coverage reports remain blocking.
