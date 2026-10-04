// Timing for the Protégé technical walkthrough (59 s). Shared by walkthrough/scene.js, audio.mjs and mix.mjs
// (run them with --film walkthrough). Times are seconds from the start of the film.

export const NAME = 'protege-walkthrough'
export const DURATION = 59
export const FPS = 30
export const OUTPUT = 59 // authored at the delivered length: no retiming

// Scene boundaries (used by the scene and for the music's composition plan).
export const SCENES = {
  gap: [0, 8.5], // one recorded hour vs a whole year of habits
  uia: [8.5, 21], // Windows UI Automation: the accessibility tree, events, privacy pipeline
  always: [21, 31.5], // always on, beside every expert
  grow: [31.5, 40], // the knowledge base keeps growing
  point: [40, 53.5], // pointing at the expert's button without taking the mouse
  end: [53.5, 59],
}

export const VOICES = {
  narrator: { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', stability: 0.55, similarity: 0.8, style: 0.3, speed: 1.08 },
  ghost: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (the voice of the Protégé website)', stability: 0.45, similarity: 0.8, style: 0.4, speed: 1.05 },
  sabine: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', stability: 0.6, similarity: 0.8, style: 0.25, speed: 1.05 },
}

// Spoken lines. `max` is the slot length; mix.mjs speeds up a clip by at most 1.2x if it overruns.
export const LINES = [
  { id: 'n1', voice: 'narrator', t: 0.6, max: 6.6, text: 'Most onboarding is one recorded hour. Every habit the expert forgets to mention is lost.' },
  { id: 'n2', voice: 'narrator', t: 8.9, max: 4.8, text: 'Protégé reads Windows accessibility, the same layer screen readers use.' },
  { id: 'n3', voice: 'narrator', t: 14.1, max: 6.7, text: 'Experts can also record a walkthrough in full detail, with screenshots, and anything sensitive is blurred.' },
  { id: 'n4', voice: 'narrator', t: 21.4, max: 6.0, text: 'It runs all day, all year, beside every expert at once, and nobody stops working.' },
  { id: 'n5', voice: 'narrator', t: 27.8, max: 3.4, text: 'It catches the habits nobody thinks to mention.' },
  { id: 'n6', voice: 'narrator', t: 31.8, max: 7.4, text: 'Every day the knowledge base grows, app by app, until it can teach anyone this exact job.' },
  { id: 'n7', voice: 'narrator', t: 40.3, max: 3.9, text: 'When a new hire gets stuck, it shows them where to go.' },
  { id: 'g1', voice: 'ghost', t: 44.3, max: 3.4, text: 'This one. The expert always matches the PO first.' },
  { id: 'n8', voice: 'narrator', t: 47.9, max: 5.0, text: 'It highlights the exact button the expert used, without ever taking the mouse.' },
  { id: 'n9', voice: 'narrator', t: 54.0, max: 4.0, text: 'Protégé. Always learning. Ready to teach anyone.' },
]

// Sound effects (ElevenLabs text to sound). `gain` is in dB; `ref` reuses another effect's file.
export const SFX = [
  { id: 'drone', t: 0.0, dur: 8, gain: -12, prompt: 'Deep dark cinematic ambient drone with a slow clock-like pulse, sub bass, airy, no melody' },
  { id: 'rec', t: 1.2, dur: 0.6, gain: -12, prompt: 'Soft digital record start beep, single tone, subtle desktop UI sound, no voice, no music' },
  { id: 'lost', t: 4.4, dur: 2.5, gain: -11, prompt: 'Soft glassy tones fading and dissolving away one by one, something being lost, delicate, cinematic' },
  { id: 'fill', t: 6.9, dur: 2, gain: -9, prompt: 'Rising airy shimmer sweep filling up, bright, building into a soft hit, cinematic' },
  { id: 'whoosh', t: 8.4, dur: 1.5, gain: -9, prompt: 'Fast smooth cinematic whoosh transition, airy, clean' },
  { id: 'scan', t: 9.4, dur: 2.5, gain: -11, prompt: 'Soft futuristic digital scan sweep, gentle glassy hum moving across, subtle UI sound' },
  { id: 'blip', t: 10.0, dur: 0.5, gain: -15, prompt: 'Tiny soft digital data blip, glassy, very short, subtle UI sound, no voice, no music' },
  { id: 'blip2', ref: 'blip', t: 10.45, gain: -15 },
  { id: 'blip3', ref: 'blip', t: 10.9, gain: -15 },
  { id: 'blip4', ref: 'blip', t: 11.35, gain: -15 },
  { id: 'blip5', ref: 'blip', t: 11.8, gain: -15 },
  { id: 'deny', t: 12.5, dur: 0.7, gain: -12, prompt: 'Soft muted denial tone, two short low notes, gentle, desktop UI sound, no voice, no music' },
  { id: 'click', t: 14.9, dur: 0.5, gain: -12, prompt: 'Single soft mouse click, crisp, close, clean, no reverb' },
  { id: 'shutter', t: 15.05, dur: 0.6, gain: -10, prompt: 'Soft modern camera shutter click, quiet and clean, screenshot capture, desktop UI sound, no voice, no music' },
  { id: 'type', t: 15.25, dur: 1.2, gain: -14, prompt: 'Quick soft keyboard typing, four keystrokes, close and clean' },
  { id: 'mask', t: 16.9, dur: 1, gain: -10, prompt: 'Soft glassy lock click with a tiny shimmer, secure, satisfying desktop UI sound' },
  { id: 'blur', ref: 'mask', t: 18.65, gain: -10 },
  { id: 'chime', t: 18.2, dur: 1.2, gain: -10, prompt: 'Soft warm two-note confirmation chime, delicate glass and felt, subtle desktop UI sound, no voice, no music' },
  { id: 'click2', ref: 'click', t: 19.4, gain: -12 },
  { id: 'shutter2', ref: 'shutter', t: 19.5, gain: -10 },
  { id: 'whoosh2', ref: 'whoosh', t: 20.8, gain: -9 },
  { id: 'stream', t: 21.6, dur: 6, gain: -15, prompt: 'Soft rhythmic digital data stream, gentle pulsing ticks flowing steadily, futuristic, subtle, no music' },
  { id: 'pop', t: 28.0, dur: 0.7, gain: -12, prompt: 'Small gentle bubble pop with a bright shimmer, subtle desktop UI sound, no voice, no music' },
  { id: 'pop2', ref: 'pop', t: 28.55, gain: -12 },
  { id: 'pop3', ref: 'pop', t: 29.1, gain: -12 },
  { id: 'pop4', ref: 'pop', t: 29.65, gain: -12 },
  { id: 'whoosh3', ref: 'whoosh', t: 31.3, gain: -9 },
  { id: 'crystal', t: 32.0, dur: 6, gain: -12, prompt: 'Crystalline glass chimes connecting one by one, a constellation growing, soft and bright, cinematic' },
  { id: 'confirm', t: 38.0, dur: 1.5, gain: -9, prompt: 'Warm rewarding success chime, soft bell and glass, uplifting, short, desktop UI' },
  { id: 'whoosh4', ref: 'whoosh', t: 39.9, gain: -9 },
  { id: 'click3', ref: 'click', t: 41.6, gain: -14 },
  { id: 'click4', ref: 'click', t: 42.9, gain: -14 },
  { id: 'fly', t: 43.6, dur: 1.4, gain: -9, prompt: 'Magical swoosh fly-by with sparkle trail, playful ghost flying past quickly' },
  { id: 'ping', t: 44.85, dur: 1.2, gain: -9, prompt: 'Bright gentle highlight ping, soft glass bell with shimmer, drawing attention, desktop UI sound, no voice, no music' },
  { id: 'blip6', ref: 'blip', t: 45.6, gain: -14 },
  { id: 'blip7', ref: 'blip', t: 46.3, gain: -14 },
  { id: 'blip8', ref: 'blip', t: 47.0, gain: -14 },
  { id: 'blip9', ref: 'blip', t: 47.7, gain: -14 },
  { id: 'click5', ref: 'click', t: 50.6, gain: -11 },
  { id: 'success', ref: 'confirm', t: 50.8, gain: -8 },
  { id: 'whoosh5', ref: 'whoosh', t: 53.3, gain: -8 },
  { id: 'finale', t: 53.8, dur: 5, gain: -5, prompt: 'Cinematic logo reveal hit, deep warm boom with a long magical sparkling tail and soft choir air' },
]

// Music: ElevenLabs Music composition plan, one section per scene.
export const MUSIC = {
  global: [
    'cinematic', 'modern ambient tech', 'warm analog synth pads', 'soft pulsing arpeggios', 'felt piano', 'airy textures',
    'focused', 'hopeful', 'instrumental',
  ],
  negative: ['vocals', 'lyrics', 'singing', 'rap', 'heavy drums', 'aggressive', 'distorted guitar', 'EDM drop'],
  sections: [
    { name: 'Gap', scene: 'gap', styles: ['sparse felt piano', 'ticking clock pulse', 'lots of space', 'quiet', 'slightly melancholic'] },
    { name: 'Accessibility', scene: 'uia', styles: ['curious precise synth arpeggio', 'soft glitchy percussion', 'technical', 'forward motion'] },
    { name: 'Always on', scene: 'always', styles: ['steady pulse', 'layered arpeggios building', 'busy but calm', 'growing energy'] },
    { name: 'Growth', scene: 'grow', styles: ['expansive', 'wide pads', 'glassy bell melody', 'wonder', 'rising'] },
    { name: 'Pointing', scene: 'point', styles: ['light playful pulse', 'gentle tension then warm release', 'confident'] },
    { name: 'Finale', scene: 'end', styles: ['full warm cinematic finale chord', 'long reverb tail', 'resolves and fades to silence'] },
  ],
}
