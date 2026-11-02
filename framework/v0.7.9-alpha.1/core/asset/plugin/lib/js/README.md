# Closure Compiler

The Google Closure Compiler JAR files are not stored in this repository.

## Requirements

- `curl`
- `java` (>= 7 minimum; optimal on **21+** to unlock the current v20260422
  compiler)

Run the install script once before building:

    bash install-closure-compiler.sh

Depending on where Gina was installed or cloned, you may need `sudo`:

    sudo bash install-closure-compiler.sh

This is typically required when installed under a system-wide prefix such as
`/usr/local`, and not needed for user-local installs like `~/.npm-global`.

The script downloads three versioned JARs from Maven Central and creates a
`compiler.jar` symlink pointing at the **highest-compatible version for the
installed Java**:

| JAR | Bytecode | Min Java | Released |
|---|---|---|---|
| `closure-compiler-v20160619.jar` | 51 | 7+ | 2016-06-23 |
| `closure-compiler-v20220104.jar` | 52 | 8+ | 2022-01-06 |
| `closure-compiler-v20260422.jar` ← current pin | 65 | **21+** | 2026-04-22 |

Java-version detection runs at install time. If you upgrade or downgrade
Java after installing, **re-run `install-closure-compiler.sh`** to re-pick
the symlink.

## CI

The `bundle-freshness.yml` workflow pins `java-version: '21'`, so CI
always uses the v20260422 compiler and the committed `dist/vendor/gina/js/gina.*`
bundles must match its output. Contributors on Java 8–20 can still run local
development builds with the v20220104 compiler, but should not commit
`dist/` changes produced on a sub-21 JDK (the bundle-freshness CI job will
fail because its v20260422 rebuild won't match the committed bytes).
