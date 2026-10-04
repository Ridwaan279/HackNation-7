// The one big choice in the app: is an expert teaching the apprentice, or a new hire learning from it?
// Used in the dashboard header (large) and the panel (compact).
import './mode-switch.css'

export type Mode = 'expert' | 'newhire'

const OPTIONS: { id: Mode; label: string; hint: string }[] = [
  { id: 'expert', label: 'Expert', hint: 'Teach Protégé' },
  { id: 'newhire', label: 'New hire', hint: 'Learn a task' },
]

export function ModeSwitch({
  mode,
  onChange,
  size = 'large',
  disabled = false,
}: {
  mode: Mode
  onChange: (mode: Mode) => void
  size?: 'large' | 'compact'
  disabled?: boolean
}) {
  return (
    <div
      className={`mode-switch ${size}`}
      role="radiogroup"
      aria-label="Who is using Protégé"
      aria-disabled={disabled || undefined}
      title={disabled ? 'Stop the current session to switch.' : undefined}
    >
      {OPTIONS.map((o) => {
        const on = o.id === mode
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={on}
            disabled={disabled && !on}
            className={on ? 'on' : ''}
            onClick={() => !on && onChange(o.id)}
          >
            <span className="mode-label">{o.label}</span>
            {size === 'large' && <span className="mode-hint">{o.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}
