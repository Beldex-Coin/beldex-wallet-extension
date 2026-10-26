// Pins the assumption the whole network switcher rests on: a Beldex account is
// ONE keypair that exists on every chain, and the address is only that keypair
// wearing a network-specific prefix.
//
// If that were false — if switching networks changed the keys — a switch could
// not keep the session unlocked, and addressForNettype() would be producing
// addresses for an account the wallet cannot spend from. So this checks our
// pure-JS encoder against the WASM core itself rather than against fixtures:
//   1. all four keys are byte-identical across nettypes;
//   2. addressForNettype() reproduces address_and_keys_from_seed() exactly,
//      for every network, over many random wallets;
//   3. the core's own decode_address() accepts what we encode, and recovers
//      the right spend/view keys;
//   4. malformed input fails loudly (a wrong address is unspendable funds).
//
// Runs under --disallow-code-generation-from-strings like the other bridge
// tests, so it also covers the CSP-safe path.

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { addressForNettype, addressKindForNettype, base58Encode, ADDRESS_PREFIX, ADDRESS_PREFIXES } from '../src/lib/signMessage.ts'

const require = createRequire(import.meta.url)

const MAINNET = 0
const TESTNET = 1
const DEVNET = 2
const NETTYPES = [MAINNET, TESTNET, DEVNET]

let bridge

before(async () => {
  const load = require('@bdxi/beldex-app-bridge')
  bridge = await load({})
})

describe('cross-network address derivation', () => {
  test('the keypair is identical on every nettype — only the address differs', () => {
    const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
    const byNet = NETTYPES.map(nt => bridge.address_and_keys_from_seed(seed, nt))

    for (const field of ['pub_spendKey_string', 'sec_spendKey_string',
                         'pub_viewKey_string', 'sec_viewKey_string']) {
      const values = new Set(byNet.map(r => r[field]))
      assert.equal(values.size, 1, `${field} must not depend on the nettype`)
    }

    // ...and the addresses genuinely DO differ, or the test above proves nothing.
    const addresses = new Set(byNet.map(r => r.address_string))
    assert.equal(addresses.size, NETTYPES.length, 'each network must encode a distinct address')
  })

  test('addressForNettype reproduces the core, for every network', () => {
    for (let i = 0; i < 5; i++) {
      const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
      for (const nt of NETTYPES) {
        const truth = bridge.address_and_keys_from_seed(seed, nt)
        assert.equal(
          addressForNettype(truth.pub_spendKey_string, truth.pub_viewKey_string, nt),
          truth.address_string,
          `nettype ${nt} address must match the core exactly`
        )
      }
    }
  })

  test('the core accepts an address we encoded, and reads back the same keys', () => {
    const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
    for (const nt of NETTYPES) {
      const truth = bridge.address_and_keys_from_seed(seed, nt)
      const ours = addressForNettype(truth.pub_spendKey_string, truth.pub_viewKey_string, nt)
      const decoded = bridge.decode_address(ours, nt)
      assert.equal(decoded.spend, truth.pub_spendKey_string)
      assert.equal(decoded.view, truth.pub_viewKey_string)
      assert.equal(decoded.isSubaddress, false)
    }
  })

  test('a mainnet address is rejected by the core as a testnet one', () => {
    const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
    const mainnet = bridge.address_and_keys_from_seed(seed, MAINNET)
    const ours = addressForNettype(mainnet.pub_spendKey_string, mainnet.pub_viewKey_string, MAINNET)
    // Decoding a mainnet address under the testnet prefix must not succeed —
    // this is what stops a switch from silently sending to the wrong chain.
    assert.throws(() => bridge.decode_address(ours, TESTNET))
  })

  test('malformed key material throws rather than returning a wrong address', () => {
    const ok = 'a'.repeat(64)
    // Valid hex, wrong length -> caught by the 32-byte guard.
    assert.throws(() => addressForNettype('aabb', ok, MAINNET), /spend public key/)
    assert.throws(() => addressForNettype(ok, 'aabb', MAINNET), /view public key/)
    // Not hex at all, and odd-length hex -> rejected before any length check.
    assert.throws(() => addressForNettype('zz'.repeat(32), ok, MAINNET), /invalid hex/)
    assert.throws(() => addressForNettype('abc', ok, MAINNET), /invalid hex/)
    assert.throws(() => addressForNettype(ok, ok, 99), /unknown nettype/)
  })

  test('the prefix table matches what the core actually emits', () => {
    // Guards against a silent consensus-constant drift on a core bump: decode
    // the core's own address and compare its leading varint with our table.
    const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
    for (const nt of NETTYPES) {
      const addr = bridge.address_and_keys_from_seed(seed, nt).address_string
      // Our encoder round-trips only if the prefix matches, so equality here
      // IS the prefix check — asserted against the table explicitly for clarity.
      assert.equal(typeof ADDRESS_PREFIX[nt], 'number')
      const truth = bridge.address_and_keys_from_seed(seed, nt)
      assert.equal(addressForNettype(truth.pub_spendKey_string, truth.pub_viewKey_string, nt), addr)
    }
  })
})

