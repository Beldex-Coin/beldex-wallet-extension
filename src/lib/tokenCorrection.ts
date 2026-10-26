// Key-image-corrected HF22 token balances, published for the dapp bridge.
//
// The background answers bdx_getTokenBalance but cannot derive key images (the
// WASM only loads in window contexts), so a window context — the panel, or the
// send-approval card after a token send — publishes, per token, the verified
// total next to the raw server total it saw. background/dapp.ts reads it under
// the same storage.session key (keep in sync) and adds the decoy overcount
// (verified − raw) to the current raw figure.

import { fetchAllTokenOutputs, getTokenBalances } from './tokenApi'
import type { TokenBalanceEntry } from './tokenApi'
import { verifiedTokenBalances } from './spent'
import { sessionStore } from './sessionStore'
import type { WalletSecrets } from './messages'

export const CORRECTED_TOKENS_KEY = 'corrected_token_balances'

const big = (v: unknown) => { try { return BigInt(String(v ?? 0)) } catch { return 0n } }

/** Store the correction from figures the caller already has. Only tokens the
 *  verification actually covered are recorded; the rest stay uncorrected. */
export async function storeCorrectedTokenBalances(
  address: string, tokens: TokenBalanceEntry[], verified: Map<string, bigint>
): Promise<void> {
  const out: Record<string, { raw_total: string; verified_total: string }> = {}
  for (const t of tokens) {
    const v = verified.get(t.token_id)
    if (v === undefined) continue
    const received = big(t.total_received)
    const sent = big(t.total_sent)
    out[t.token_id] = {
      raw_total: (received > sent ? received - sent : 0n).toString(),
      verified_total: v.toString()
    }
  }
  await sessionStore.set({ [CORRECTED_TOKENS_KEY]: { address, tokens: out, at: Date.now() } })
}

/** Fetch, verify and store in one go (used after a dapp token send). */
export async function publishCorrectedTokenBalances(secrets: WalletSecrets): Promise<void> {
  const c = { address: secrets.address, view_key: secrets.secViewKey }
  const reply = await getTokenBalances(c, [])
  const verified = await verifiedTokenBalances(secrets, await fetchAllTokenOutputs(c))
  await storeCorrectedTokenBalances(secrets.address, reply.tokens ?? [], verified)
}
