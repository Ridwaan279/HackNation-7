import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContextEvent } from '@shared/contracts'
import { CaptureSession } from '../../app/src/main/services/steps'
import { init as initAssistant } from '../../app/src/main/services/assistant'
import { getStore } from '../../app/src/main/services/store'
import { harness } from './harness'

test('Ask AI uses recorded task context and masks the question before local guidance', async () => {
  const h = await harness()
  const capture = new CaptureSession('ask-test', 'teach', 'Approve an equipment invoice')
  const context: ContextEvent = { type: 'context', t: 1, app: 'msedge.exe', key: 'browser:erp.example', title: 'ERP', blocked: false, hwnd: 1, monitor: 1, window_rect: [0, 0, 1000, 900], dpi_awareness: 'per_monitor', window_dpi: 96, monitor_scale: 1, capture: 'uia' }
  capture.push(context)
  capture.push({ type: 'click', t: 2, x: 20, y: 20, button: 'left', target: { name: 'Approve invoice', automation_id: 'approve', control_type: 'ButtonControl', rect: [0, 0, 100, 40], rect_trusted: true }, shot: null, shot_meta: null })
  capture.guide.recording = false
  await getStore(h.ctx).write(['guides', `${capture.guide.id}.json`], capture.guide)
  initAssistant(h.ctx)
  const reply = await h.invoke<{ answer: string; source: string; guide?: string }>('assistant:ask', { question: 'How do I approve an equipment invoice TEST_SECRET?' })
  assert.equal(reply.source, 'local')
  assert.equal(reply.guide, 'Approve an equipment invoice')
  assert.match(reply.answer, /Click Approve invoice/)
  assert.doesNotMatch(reply.answer, /TEST_SECRET/)
})
