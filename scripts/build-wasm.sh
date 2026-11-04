#!/usr/bin/env bash
# Rebuild the Beldex crypto core (vendor/beldex-app-bridge/BeldexLibAppCpp_WASM.{js,wasm})
# from pinned source, so a reviewer can check the shipped binary byte for byte.
#
#   scripts/build-wasm.sh             build, then compare with the vendored files
#   scripts/build-wasm.sh --install   build, then copy the result into vendor/
#
# What is pinned:
#   1. Every source repository, by full commit hash (SOURCES below). Each one is
#      fetched over public HTTPS, and every submodule commit is checked against
#      the gitlink its parent records, so the chain cannot silently drift.
#   2. The toolchain: emsdk at a fixed tag and commit. Emscripten fetches the
#      Boost headers port itself (-s USE_BOOST_HEADERS=1); emsdk pins that
#      download by version and sha512.
#   3. The build location. Emscripten 3.1.45 compiles its system libraries
#      with absolute paths in assert strings, and the project's CMakeLists.txt
#      writes its own directory into the wasm's sourceMappingURL section and
#      the glue's "// include:" comments. Building everything under one fixed
#      directory (WORK) makes those bytes identical on every machine. Do not
#      change WORK: a different path produces a different, equally valid,
#      binary that no longer matches the published hashes.
#
# The only change from the upstream build is -sDYNAMIC_EXECUTION=0, so embind
# does not generate code with `new Function` (forbidden by the MV3 CSP).
#
# Needs: git, python3, cmake (tested 3.28.3), make, curl, sha256sum. Works on
# Linux x86_64 and arm64. The first run downloads ~400 MB of emsdk.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/beldex-app-bridge"
OUT="$ROOT/build/wasm"

WORK=/tmp/beldex-libapp-wasm
SRC="$WORK/src"
EMSDK_DIR="$WORK/emsdk"

EMSDK_VERSION=3.1.45
EMSDK_COMMIT=c8dcb45665fec5e743336703f1d22a191810f2a8

# path in the tree (relative to SRC) | repository | commit
SOURCES=(
  ".|https://github.com/Beldex-Coin/beldex-libapp-js.git|573be3c2f9f5d33fcf9249b69b9e316f1bb6c76f"
  "src/submodules/beldex-libapp-cpp|https://github.com/Beldex-Coin/beldex-libapp-cpp.git|58629c8dc0c14e68940ffbd0bc6fb5d1ec704fb2"
  "src/submodules/beldex-libapp-cpp/src/beldex-core-cpp|https://github.com/Beldex-Coin/beldex-core-cpp.git|bb259e68b718b00a86f2e8b3f58c1fb3e2824974"
  "src/submodules/beldex-libapp-cpp/src/beldex-core-cpp/contrib/beldex-core-custom|https://github.com/Beldex-Coin/beldex-core-custom.git|7f6f8d1560ef72a146dc68358faa12b46fcf41fe"
  "src/submodules/beldex-libapp-cpp/src/beldex-core-cpp/contrib/beldex-core-custom/external/fmt|https://github.com/fmtlib/fmt.git|b6f4ceaed0a0a24ccf575fab6c56dd50ccf6f1a9"
  "src/submodules/beldex-libapp-cpp/src/beldex-core-cpp/contrib/beldex-core-custom/external/oxen-encoding|https://github.com/oxen-io/oxen-encoding.git|462be41bd481b331dabeb3c220b349ef35c89e56"
)

INSTALL=0
case "${1:-}" in
  "") ;;
  --install) INSTALL=1 ;;
  *) echo "usage: $0 [--install]" >&2; exit 2 ;;
esac

for tool in git python3 cmake make curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not found on PATH." >&2; exit 1; }
done

# ---- 1. fetch every source repository at its pinned commit -----------------

