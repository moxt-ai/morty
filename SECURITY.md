# Security Policy

Morty gives a browser a window into a coding Agent running on someone's own
computer. Session traffic, pairing, and shared access are the parts of that path
most worth scrutiny, and we would rather hear about a problem from you than from
an incident.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub private vulnerability reporting:
[**Report a vulnerability**](https://github.com/moxt-ai/morty/security/advisories/new).
The report stays private between you and the maintainers until a fix ships.

Helpful things to include:

- what an attacker can do, and what they need in order to do it
- the smallest reproduction you have, including the Agent (Codex, Claude Code, or Pi)
  and whether the connected machine was online
- affected versions or commit, and the `@moxt-ai/mobius` CLI version if setup is involved
- any sharing link, pairing, or revocation step that is part of the path

Please do not include live credentials, pairing tickets, or customer data in a
report. Describe where they appear instead.

## What to expect

- We acknowledge a report within **3 business days**.
- We send an initial assessment, including whether we consider it in scope, within
  **10 business days**.
- We keep you updated while a fix is in progress, and we credit you in the advisory
  unless you ask us not to.

## Scope

In scope:

- this repository and the deployed application at `morty.build`
- pairing, sharing links, access revocation, and session authorization
- the setup path served at `morty.build/setup.md` and `morty.build/setup.mjs`

Report issues in the SDK, relay, or local daemon to
[Mobius](https://github.com/moxt-ai/mobius/security/advisories/new) instead.

Generally out of scope:

- findings that require an already-compromised connected machine, or an attacker
  who already has the operating-system account that ran setup
- missing hardening with no demonstrated impact, and automated scanner output
  without a working path to exploitation
- denial of service through traffic volume
- the absence of end-to-end encryption, which is a documented design property
  rather than a defect; see [What Morty does with your data](README.md#what-morty-does-with-your-data)

## Testing against your own setup

Test against machines and projects you control. Do not attempt to reach other
users' sessions, and do not run tests that degrade the service for other people.
If a test accidentally gives you access to something that is not yours, stop, and
tell us what happened in the report.
