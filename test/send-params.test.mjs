// Coverage for validateSendParams (src/background/dapp.ts), added with HF22
// token sends: the tokenId field must be bounded, sweep+token refused, and the
// pre-existing BDX rules preserved. Extraction pattern as sign-params.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/background/dapp.ts'), 'utf8')

const start = src.indexOf('const U64_MAX')
const end = src.indexOf('/** Longest message a site may ask the user to sign.')
assert.ok(start !== -1 && end > start, 'send-validation block markers drifted in dapp.ts')
const block = 'export ' + src.slice(start, end)

const ts = await import('typescript').then(m => m.default ?? m)
const js = ts.transpileModule(block, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText
const { validateSendParams } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

const ADDR = 'bx' + 'V'.repeat(95)

test('plain BDX sends still validate (regression)', () => {
  const r = validateSendParams({ to: ADDR, amount: '1000000000', priority: 5 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.send, { to: ADDR, amount: '1000000000', priority: 5, sweep: false })
})

test('token send: tokenId accepted, bounded, and carried through', () => {
  const tokenId = 'a'.repeat(64)
  const r = validateSendParams({ to: ADDR, amount: '5', tokenId })
  assert.equal(r.ok, true)
  assert.equal(r.send.tokenId, tokenId)
})

test('token send: malformed / oversize ids rejected', () => {
  for (const tokenId of ['', 'has space', 'semi;colon', 'a'.repeat(65), 42]) {
    const r = validateSendParams({ to: ADDR, amount: '5', tokenId })
    assert.equal(r.ok, false, JSON.stringify(tokenId))
    assert.match(r.error, /tokenId/)
  }
})

test('token send: sweep is refused', () => {
  const r = validateSendParams({ to: ADDR, sweep: true, tokenId: 'deadbeef01' })
  assert.equal(r.ok, false)
  assert.match(r.error, /sweep.*token/i)
})