# fetch_at <dir> <url> <commit>: a shallow checkout of exactly <commit>.
fetch_at() {
  rm -rf "$1" && mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" fetch -q --depth 1 "$2" "$3"
  git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
  if [ "$(git -C "$1" rev-parse HEAD)" != "$3" ]; then
    echo "ERROR: $2 did not check out at $3." >&2
    exit 1
  fi
}

echo "[wasm] fetching sources into $SRC..."
rm -rf "$SRC"
for entry in "${SOURCES[@]}"; do
  IFS='|' read -r path url commit <<<"$entry"
  dir="$SRC/$path"
  if [ "$path" != "." ]; then
    # The parent must record this exact commit for this path, or the pins
    # above describe a tree nobody ever built.
    parent="$(git -C "$(dirname "$dir")" rev-parse --show-toplevel)"
    recorded="$(git -C "$parent" ls-tree HEAD "${dir#"$parent"/}" | awk '{print $3}')"
    if [ "$recorded" != "$commit" ]; then
      echo "ERROR: $path is pinned to $commit but its parent records ${recorded:-nothing}." >&2
      exit 1
    fi
  fi
  echo "  $path @ ${commit:0:12}"
  fetch_at "$dir" "$url" "$commit"
done

# ---- 2. install the pinned emsdk --------------------------------------------

# Clear anything an emsdk already active in this shell would inject.
unset EMSDK EMSDK_NODE EMSDK_PYTHON EM_CONFIG EM_CACHE EMCC_CFLAGS EMCC_DEBUG EMMAKEN_CFLAGS

if [ "$(git -C "$EMSDK_DIR" rev-parse HEAD 2>/dev/null || true)" != "$EMSDK_COMMIT" ]; then
  echo "[wasm] installing emsdk $EMSDK_VERSION into $EMSDK_DIR..."
  fetch_at "$EMSDK_DIR" https://github.com/emscripten-core/emsdk.git "$EMSDK_COMMIT"
fi
"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

# ---- 3. build -----------------------------------------------------------------

echo "[wasm] building with $(emcc --version | head -1)..."
cd "$SRC"
rm -rf build
emcmake cmake -S . -B build -DCMAKE_EXE_LINKER_FLAGS=-sDYNAMIC_EXECUTION=0 >/dev/null
emmake make -C build -j"$(nproc)" BeldexLibAppCpp_WASM >/dev/null

# Match calls only: the DYNAMIC_EXECUTION=0 glue still mentions `new Function`
# in a comment.
if grep -Eq '(new Function|newFunc)\(' build/BeldexLibAppCpp_WASM.js; then
  echo "ERROR: the glue still contains 'new Function' -- DYNAMIC_EXECUTION=0 did not apply." >&2
  exit 1
fi

rm -rf "$OUT" && mkdir -p "$OUT"
cp build/BeldexLibAppCpp_WASM.js build/BeldexLibAppCpp_WASM.wasm "$OUT/"

# ---- 4. compare with (or install into) vendor/ --------------------------------

echo "[wasm] built:"
(cd "$OUT" && sha256sum BeldexLibAppCpp_WASM.wasm BeldexLibAppCpp_WASM.js)

if [ "$INSTALL" = 1 ]; then
  cp "$OUT"/BeldexLibAppCpp_WASM.{js,wasm} "$VENDOR/"
  echo "[wasm] installed into vendor/beldex-app-bridge/. Run 'npm test' next."
  exit 0
fi

if cmp -s "$OUT/BeldexLibAppCpp_WASM.wasm" "$VENDOR/BeldexLibAppCpp_WASM.wasm" \
  && cmp -s "$OUT/BeldexLibAppCpp_WASM.js" "$VENDOR/BeldexLibAppCpp_WASM.js"; then
  echo "[wasm] MATCH: the vendored files are byte-identical to this build."
else
  echo "[wasm] DIFFER: vendor/beldex-app-bridge/ does not match this build." >&2
  (cd "$VENDOR" && sha256sum BeldexLibAppCpp_WASM.wasm BeldexLibAppCpp_WASM.js) >&2
  exit 1
fi
