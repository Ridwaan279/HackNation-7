// Synthetic demo records. The payment details below are public masking test vectors.
export const invoiceSets = {
  expert: [
    { id: 'INV-4471', supplier: 'Nordwerk Equipment', amount: '6400.00', description: 'Production equipment: milling unit', date: '2026-10-03', subsidiary: 'Germany', costCenter: '6100', assetNumber: '', bankDetails: 'DE89 3704 0044 0532 0130 00', notes: 'Test payment: IBAN DE89 3704 0044 0532 0130 00; card 4242 4242 4242 4242.', status: 'Pending' },
    { id: 'INV-4472', supplier: 'Müller GmbH', amount: '1850.00', description: 'December maintenance service', date: '2026-12-15', subsidiary: 'Germany', costCenter: '6100', assetNumber: '', bankDetails: '', notes: 'December service period. Compare supplier invoice references before posting.', status: 'Pending' },
    { id: 'INV-4473', supplier: 'Morava Components', amount: '2300.00', description: 'Replacement components', date: '2026-10-03', subsidiary: 'Czech Republic', costCenter: '6100', assetNumber: '', bankDetails: '', notes: 'Purchased by the Czech subsidiary.', status: 'Pending' },
  ],
  newhire: [
    { id: 'INV-5801', supplier: 'Elbe Industrial', amount: '7200.00', description: 'Production equipment: inspection station', date: '2026-10-04', subsidiary: 'Germany', costCenter: '6100', assetNumber: '', bankDetails: '', notes: 'New equipment delivered to the production floor.', status: 'Pending' },
    { id: 'INV-5802', supplier: 'Bürobedarf West', amount: '240.00', description: 'Office stationery', date: '2026-10-04', subsidiary: 'Germany', costCenter: '6100', assetNumber: '', bankDetails: '', notes: 'Routine office supplies.', status: 'Pending' },
  ],
}

export const freshInvoices = (mode) => structuredClone(invoiceSets[mode] ?? invoiceSets.expert)
export const money = (amount) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(amount))

// Intentionally validate form completeness only. Business decisions belong to the tutor.
export function validateInvoice(invoice) {
  if (!invoice.supplier.trim()) return 'Enter a supplier.'
  if (!Number.isFinite(Number(invoice.amount)) || Number(invoice.amount) <= 0) return 'Enter an amount greater than zero.'
  if (!invoice.costCenter.trim()) return 'Enter a cost center.'
  return null
}