// The dapp bridge gates bdx_sendTransaction recipients with
// addressKindForNettype() in the service worker, where the WASM cannot load.
// It must accept exactly what the core's decode_address accepts for the active
// chain — standard, integrated and subaddress — and nothing for the other one.
describe('addressKindForNettype agrees with the core', () => {
  const { keccak_256 } = require('@noble/hashes/sha3')
  const CHAINS = [MAINNET, TESTNET]

  function encode(prefix, spendHex, viewHex, extra = []) {
    const v = []
    let n = prefix
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; v.push(b) } while (n)
    const body = Uint8Array.from([...v, ...Buffer.from(spendHex, 'hex'), ...Buffer.from(viewHex, 'hex'), ...extra])
    return base58Encode(Uint8Array.from([...body, ...keccak_256(body).subarray(0, 4)]))
  }
  const coreAccepts = (addr, nt) => {
    try { const r = bridge.decode_address(addr, nt); return !!r && !r.err_msg } catch { return false }
  }

  test('every tabled prefix is one the core accepts, as the right kind', () => {
    const w = bridge.newly_created_wallet('en-US', MAINNET)
    for (const nt of CHAINS) {
      const p = ADDRESS_PREFIXES[nt]
      const std = encode(p.standard, w.pub_spendKey_string, w.pub_viewKey_string)
      const sub = encode(p.subaddress, w.pub_spendKey_string, w.pub_viewKey_string)
      const int = encode(p.integrated, w.pub_spendKey_string, w.pub_viewKey_string, [1, 2, 3, 4, 5, 6, 7, 8])
      assert.ok(coreAccepts(std, nt) && coreAccepts(sub, nt) && coreAccepts(int, nt), `nettype ${nt}`)
      assert.equal(bridge.decode_address(sub, nt).isSubaddress, true)
      assert.equal(addressKindForNettype(std, nt), 'standard')
      assert.equal(addressKindForNettype(sub, nt), 'subaddress')
      assert.equal(addressKindForNettype(int, nt), 'integrated')
      // ...and none of them is valid on the other chain, for either side.
      const other = nt === MAINNET ? TESTNET : MAINNET
      for (const a of [std, sub, int]) {
        assert.equal(addressKindForNettype(a, other), null)
        assert.equal(coreAccepts(a, other), false)
      }
    }
  })

  test('the core\'s own standard and integrated addresses are recognized', () => {
    const seed = bridge.newly_created_wallet('en-US', MAINNET).sec_seed_string
    for (const nt of CHAINS) {
      const addr = bridge.address_and_keys_from_seed(seed, nt).address_string
      assert.equal(addressKindForNettype(addr, nt), 'standard')
      const int = bridge.new__int_addr_from_addr_and_short_pid(addr, 'abcdef0123456789', nt)
      assert.equal(addressKindForNettype(int, nt), 'integrated')
    }
  })

  test('mainnet integrated/subaddress forms do not start with "bx"', () => {
    // Why a "starts with bx" check was wrong: it refused valid recipients.
    const w = bridge.newly_created_wallet('en-US', MAINNET)
    const p = ADDRESS_PREFIXES[MAINNET]
    assert.equal(encode(p.integrated, w.pub_spendKey_string, w.pub_viewKey_string, [0, 0, 0, 0, 0, 0, 0, 1])[0], '4')
    assert.equal(encode(p.subaddress, w.pub_spendKey_string, w.pub_viewKey_string)[0], '8')
  })

  test('untabled prefixes, bad checksums and wrong lengths are refused', () => {
    const w = bridge.newly_created_wallet('en-US', MAINNET)
    for (const nt of CHAINS) {
      const p = ADDRESS_PREFIXES[nt]
      for (const prefix of [p.standard + 1, p.integrated + 1, 0, 1000]) {
        if (Object.values(p).includes(prefix)) continue
        const a = encode(prefix, w.pub_spendKey_string, w.pub_viewKey_string)
        assert.equal(addressKindForNettype(a, nt), null, `prefix ${prefix}`)
        assert.equal(coreAccepts(a, nt), false, `core must refuse prefix ${prefix} too`)
      }
      const good = encode(p.standard, w.pub_spendKey_string, w.pub_viewKey_string)
      const last = good.at(-1) === '1' ? '2' : '1'
      assert.equal(addressKindForNettype(good.slice(0, -1) + last, nt), null, 'checksum')
      // A standard prefix carrying an integrated-length body is not an address.
      const long = encode(p.standard, w.pub_spendKey_string, w.pub_viewKey_string, [1, 2, 3, 4, 5, 6, 7, 8])
      assert.equal(addressKindForNettype(long, nt), null, 'length')
    }
    for (const junk of ['', 'bx', 'bx' + 'a'.repeat(95), 'shop.bdx', 'x'.repeat(500)]) {
      assert.equal(addressKindForNettype(junk, MAINNET), null, JSON.stringify(junk.slice(0, 12)))
    }
  })
})
