import test from 'node:test'
import assert from 'node:assert/strict'
import { freshInvoices, validateInvoice } from '../data.mjs'
import { server } from '../server.mjs'

test('expert and new-hire scenarios stay separate; reset restores edits', () => {
  const expert = freshInvoices('expert')
  const novice = freshInvoices('newhire')
  assert.equal(expert.length, 3)
  assert.equal(novice.length, 2)
  assert.equal(novice[0].amount, '7200.00')
  assert.ok(!expert.some((invoice) => invoice.id === novice[0].id))
  expert[0].costCenter = '0400'
  assert.equal(freshInvoices('expert')[0].costCenter, '6100')
})
test('form rejects invalid amounts but leaves business errors for the tutor', () => {
  const invoice = freshInvoices('newhire')[0]
  assert.equal(validateInvoice(invoice), null)
  assert.ok(validateInvoice({ ...invoice, amount: 'NaN' }))
  assert.ok(validateInvoice({ ...invoice, amount: '-1' }))
})
test('server serves only explicit public files, with no write endpoint', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(`${url}/package.json`)).status, 404)
    assert.equal((await fetch(`${url}/%2e%2e/shared/contracts.ts`)).status, 404)
    assert.equal((await fetch(url, { method: 'POST' })).status, 404)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
