# MiniERP demo stage

```powershell
cd sandbox-erp
npm install
npm run dev
```

Open http://127.0.0.1:4173 in Edge. This app has no external runtime dependencies, telemetry, persistence or backend writes. All records are synthetic. `PORT` can override 4173. `npm test` checks the scenarios and local server.

## Expert demonstration

1. INV-4471: move the EUR 6,400 equipment invoice from `6100` (opex) to `0400` (capex), enter asset `AST-6400`, then Post and Confirm posting.
2. INV-4472: December invoice from Müller GmbH; add the duplicate-charge concern in Notes, then Hold invoice.
3. INV-4473: Czech subsidiary; Send for approval.

For this fictional demo, Sabine's rule is equipment over EUR 5,000 belongs in capex with an asset number. This is a demo workflow, not accounting guidance. The expert must explain the rule during Capture; the app does not feed it secretly to the tutor.

Switch **Invoice set** to **New-hire lesson** for EUR 7,200 equipment (INV-5801) and routine office supplies (INV-5802). The equipment initially has cost center `6100`. The form allows this so the tutor, once integrated, can catch it. Post opens a modal; Back to invoice and Escape cancel without posting. The confirm dialog alone does not guarantee that an asynchronous tutor will respond before a fast user confirms.

Edits survive switching invoice rows within a set. Switching sets and Reset set start fresh. Posted invoices are read-only. Hold and approval mark the invoice status but do not simulate a remote approval workflow.

The first expert invoice includes the public IBAN/card test vectors from PLAN §6.1. Expand **Privacy test field** to exercise a labelled password input. This webpage deliberately displays the synthetic values; masking is the observer's responsibility. Browser verification does not prove Windows UI Automation masking works.
