# Closure Compiler

The Google Closure Compiler JAR files are not stored in this repository.

## Requirements

- `curl`
- `java` >= 8 (to run the compiler during builds)

Run the install script once before building:

    bash install-closure-compiler.sh

Depending on where Gina was installed or cloned, you may need `sudo`:

    sudo bash install-closure-compiler.sh

This is typically required when installed under a system-wide prefix such as
`/usr/local`, and not needed for user-local installs like `~/.npm-global`.

This downloads the following JARs from Maven Central and creates the
`compiler.jar` symlink used by the `build` script:

- `closure-compiler-v20160619.jar` — requires Java 7+
- `closure-compiler-v20220104.jar` ← active (`compiler.jar` → this) — requires Java 8+
