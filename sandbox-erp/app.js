import { freshInvoices, money, validateInvoice } from './data.mjs'

const $ = (id) => document.getElementById(id)
let invoices = freshInvoices('expert')
let selected = 0
let pendingPost = null
const fieldNames = ['supplier', 'amount', 'description', 'date', 'subsidiary', 'costCenter', 'assetNumber', 'bankDetails', 'notes']

function readForm() {
  for (const name of fieldNames) invoices[selected][name] = $(name).value
}
function renderQueue() {
  $('count').textContent = `${invoices.filter((invoice) => invoice.status === 'Pending').length} pending`
  $('invoice-list').replaceChildren(...invoices.map((invoice, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `invoice-row ${index === selected ? 'selected' : ''}`
    button.setAttribute('aria-pressed', String(index === selected))
    button.setAttribute('aria-label', `Open ${invoice.id}, ${invoice.supplier}`)
    for (const [className, text] of [['row-id', invoice.id], ['row-supplier', invoice.supplier], ['row-amount', money(invoice.amount)], ['row-state', invoice.status]]) {
      const span = document.createElement('span')
      span.className = className
      span.textContent = text
      button.append(span)
    }
    button.addEventListener('click', () => { readForm(); selected = index; render() })
    return button
  }))
}
function render() {
  const invoice = invoices[selected]
  renderQueue()
  $('invoice-heading').textContent = invoice.id
  $('status').textContent = invoice.status
  for (const name of fieldNames) $(name).value = invoice[name]
  const posted = invoice.status === 'Posted'
  $('fields').disabled = posted
  for (const name of ['hold', 'approval', 'post']) $(name).disabled = posted
  $('feedback').textContent = ''
}
function route(status) {
  readForm()
  invoices[selected].status = status
  render()
  $('feedback').textContent = `${invoices[selected].id}: ${status.toLowerCase()}.`
}
$('dataset').addEventListener('change', () => { invoices = freshInvoices($('dataset').value); selected = 0; render() })
$('reset').addEventListener('click', () => { invoices = freshInvoices($('dataset').value); selected = 0; $('demo-password').value = ''; render() })
$('hold').addEventListener('click', () => route('On hold'))
$('approval').addEventListener('click', () => route('Awaiting approval'))
$('invoice-form').addEventListener('submit', (event) => {
  event.preventDefault()
  readForm()
  const invoice = invoices[selected]
  const error = validateInvoice(invoice)
  if (error) { $('feedback').textContent = error; return }
  pendingPost = invoice.id
  $('confirm-summary').textContent = `${invoice.id} · ${invoice.supplier} · ${money(invoice.amount)} · Cost center ${invoice.costCenter}${invoice.assetNumber ? ` · Asset ${invoice.assetNumber}` : ''}`
  $('confirm-dialog').returnValue = ''
  $('confirm-dialog').showModal()
})
$('confirm-dialog').addEventListener('close', () => {
  if ($('confirm-dialog').returnValue === 'confirm' && pendingPost === invoices[selected].id) route('Posted')
  pendingPost = null
})
render()
