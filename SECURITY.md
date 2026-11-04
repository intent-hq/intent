# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through
[GitHub Security Advisories on intent-hq/intent](https://github.com/intent-hq/intent/security/advisories/new)
— the single tracker for all Intent components. Do **not** open a public issue
or pull request for a security problem.

If the advisory form is not available (for example, private vulnerability
reporting has not yet been enabled on the repository), contact the maintainers
privately rather than disclosing publicly.

This applies to all three components:

- `intentd` — Rust backend daemon
- `cloudlands-fe` — Electron + SvelteKit desktop frontend
- `ios` — SwiftUI iOS companion app

When reporting, please include the affected component, a description of the
issue and its impact, and reproduction steps or a proof of concept if you have
one.

## What to expect

We aim to acknowledge new reports within a few business days. Intent is a small
project without a dedicated security team, so we cannot promise a hard SLA, but
we will keep you informed as we triage and fix confirmed issues, and credit
reporters in the advisory unless they prefer otherwise.

## How fixes are released

Triage, discussion and private review of a fix happen in the private advisory. The
fix itself lands as an ordinary pull request with a neutral description, goes through
the normal CI and merge process, and ships in a regular release. We publish the
advisory after that release is out.

Maintainers: follow
[Landing a security fix](docs/RELEASING.md#landing-a-security-fix). Pull requests
opened in an advisory's private fork cannot be merged, so do not plan to land a fix
from there.

## Supported versions

Intent is pre-1.0 software. Only the latest code on the `main` branch of each
repository is supported; fixes are not backported to earlier snapshots or tags.
