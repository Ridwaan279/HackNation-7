import { useEffect, useRef, useState } from 'react'
import type { Rect } from '@shared/contracts'

export function BlurEditor({ src, disabled, onApply }: { src: string; disabled: boolean; onApply: (data: string, region: Rect) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<[number, number]>([1, 1])
  const [start, setStart] = useState<[number, number] | null>(null)
  const [region, setRegion] = useState<Rect | null>(null)
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let canceled = false
    const image = new Image()
    setRegion(null); setLoaded(false); setEditing(false)
    image.onload = () => {
      if (canceled || !canvas.current) return
      canvas.current.width = image.naturalWidth; canvas.current.height = image.naturalHeight
      canvas.current.getContext('2d')!.drawImage(image, 0, 0)
      setSize([image.naturalWidth, image.naturalHeight]); setLoaded(true)
    }
    image.src = src
    return () => { canceled = true }
  }, [src])
  function point(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const bounds = event.currentTarget.getBoundingClientRect()
    return [Math.max(0, Math.min(size[0], (event.clientX - bounds.left) * size[0] / bounds.width)), Math.max(0, Math.min(size[1], (event.clientY - bounds.top) * size[1] / bounds.height))]
  }
  function apply() {
    if (!canvas.current || !region || disabled) return
    const [left, top, right, bottom] = region.map(Math.round) as Rect
    if (right - left < 2 || bottom - top < 2) return
    const output = document.createElement('canvas')
    output.width = size[0]; output.height = size[1]
    const context = output.getContext('2d')!
    context.drawImage(canvas.current, 0, 0)
    // Flatten an opaque mask into the pixels. Text cannot be recovered by removing a CSS layer.
    context.fillStyle = '#344b43'; context.fillRect(left, top, right - left, bottom - top)
    onApply(output.toDataURL('image/png'), [left, top, right, bottom])
  }
  return <div className="guide-image-editor">
    <div className="guide-image-actions"><span>{editing ? 'Drag over the area to conceal.' : 'Captured screen'}</span><button type="button" disabled={disabled || !loaded} onClick={() => { setEditing(!editing); setRegion(null) }}>{editing ? 'Cancel redaction' : 'Blur / redact area'}</button></div>
    <div className={`guide-canvas-wrap ${editing ? 'is-selecting' : ''}`}>
      <canvas ref={canvas} aria-label="Step screenshot. Use the redaction controls to conceal an area." onPointerDown={(event) => { if (!editing || disabled) return; event.currentTarget.setPointerCapture(event.pointerId); const at = point(event); setStart(at); setRegion([at[0], at[1], at[0], at[1]]) }} onPointerMove={(event) => { if (!start) return; const at = point(event); setRegion([Math.min(start[0], at[0]), Math.min(start[1], at[1]), Math.max(start[0], at[0]), Math.max(start[1], at[1])]) }} onPointerUp={() => setStart(null)} onPointerCancel={() => { setStart(null); setRegion(null) }}/>
      {region && <div className="guide-selection" style={{ left: `${region[0] / size[0] * 100}%`, top: `${region[1] / size[1] * 100}%`, width: `${(region[2] - region[0]) / size[0] * 100}%`, height: `${(region[3] - region[1]) / size[1] * 100}%` }}/>}
    </div>
    {editing && <div className="guide-redaction-controls"><p>The selected area is replaced with a solid mask in the saved image. This cannot be undone.</p><div className="guide-coordinate-grid">{['Left', 'Top', 'Right', 'Bottom'].map((label, index) => <label key={label}>{label}<input type="number" min="0" max={size[index % 2]} value={Math.round(region?.[index] ?? 0)} onChange={(event) => setRegion((previous) => { const next: Rect = previous ? [...previous] : [0, 0, 0, 0]; next[index] = Math.max(0, Math.min(size[index % 2], Number(event.target.value))); return next })}/></label>)}</div><button className="guide-primary" disabled={disabled || !region || region[2] <= region[0] || region[3] <= region[1]} onClick={apply}>Save redacted image</button></div>}
  </div>
}
