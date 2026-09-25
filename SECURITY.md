# Security policy

## Supported versions

Security fixes are released in the latest version of gina only; earlier versions are not patched. To upgrade:

```bash
npm install gina@latest
```

Published advisories are listed at <https://github.com/gina-io/gina/security/advisories>.

## Reporting a vulnerability

Please report security issues privately through GitHub, not in a public issue:
<https://github.com/gina-io/gina/security/advisories/new>

We aim to respond within 72 hours.

## Snyk advisory SNYK-JS-GINA-5406434 is a false positive

Snyk's page for gina shows a "This is a malicious package" banner. It comes from a single Snyk record, [SNYK-JS-GINA-5406434](https://security.snyk.io/vuln/SNYK-JS-GINA-5406434), which applies only to version `0.1.1-alpha.234`, a prerelease published in March 2023. Snyk's own page states that the record does not affect the latest version.

- **That version no longer exists.** We removed `0.1.1-alpha.234` from the npm registry on 2026-08-20, so no installable version of gina is covered by the record.
- **It was never malicious.** Its install scripts only did local setup: they found the npm install prefix and added a directory to the user's `PATH` in `~/.profile`. They made no network requests, downloaded nothing, and read no credentials. The flag most likely came from an `eval()` that the scripts used to call their own setup functions; since April 2026 the install scripts call those functions directly.
- **It is not a dependency-confusion package.** The record describes a package that copies a company's internal package name to trick employees into installing it. gina is the original package under this name, first published on npm in October 2014.
- **No other database lists gina as malicious.** As of September 2026, neither OSV, the GitHub Advisory Database, nor the OpenSSF malicious-packages dataset lists it.

We asked Snyk to withdraw the record in July and August 2026 and have not had a reply. We will update this section when they respond.

To check for yourself:

```bash
npm view gina time.created             # 2014-10-26
npm view gina@0.1.1-alpha.234 version  # E404 "No match found": the version is no longer published
npm view gina maintainers              # the gina.io maintainer account
```
