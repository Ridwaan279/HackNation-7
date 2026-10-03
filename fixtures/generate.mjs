import { readFile, writeFile } from 'node:fs/promises'
import { jpegSize } from './image-size.mjs'

// Unix seconds, matching the Python observer. Pauses are deliberately retained.
const start = Date.parse('2026-10-03T09:00:00Z') / 1000
const key = 'browser:127.0.0.1'
const meta = { origin_px: [0, 0], size_px: [1280, 1000], scale: 1, monitor: 1 }
const context = (t, appKey = key, app = 'msedge.exe', title = 'MiniERP | Accounts payable') => ({ type: 'context', t: start + t, app, key: appKey, title, blocked: false, hwnd: 100, monitor: 1, window_rect: [0, 0, 1280, 1000], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' })
const text = (t, delta, appKey = key, title = 'MiniERP | Accounts payable') => ({ type: 'text', t: start + t, key: appKey, title, delta })
const click = (t, name, control = 'ButtonControl') => ({ type: 'click', t: start + t, x: 600, y: 400, button: 'left', target: { name, control_type: control, automation_id: name.toLowerCase().replaceAll(' ', '-'), rect: [500, 380, 800, 420], rect_trusted: true }, shot: null, shot_meta: null })
const commit = (t, field, old, value, masked = false) => ({ type: 'commit', t: start + t, field, old, new: value, rect: [500, 380, 800, 420], masked, source: 'uia' })
const activity = (t, kind = 'typing') => ({ type: 'activity', t: start + t, kind })
const keyEvent = (t, key = 'tab') => ({ type: 'key', t: start + t, key })
const shot = (t, name) => ({ type: 'shot', t: start + t, key, path: `fixtures/shots/${name}.jpg`, meta, reason: 'heartbeat', ephemeral: false })

const expert = [
  context(0), text(1, ['Invoice INV-4471', 'Supplier: Nordwerk Equipment', 'Amount: EUR 6400.00', 'Description: Production equipment: milling unit', 'Cost center: 6100']),
  click(4, 'INV-4471'), click(8, 'Cost center', 'EditControl'), activity(9), commit(11, 'Cost center', '6100', '0400'), keyEvent(12),
  click(17, 'Asset number', 'EditControl'), activity(18), commit(20, 'Asset number', '', 'AST-6400'),
  commit(22, 'Notes', '', 'Test payment: IBAN [IBAN ••••3000]; card [CARD ••••4242].', true), shot(24, 'expert-capex'),
  click(35, 'Post invoice'), click(45, 'Confirm posting'),
  click(62, 'INV-4472'), text(63, ['Invoice INV-4472', 'Supplier: Müller GmbH', 'Amount: EUR 1850.00', 'Invoice date: 2026-12-15', 'Description: December maintenance service']),
  click(73, 'Notes', 'EditControl'), activity(74), commit(78, 'Notes', 'December service period.', 'Possible duplicate December charge. Check supplier reference.'), click(85, 'Hold invoice'), shot(87, 'expert-hold'),
  click(116, 'INV-4473'), text(117, ['Invoice INV-4473', 'Supplier: Morava Components', 'Amount: EUR 2300.00', 'Subsidiary: Czech Republic']),
  activity(125, 'scroll'), click(134, 'Send for approval'), shot(136, 'expert-approval'), keyEvent(177, 'esc'),
]
const newhire = [
  context(0), text(1, ['Invoice INV-5801', 'Supplier: Elbe Industrial', 'Amount: EUR 7200.00', 'Description: Production equipment: inspection station', 'Cost center: 6100', 'Asset number: empty']),
  click(4, 'INV-5801'), click(8, 'Cost center', 'EditControl'), activity(9), commit(11, 'Cost center', '', '6100'), shot(13, 'newhire-mistake'),
  click(18, 'Post invoice'), click(26, 'Back to invoice'),
  click(40, 'Cost center', 'EditControl'), activity(41), commit(43, 'Cost center', '6100', '0400'), keyEvent(44), commit(49, 'Asset number', '', 'AST-7200'),
  click(58, 'Post invoice'), click(67, 'Confirm posting'),
  click(82, 'INV-5802'), text(83, ['Invoice INV-5802', 'Supplier: Bürobedarf West', 'Amount: EUR 240.00', 'Description: Office stationery']),
  commit(91, 'Cost center', '', '6100'), click(101, 'Post invoice'), click(111, 'Confirm posting'),
]
const ambient = []
for (const [offset, appKey, app, title, lines] of [
  [0, key, 'msedge.exe', 'MiniERP | Accounts payable', ['Supplier invoice queue', 'Cost center 0400', 'Equipment invoice review']],
  [780, 'EXCEL.EXE', 'EXCEL.EXE', 'Month-end accruals - Excel', ['Accrual reconciliation', 'Supplier totals', 'December close']],
  [1560, 'browser:docs.example.test', 'msedge.exe', 'AP procedures', ['Second approval: Czech subsidiary', 'Equipment threshold EUR 5000', 'Duplicate supplier references']],
]) {
  ambient.push(context(offset, appKey, app, title))
  for (let index = 0; index < 43; index++) {
    ambient.push(activity(offset + index * 15 + 1, 'scroll'))
    ambient.push(text(offset + index * 15 + 2, [lines[index % lines.length], `Review batch ${index + 1}`], appKey, title))
  }
}
ambient.push({ type: 'blocked', t: start + 2250, reason: 'password_manager' })
for (const [name, events] of Object.entries({ 'expert-session': expert, 'newhire-session': newhire, 'ambient-day': ambient })) {
  for (const event of events) {
    if (event.type === 'shot') {
      const bytes = await readFile(new URL(`shots/${event.path.split('/').at(-1)}`, import.meta.url))
      event.meta = { ...meta, size_px: jpegSize(bytes) }
    }
  }
  await writeFile(new URL(`${name}.jsonl`, import.meta.url), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  console.log(`${name}: ${events.length} events`)
}
