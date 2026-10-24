// HF22 token support on the dapp bridge (PROTOCOL.md §4.4a/§4.4b/§4.5):
// bdx_getTokenInfo, bdx_getTokenBalance, and bdx_sendTransaction with a
// tokenId — plus the network-aware recipient check every send now goes
// through. Drives the BUILT background bundle through a fake chrome API and a
// scripted LWS. Verifies:
//   - token reads are grant-gated, validate tokenId before any fetch, and map
//     the LWS shapes to the SDK's (name/decimalPoint/…, integer strings);
//   - an unsupporting server reads -32603, a 400 (unknown id) reads -32602;
//   - token balances apply the panel-published key-image correction, only for
//     the same address;
//   - a token send carries tokenId into the approval (never dropped), and
//     token sweeps / bad ids are refused;
//   - recipients must belong to the ACTIVE chain: testnet addresses work on
//     testnet, are refused on mainnet, and mainnet integrated "4…" addresses
//     are accepted.
//
//   npm run build   # produces the bundle this test loads

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { addressForNettype, base58Encode, ADDRESS_PREFIXES } from '../src/lib/signMessage.ts'

const require = createRequire(import.meta.url)
const { keccak_256 } = require('@noble/hashes/sha3')

const here = dirname(fileURLToPath(import.meta.url))
const CANDIDATES = ['dist/background.js', 'dist-testnet/background.js',
                    'firefox/background.js', 'firefox-testnet/background.js']
const bundle = CANDIDATES.map(p => join(here, '..', p)).find(existsSync)

const SPEND = '1'.repeat(64)
const VIEW = '2'.repeat(64)
const MAIN_TO = addressForNettype(SPEND, VIEW, 0)
const TEST_TO = addressForNettype(SPEND, VIEW, 1)
const MAIN_INTEGRATED = (() => {
  const body = Uint8Array.from([ADDRESS_PREFIXES[0].integrated, ...Buffer.from(SPEND, 'hex'),
    ...Buffer.from(VIEW, 'hex'), 1, 2, 3, 4, 5, 6, 7, 8])
  return base58Encode(Uint8Array.from([...body, ...keccak_256(body).subarray(0, 4)]))
})()
const TOKEN = 'ab'.repeat(32)

const SECRETS = {
  address: MAIN_TO, pubSpendKey: SPEND, secSpendKey: 'b'.repeat(64),
  pubViewKey: VIEW, secViewKey: 'd'.repeat(64), mnemonic: 'x', seed: 'y'
}

