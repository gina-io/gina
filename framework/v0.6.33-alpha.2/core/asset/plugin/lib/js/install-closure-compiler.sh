#!/usr/bin/env bash
# Downloads Google Closure Compiler JARs from Maven Central and symlinks
# compiler.jar to the highest-compatible JAR for the installed Java.
#
# Three JARs are kept because each has a different minimum Java runtime:
#   v20160619 — bytecode 51, Java 7+
#   v20220104 — bytecode 52, Java 8+
#   v20260422 — bytecode 65, Java 21+   (current pin)
#
# Re-run this script after changing Java versions to re-pick the symlink.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAVEN_BASE="https://repo1.maven.org/maven2/com/google/javascript/closure-compiler"

# Entries are "<filename>:<version>:<min-java-major>", ordered lowest → highest.
JARS=(
    "closure-compiler-v20160619.jar:v20160619:7"
    "closure-compiler-v20220104.jar:v20220104:8"
    "closure-compiler-v20260422.jar:v20260422:21"
)

# Download all JARs (idempotent — skip if already present).
for entry in "${JARS[@]}"; do
    filename="${entry%%:*}"
    remainder="${entry#*:}"
    version="${remainder%%:*}"
    dest="${SCRIPT_DIR}/${filename}"

    if [ -f "${dest}" ]; then
        echo "[skip] ${filename} already present"
    else
        echo "[download] ${filename} ..."
        curl -L --fail --progress-bar \
            -o "${dest}" \
            "${MAVEN_BASE}/${version}/${filename}"
        echo "[ok] ${filename}"
    fi
done

# Detect Java major version.
if ! command -v java >/dev/null 2>&1; then
    echo "[error] 'java' not found on PATH. Install a JRE/JDK and re-run." >&2
    exit 1
fi

java_version_str=$(java -version 2>&1 | head -1 | awk -F'"' '/version/ {print $2}')
if [ -z "${java_version_str}" ]; then
    echo "[error] Could not parse 'java -version' output." >&2
    exit 1
fi

# Handle legacy '1.8.0_XXX' (Java 8 and earlier) vs modern '21.0.10'.
java_major=$(echo "${java_version_str}" | awk -F. '{print ($1 == "1") ? $2 : $1}')
if ! [[ "${java_major}" =~ ^[0-9]+$ ]]; then
    echo "[error] Could not determine Java major version from '${java_version_str}'." >&2
    exit 1
fi

# Pick the highest-compatible JAR.
target=""
for entry in "${JARS[@]}"; do
    filename="${entry%%:*}"
    remainder="${entry#*:}"
    min_java="${remainder##*:}"
    if [ "${java_major}" -ge "${min_java}" ]; then
        target="${filename}"
    fi
done

if [ -z "${target}" ]; then
    echo "[error] Detected Java ${java_major} is older than the minimum supported (7)." >&2
    exit 1
fi

ln -sf "./${target}" "${SCRIPT_DIR}/compiler.jar"
echo "[ok] compiler.jar -> ${target} (Java ${java_major} detected)"
