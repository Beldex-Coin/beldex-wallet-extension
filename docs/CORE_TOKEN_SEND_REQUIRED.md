# HF22 token sends require an upstream core release

**Status:** blocked on `@bdxi/beldex-app-bridge` · **Date:** 2026-10-24
**Finding:** token *sends* cannot work with any published bridge; token *reads* work today.

## What was verified

`async__send_funds` in the JS bridge forwards the whole args object into the WASM, and
`src/lib/send.ts` passes `token_id` / `token_decimal_point` / `is_deploy_token` /
`token_descriptor` — but no published core consumes them:

| Package | `token_id` in JS bridge | `token_id` in `BeldexLibAppCpp_WASM.wasm` |
|---|---|---|
| `@bdxi/beldex-app-bridge@3.0.1` (pinned) | 0 occurrences | 0 occurrences |
| `@bdxi/beldex-app-bridge@3.0.2` (npm latest, 2026-08-15) | 0 occurrences | 0 occurrences |

So a "token send" reaches a WASM that has never heard of tokens. Observed behavior is an
opaque construction failure ("transaction failed"); the dangerous variant would be a core
that *ignores* unknown fields and silently builds a **plain-BDX** transaction from a token
approval. Both are unacceptable, hence the gate below.

## The gate (in this repo)

`CORE_SUPPORTS_TOKEN_TX = false` in `src/lib/dappProtocol.ts`:

- the dapp router refuses `bdx_sendTransaction` with `tokenId` **before** any approval
  surface opens (`-32603 "token sends are not supported by this wallet core yet …"`);
- `sendFunds()` throws the same for the panel's token send and token registration paths.

Token **reads** (`bdx_getTokenBalance`, `bdx_getTokenBalances`, `bdx_getTokenInfo`, the
panel Tokens screen) are pure LWS calls and keep working.

## What the core must ship (beldex-core-cpp → @bdxi/beldex-app-bridge)

`send_funds` / `WantsToCreateTx` form-submission support for:

- `token_id: string` — build the transaction's outputs in that token (HF22 output type),
  selecting token unspent outputs (`/get_unspent_outs` with the token id) while paying the
  network fee from BDX outputs;
- `token_decimal_point: string` — display-units → atomic conversion for `send_amount`;
- `is_deploy_token` + `token_descriptor { ticker, full_name, meta_info, decimal_point,
  total_max_supply, current_supply }` — registration path (mints to self, locks collateral,
  returns the derived `token_id`);
- result additions: `token_id` on registration; `total_sent` in token units for token sends.

Unknown-field behavior MUST be fail-loud: a core that doesn't support tokens must reject a
submission carrying `token_id`, never build a BDX transaction from it.

## Unblock checklist

- [ ] beldex-core-cpp HF22 send support merged; `@bdxi/beldex-app-bridge` published (3.1+)
- [ ] Extension: pin the new version, flip `CORE_SUPPORTS_TOKEN_TX = true`, rebuild
- [ ] Verify end-to-end on testnet: panel token send, dapp token send (approval card shows
      token units), token registration; confirm a BDX-only core rejects `token_id`