/** Results come from the bundle's vm realm; compare plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))

function memStore(map) {
  return {
    get: async k => {
      const keys = k == null ? [...map.keys()] : Array.isArray(k) ? k : [k]
      const o = {}
      for (const key of keys) if (map.has(key)) o[key] = map.get(key)
      return o
    },
    set: async o => { for (const [k, v] of Object.entries(o)) map.set(k, v) },
    remove: async k => { for (const key of [].concat(k)) map.delete(key) },
    setAccessLevel: async () => {}
  }
}

describe('dapp HF22 token support', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, sentToPage, connectListeners, callBg
  /** endpoint -> (body) => { status, json } ; requests recorded in `lwsCalls` */
  let lwsRoutes = {}
  const lwsCalls = []

  before(() => {
    local = new Map(); session = new Map(); sentToPage = []
    const msgListeners = []
    connectListeners = []
    callBg = req => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
    const chrome = {
      runtime: {
        id: 'ext-id',
        onMessage: { addListener: f => msgListeners.push(f) },
        onConnect: { addListener: f => connectListeners.push(f) },
        onInstalled: { addListener: () => {} },
        getManifest: () => ({ version: '0.0.0' }),
        getURL: p => 'chrome-extension://ext-id/' + p,
        sendMessage: async () => {}, getContexts: async () => []
      },
      storage: { local: memStore(local), session: memStore(session) },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: async () => {} },
      action: { onClicked: { addListener: () => {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      windows: {
        onRemoved: { addListener: () => {} },
        getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }),
        create: async () => ({ id: 99 }), remove: async () => {}
      },
      tabs: { query: async () => [{ id: 1 }] },
      notifications: { create: () => {} }
    }
    const fetch = async (url, init) => {
      const endpoint = new URL(url).pathname
      const body = init?.body ? JSON.parse(init.body) : undefined
      lwsCalls.push({ endpoint, body })
      const route = lwsRoutes[endpoint]
      const { status, json } = route ? route(body) : { status: 404, json: {} }
      return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => null },
        text: async () => JSON.stringify(json),
        json: async () => json
      }
    }
    const unrefTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t?.unref?.(); return t }
    const sandbox = {
      chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder, AbortController,
      setTimeout: unrefTimeout, clearTimeout, setInterval, clearInterval, fetch, URL
    }
    sandbox.self = sandbox; sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)
  })

  // Each test talks from its own origin: reads are rate-limited per origin.
  // A send left pending by an earlier test still holds the worker's
  // single-flight slot, so each page starts by rejecting those.
  let n = 0
  async function page({ network = 'mainnet', unlocked = true, granted = true } = {}) {
    for (const reqId of Object.keys(session.get('dapp_pending') ?? {})) {
      await callBg({ type: 'DAPP_REJECT', reqId })
    }
    const origin = `https://shop${++n}.example`
    local.clear(); session.clear(); sentToPage.length = 0; lwsCalls.length = 0; lwsRoutes = {}
    local.set('wallets', { w1: { name: 'W1', address: MAIN_TO, addresses: { mainnet: MAIN_TO, testnet: TEST_TO }, networks: ['mainnet', 'testnet'] } })
    local.set('active_wallet_id', 'w1')
    local.set('active_network', network)
    if (granted) local.set('dapp_origins', { [origin]: { walletId: 'w1', grantedAt: Date.now() } })
    if (unlocked) {
      session.set('session_secrets', {
        walletId: 'w1', generation: 'gen-1',
        secrets: { ...SECRETS, address: network === 'testnet' ? TEST_TO : MAIN_TO }
      })
    }
    const listeners = []
    const port = {
      name: 'bdx-dapp',
      sender: { origin, tab: { id: 1 }, url: origin + '/' },
      onMessage: { addListener: f => listeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m), disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    let id = 0
    const call = async (method, params) => {
      const reqId = `pg-${++id}`
      listeners.forEach(f => f({ id: reqId, method, ...(params ? { params } : {}) }, port))
      await new Promise(r => setTimeout(r, 120))
      return sentToPage.find(m => m.id === reqId)
    }
    const pending = () => Object.values(session.get('dapp_pending') ?? {})
    return { origin, call, pending }
  }

  const descriptor = {
    token_id: TOKEN, ticker: 'MOCK', full_name: 'Mock Token', owner: 'o'.repeat(64),
    meta_info: 'm', current_supply: '1000000000', total_max_supply: '2000000000', decimal_point: 6
  }
  const balances = (tokens = [{
    token_id: TOKEN, status: 'confirmed', total_received: '5000000', total_sent: '2000000',
    locked_funds: '1000000', unlocked_balance: '2000000', ticker: 'MOCK', decimal_point: 6
  }]) => ({ status: 200, json: { tokens, scanned_height: 4242, blockchain_height: 4250 } })

  // ---- bdx_getTokenInfo ------------------------------------------------------

  test('getTokenInfo needs a grant and asks the LWS nothing without one', async () => {
    const { call } = await page({ granted: false })
    lwsRoutes['/get_token_info'] = () => ({ status: 200, json: descriptor })
    const r = await call('bdx_getTokenInfo', { tokenId: TOKEN })
    assert.equal(r?.error?.code, 4100)
    assert.equal(lwsCalls.length, 0)
  })

  test('getTokenInfo maps the descriptor to the SDK shape', async () => {
    const { call } = await page()
    lwsRoutes['/get_token_info'] = () => ({ status: 200, json: descriptor })
    const r = await call('bdx_getTokenInfo', { tokenId: TOKEN })
    assert.deepEqual(plain(r?.result), {
      tokenId: TOKEN, ticker: 'MOCK', name: 'Mock Token', owner: 'o'.repeat(64), metaInfo: 'm',
      currentSupply: '1000000000', totalMaxSupply: '2000000000', decimalPoint: 6
    })
    assert.deepEqual(plain(lwsCalls[0]), { endpoint: '/get_token_info', body: { token_id: TOKEN } })
  })

  test('getTokenInfo works while locked (public chain data)', async () => {
    const { call } = await page({ unlocked: false })
    lwsRoutes['/get_token_info'] = () => ({ status: 200, json: descriptor })
    const r = await call('bdx_getTokenInfo', { tokenId: TOKEN })
    assert.equal(r?.result?.ticker, 'MOCK')
  })

  test('a malformed tokenId is refused before any LWS call', async () => {
    const { call } = await page()
    for (const tokenId of ['has space', 'ab-cd', '']) {
      const r = await call('bdx_getTokenInfo', { tokenId })
      assert.equal(r?.error?.code, -32602, JSON.stringify(tokenId))
    }
    assert.equal((await call('bdx_getTokenBalance', {}))?.error?.code, -32602, 'missing tokenId')
    assert.equal(lwsCalls.length, 0)
  })

  test('an unsupporting server reads -32603; an unknown id reads -32602', async () => {
    const { call } = await page()
    // no route -> 404
    const unsupported = await call('bdx_getTokenInfo', { tokenId: TOKEN })
    assert.equal(unsupported?.error?.code, -32603)
    assert.match(unsupported.error.message, /token lookup unavailable/)
    lwsRoutes['/get_token_info'] = () => ({ status: 400, json: { Error: 'token not found: internal detail' } })
    const unknown = await call('bdx_getTokenInfo', { tokenId: TOKEN })
    assert.equal(unknown?.error?.code, -32602)
    assert.doesNotMatch(unknown.error.message, /internal detail/, 'server text is not echoed')
    // The live testnet LWS answers an unknown id with a bare 400 — still an
    // answer about the token, not an unsupporting server.
    lwsRoutes['/get_token_info'] = () => ({ status: 400, json: '' })
    assert.equal((await call('bdx_getTokenInfo', { tokenId: TOKEN }))?.error?.code, -32602)
  })

  test('a descriptor with unusable decimals is refused, not passed on', async () => {
    const { call } = await page()
    lwsRoutes['/get_token_info'] = () => ({ status: 200, json: { ...descriptor, decimal_point: 40 } })
    assert.equal((await call('bdx_getTokenInfo', { tokenId: TOKEN }))?.error?.code, -32603)
  })

  // ---- bdx_getTokenBalance ---------------------------------------------------

  test('getTokenBalance needs an unlocked session', async () => {
    const { call } = await page({ unlocked: false })
    lwsRoutes['/get_token_balances'] = () => balances()
    assert.equal((await call('bdx_getTokenBalance', { tokenId: TOKEN }))?.error?.code, 4900)
  })

  test('getTokenBalance serves raw figures as integer strings', async () => {
    const { call } = await page()
    lwsRoutes['/get_token_balances'] = () => balances()
    const r = await call('bdx_getTokenBalance', { tokenId: TOKEN })
    assert.deepEqual(plain(r?.result), {
      tokenId: TOKEN, status: 'confirmed', total: '3000000', unlocked: '2000000', locked: '1000000',
      height: 4242, ticker: 'MOCK', decimalPoint: 6
    })
    assert.equal(lwsCalls[0].endpoint, '/get_token_balances')
    assert.deepEqual(plain(lwsCalls[0].body), { address: MAIN_TO, view_key: SECRETS.secViewKey, token_ids: [TOKEN] })
  })

  test('getTokenBalance applies the panel correction for the same address only', async () => {
    const { call } = await page()
    lwsRoutes['/get_token_balances'] = () => balances()
    // Panel saw raw 2_500_000 but verified 3_000_000: a 500_000 decoy overcount.
    session.set('corrected_token_balances', {
      address: MAIN_TO, at: Date.now(),
      tokens: { [TOKEN]: { raw_total: '2500000', verified_total: '3000000' } }
    })
    const r = await call('bdx_getTokenBalance', { tokenId: TOKEN })
    assert.equal(r?.result?.total, '3500000')
    assert.equal(r?.result?.unlocked, '2500000')

    session.set('corrected_token_balances', {
      address: TEST_TO, at: Date.now(),
      tokens: { [TOKEN]: { raw_total: '0', verified_total: '9999999' } }
    })
    const other = await call('bdx_getTokenBalance', { tokenId: TOKEN })
    assert.equal(other?.result?.total, '3000000', 'another address\'s correction is ignored')
  })

  test('a token the server did not report reads status unknown, not a zero claim', async () => {
    const { call } = await page()
    lwsRoutes['/get_token_balances'] = () => balances([])
    const r = await call('bdx_getTokenBalance', { tokenId: TOKEN })
    assert.equal(r?.result?.status, 'unknown')
    assert.equal(r?.result?.ticker, undefined)
  })

  // ---- bdx_sendTransaction with tokenId ----------------------------------------

  test('a token send carries tokenId into the approval', async () => {
    const { call, pending } = await page()
    call('bdx_sendTransaction', { to: MAIN_TO, amount: '1250000', tokenId: TOKEN })
    await new Promise(r => setTimeout(r, 150))
    const [p] = pending()
    assert.equal(p?.method, 'bdx_sendTransaction')
    assert.deepEqual(plain(p.params), { to: MAIN_TO, priority: 1, sweep: false, amount: '1250000', tokenId: TOKEN })
  })

  test('token sweeps and malformed token ids are refused', async () => {
    const { call, pending } = await page()
    assert.equal((await call('bdx_sendTransaction', { to: MAIN_TO, sweep: true, tokenId: TOKEN }))?.error?.code, -32602)
    assert.equal((await call('bdx_sendTransaction', { to: MAIN_TO, amount: '1', tokenId: 'not hex!' }))?.error?.code, -32602)
    assert.equal(pending().length, 0)
  })

  // ---- recipients belong to the active chain ----------------------------------

  test('mainnet: testnet recipients refused, integrated "4…" accepted', async () => {
    const a = await page()
    const r = await a.call('bdx_sendTransaction', { to: TEST_TO, amount: '1' })
    assert.equal(r?.error?.code, -32602)
    assert.match(r.error.message, /not a mainnet address/)

    assert.ok(MAIN_INTEGRATED.startsWith('4'))
    const b = await page()
    b.call('bdx_sendTransaction', { to: MAIN_INTEGRATED, amount: '1' })
    await new Promise(r => setTimeout(r, 150))
    assert.equal(b.pending()[0]?.params?.to, MAIN_INTEGRATED)
  })

  test('testnet: testnet recipients accepted, mainnet refused', async () => {
    const a = await page({ network: 'testnet' })
    const r = await a.call('bdx_sendTransaction', { to: MAIN_TO, amount: '1' })
    assert.equal(r?.error?.code, -32602)

    const b = await page({ network: 'testnet' })
    b.call('bdx_sendTransaction', { to: TEST_TO, amount: '1', tokenId: TOKEN })
    await new Promise(r => setTimeout(r, 150))
    assert.equal(b.pending()[0]?.params?.to, TEST_TO)
    assert.equal(b.pending()[0]?.params?.tokenId, TOKEN)
  })
})
