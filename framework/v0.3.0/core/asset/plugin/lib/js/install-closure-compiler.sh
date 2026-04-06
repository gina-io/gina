#!/usr/bin/env bash
# Downloads Google Closure Compiler JARs from Maven Central
# and restores the compiler.jar symlink.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAVEN_BASE="https://repo1.maven.org/maven2/com/google/javascript/closure-compiler"

JARS=(
    "closure-compiler-v20160619.jar:v20160619"
    "closure-compiler-v20220104.jar:v20220104"
)

for entry in "${JARS[@]}"; do
    filename="${entry%%:*}"
    version="${entry##*:}"
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

ln -sf ./closure-compiler-v20220104.jar "${SCRIPT_DIR}/compiler.jar"
echo "[ok] compiler.jar -> closure-compiler-v20220104.jar"
