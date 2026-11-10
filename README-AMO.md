# Beldex Wallet: build notes for AMO reviewers

- **Add-on:** Beldex Wallet 1.0.5
- **Add-on ID:** `beldex-wallet@beldex.io`
- **Publisher:** the Beldex team (https://beldex.io)
- **Source:** https://github.com/Beldex-Coin/beldex-wallet-extension

## This source package contains no generated code

Every code file here is written by hand. That includes the JavaScript wrappers in
`vendor/beldex-app-bridge/`. The only other files are `package-lock.json` (from npm), documentation,
and the icon images. The webpack bundles and the WebAssembly crypto core are **not** included.
`npm run build-for-amo` builds both from source.

## Build environment

- Linux x86_64 (or arm64). We tested on Ubuntu 24.04.
- Node.js 22 LTS (tested 22.23.2) and npm 10 (tested 10.9.8).
  Node 20 or newer is required: on Node 18 the build fails inside `copy-webpack-plugin`.
- For the WebAssembly step: `git`, `python3`, `cmake` (tested 3.28.3), `make` and `curl`, plus internet
  access. The first run downloads about 400 MB of Emscripten SDK into `/tmp/beldex-libapp-wasm`.
- No `.env` file and no environment variables are needed. Every endpoint comes from
  [`src/lib/networks.json`](src/lib/networks.json).

## Build

```bash
npm ci
npm run build-for-amo
```

`build-for-amo` runs two steps:

1. `scripts/build-wasm.sh --install` compiles the crypto core from pinned public source. It writes
   `BeldexLibAppCpp_WASM.wasm` and its Emscripten loader `BeldexLibAppCpp_WASM.js` into
   `vendor/beldex-app-bridge/` (see below).
2. `webpack --mode=production --env firefox` bundles `src/`.

The add-on is written to `firefox/`, with `manifest.json` at its root. It is byte-identical to the uploaded
package; our release script runs this same build from this same source package and checks that.

To also run the test suite (optional), run `npm test` after the build. Several tests use the built bundle,
and `test/bridge.test.mjs` runs the crypto bridge under `--disallow-code-generation-from-strings`,
which is the same restriction the MV3 CSP enforces.

## Where each file in the package comes from

| File in `firefox/` | Source |
|---|---|
| `manifest.json` | [`public/manifest.firefox.json`](public/manifest.firefox.json). At build time, `webpack.config.js` fills in `host_permissions` from the URLs in `src/lib/networks.json`. |
| `panel.js` | [`src/popup/`](src/popup/) (React UI in the sidebar) |
| `approval.js` | [`src/approval/`](src/approval/) (approval window for dapp requests) |
| `background.js` | [`src/background/`](src/background/) |
| `content.js` | [`src/content/`](src/content/) (relays dapp messages between the page and the background) |
| `inpage.js` | [`src/inpage/`](src/inpage/) (the `window.beldex` provider for dapps) |
| `panel.html`, `approval.html`, `icons/` | [`public/`](public/), copied unchanged |
| `fonts/*.woff2` | npm packages `@fontsource/michroma` and `@fontsource/space-mono`, copied unchanged |
| `*.LICENSE.txt` | License headers of the bundled npm libraries, extracted by webpack |
| `assets/BeldexLibAppCpp_WASM.wasm` | Built from source by `scripts/build-wasm.sh` (step 1 above), then copied unchanged |

The `.js` files are minified webpack output. The source for all of them is in `src/`, and the build uses
no source maps or eval-based tooling. npm dependencies are pinned in `package-lock.json` and are not modified.

## The crypto core (WebAssembly)

All key handling and transaction signing is done by the Beldex crypto library: C++ from
https://github.com/Beldex-Coin/beldex-core-cpp, compiled to WebAssembly with Emscripten.

The package [`vendor/beldex-app-bridge/`](vendor/beldex-app-bridge/) (`@bdxi/beldex-app-bridge` 4.0.0) is
installed through a `file:` dependency. Its hand-written JavaScript wrappers (`index.js`, `MyMonero*.js`)
are copied unchanged from https://github.com/Beldex-Coin/beldex-utils, `packages/beldex-app-bridge/`, at
commit `1c2d59e66916f8729b5ae579d2764db67f9b4c58` (branch `privacy-token-integration`). The npm registry
only has older versions of this package (up to 3.0.2), and this add-on does not use them.

The two generated files are not in this source package. Step 1 of the build produces them:

| File | What it is | sha256 after the build |
|---|---|---|
| `BeldexLibAppCpp_WASM.wasm` | The compiled crypto core | `538fb9e1f9487002dc16c82b78659a9aee86940dcc4c836f3a7f9a70db55e164` |
| `BeldexLibAppCpp_WASM.js` | Emscripten-generated loader, not minified, not edited | `f6fca26cfdff60cbe2b802d2c239e3182da52634f793a49ae210507ea3e15bff` |

The same two files, with the same hashes, are also in beldex-utils at the commit above.

### How the WASM is built

[`scripts/build-wasm.sh`](scripts/build-wasm.sh) does the whole job. `build-for-amo` runs it with
`--install`. Run without arguments, it compares its output with files already in `vendor/` and prints
`MATCH`.

**Pinned inputs.** The script fetches each source at a fixed commit over public HTTPS. It also checks every
commit against the gitlink its parent repository records.

| Path | Repository | Commit |
|---|---|---|
| (root) | https://github.com/Beldex-Coin/beldex-libapp-js | `573be3c2f9f5d33fcf9249b69b9e316f1bb6c76f` |
| `src/submodules/beldex-libapp-cpp` | https://github.com/Beldex-Coin/beldex-libapp-cpp | `58629c8dc0c14e68940ffbd0bc6fb5d1ec704fb2` |
| `…/src/beldex-core-cpp` | https://github.com/Beldex-Coin/beldex-core-cpp | `bb259e68b718b00a86f2e8b3f58c1fb3e2824974` |
| `…/contrib/beldex-core-custom` | https://github.com/Beldex-Coin/beldex-core-custom | `7f6f8d1560ef72a146dc68358faa12b46fcf41fe` |
| `…/external/fmt` | https://github.com/fmtlib/fmt | `b6f4ceaed0a0a24ccf575fab6c56dd50ccf6f1a9` |
| `…/external/oxen-encoding` | https://github.com/oxen-io/oxen-encoding | `462be41bd481b331dabeb3c220b349ef35c89e56` |

- **Toolchain:** Emscripten 3.1.45, installed by the script from emsdk at commit
  `c8dcb45665fec5e743336703f1d22a191810f2a8` (tag `3.1.45`). Emscripten supplies the Boost headers
  itself (`-s USE_BOOST_HEADERS=1`), pinned by that version.
- **Build:** `emcmake cmake -S . -B build -DCMAKE_EXE_LINKER_FLAGS=-sDYNAMIC_EXECUTION=0`, then
  `emmake make -C build BeldexLibAppCpp_WASM`, using the project's own `CMakeLists.txt`.
- **One flag added:** `-sDYNAMIC_EXECUTION=0` makes embind marshal arguments at runtime instead of
  generating invokers with `new Function`, which the MV3 CSP forbids. Nothing in the generated output is
  edited by hand.
- **Fixed build directory:** everything is built under `/tmp/beldex-libapp-wasm`. Emscripten writes
  absolute paths into the binary (assert messages in its system libraries and the `sourceMappingURL`
  section), so a fixed location is what makes the output identical on every machine.

## Network access

The seed and spend key never leave the browser. They are stored encrypted (AES-256-GCM, with the key
derived by PBKDF2 at 600,000 iterations), and every transaction is signed locally by the WASM core. The
add-on has no analytics and no remote code, and it adds no fees of its own.

These are the only hosts it contacts, which are also the only entries in `host_permissions`:

| Host | Purpose | Data sent |
|---|---|---|
| `lwsapi.rpcnode.stream`, `lwstestapi.rpcnode.stream` | Beldex light-wallet server (mainnet and testnet). `rpcnode.stream` is the domain Beldex owns and uses for its public nodes. | Wallet address and private **view** key (read-only: it can see incoming payments but cannot spend), which also serve as the account login (`/login`); signed transactions to broadcast |
| `explorer.beldex.io`, `testnet.beldex.dev` | Beldex Name Service (BNS) lookup | The name the user typed |
| `api.coingecko.com` | BDX price | Nothing user-specific |

Because of the LWS row, the manifest declares `data_collection_permissions.required:
["financialAndPaymentInfo", "authenticationInfo"]`, and Firefox asks the user to consent when they install. `strict_min_version`
is 140.0, the first version with this built-in consent, so there is no older Firefox that installs the
add-on without asking.

`src/lib/networks.json` also contains a `daemonRpc` URL for each network (testnet:
`http://209.126.86.93:29091/json_rpc`). It is kept for future use, nothing reads it, and it is not in
`host_permissions`, so the add-on never contacts it.

## Permissions

- `storage`: stores the encrypted wallet, and holds the unlocked session in `storage.session`.
- `alarms`: auto-lock and a 30-second balance sync.
- `notifications`: tells the user about incoming payments.
- **Content scripts on `https://` pages:** provide `window.beldex` so dapps can ask to connect. They only
  pass messages between the page and the background. They do not read or change page content. Every
  connection, send and signature needs the user's approval for that site.
