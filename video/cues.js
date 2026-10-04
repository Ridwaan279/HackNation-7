// Timing for the Protégé demo film. Shared by the scene (scene.js), the audio builder (audio.mjs) and the mixer (mix.mjs).
// Times are seconds from the start of the film.

export const DURATION = 66
export const FPS = 30
// The film is authored on a 66 s timeline and delivered at 60 s: mix.mjs plays the picture 1.1x faster
// and scales every cue below by OUTPUT / DURATION.
export const OUTPUT = 60

// Scene boundaries (used by the scene and for the music's composition plan).
export const SCENES = {
  loss: [0, 8],
  reveal: [8, 14],
  capture: [14, 29],
  map: [29, 40],
  teach: [40, 54.5],
  trust: [54.5, 60],
  end: [60, 66],
}

// ElevenLabs voices. Override with NARRATOR_VOICE_ID, GHOST_VOICE_ID, SABINE_VOICE_ID.
export const VOICES = {
  narrator: { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', stability: 0.55, similarity: 0.8, style: 0.35, speed: 1.08 },
  ghost: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (the voice of the Protégé website)', stability: 0.45, similarity: 0.8, style: 0.4, speed: 1.05 },
  sabine: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', stability: 0.6, similarity: 0.8, style: 0.25, speed: 1.05 },
}

// Spoken lines. `max` is the slot length; audio.mjs speeds up a clip slightly if it overruns.
export const LINES = [
  { id: 'n1', voice: 'narrator', t: 0.6, max: 3.4, text: 'Sabine has spent twenty-four years in accounts payable.' },
  { id: 'n2', voice: 'narrator', t: 4.2, max: 4.2, text: 'In eighteen months, she retires. And everything she knows leaves with her.' },
  { id: 'n3', voice: 'narrator', t: 9.0, max: 2.0, text: 'Unless someone was paying attention.' },
  { id: 'n3b', voice: 'narrator', t: 11.6, max: 1.6, text: 'Meet Protégé.' },
  { id: 'n4', voice: 'narrator', t: 15.2, max: 6.9, text: 'Protégé sits beside your expert while they work. It reads every field, and masks anything sensitive on the spot.' },
  { id: 'g1', voice: 'ghost', t: 22.4, max: 2.9, text: 'You moved that one to capex. What made you do that?' },
  { id: 's1', voice: 'sabine', t: 25.5, max: 3.0, text: 'Equipment over five thousand euros is always capex.' },
  { id: 'n5', voice: 'narrator', t: 29.8, max: 6.8, text: 'Then it turns the session into a step-by-step guide, and a Work Map of every decision and guardrail. In her own words.' },
  { id: 'n6', voice: 'narrator', t: 40.6, max: 2.6, text: 'Months later, a new hire makes the same call.' },
  { id: 'g2', voice: 'ghost', t: 45.5, max: 2.6, text: 'Sabine would stop here. Why do you think?' },
  { id: 'n7', voice: 'narrator', t: 48.8, max: 4.4, text: 'Protégé catches the mistake before it is saved, and explains it the way Sabine would.' },
  { id: 'n8', voice: 'narrator', t: 55.0, max: 4.6, text: 'It never reads a password. And it keeps learning: every app, every day.' },
  { id: 'n9', voice: 'narrator', t: 61.2, max: 3.6, text: 'Protégé. Show it once. It remembers.' },
]

// Sound effects (ElevenLabs text to sound). `gain` is in dB.
export const SFX = [
  { id: 'drone', t: 0.0, dur: 8, gain: -10, prompt: 'Deep dark cinematic ambient drone, slow evolving sub bass, distant airy texture, trailer opening, no melody' },
  { id: 'dissolve', t: 5.6, dur: 3, gain: -8, prompt: 'Glittering magical particles dissolving into the air, airy shimmer fading away, delicate, cinematic' },
  { id: 'riser', t: 8.8, dur: 2.6, gain: -7, prompt: 'Reverse cymbal swell and rising airy whoosh building into a hit, cinematic trailer riser' },
  { id: 'impact', t: 11.25, dur: 4, gain: -4, prompt: 'Huge deep cinematic impact boom with sparkling magical shimmer tail, logo reveal hit' },
  { id: 'whoosh', t: 13.8, dur: 1.5, gain: -9, prompt: 'Fast smooth cinematic whoosh transition, airy, clean' },
  { id: 'click', t: 16.2, dur: 0.5, gain: -12, prompt: 'Single soft mouse click, crisp, close, clean, no reverb' },
  { id: 'scan', t: 17.0, dur: 2.5, gain: -12, prompt: 'Soft futuristic digital scan sweep, gentle glassy hum moving across, subtle UI sound' },
  { id: 'click2', ref: 'click', t: 19.1, gain: -12 },
  { id: 'type', t: 19.5, dur: 1.2, gain: -14, prompt: 'Quick soft keyboard typing, four keystrokes, close and clean' },
  { id: 'mask', t: 20.6, dur: 1, gain: -10, prompt: 'Soft glassy lock click with a tiny shimmer, secure, satisfying desktop UI sound' },
  { id: 'pop', t: 21.2, dur: 0.7, gain: -11, prompt: 'Small gentle inquisitive bubble pop with a bright shimmer, subtle desktop UI sound, no voice, no music' },
  { id: 'chime', t: 22.1, dur: 1.2, gain: -9, prompt: 'Soft warm two-note confirmation chime, delicate glass and felt, subtle desktop UI sound, no voice, no music' },
  { id: 'pop2', ref: 'pop', t: 28.2, gain: -12 },
  { id: 'whoosh2', ref: 'whoosh', t: 28.9, gain: -8 },
  { id: 'crystal', t: 30.0, dur: 5, gain: -11, prompt: 'Crystalline glass chimes connecting one by one, magical constellation forming, soft and bright, cinematic' },
  { id: 'confirm', t: 37.2, dur: 1.5, gain: -8, prompt: 'Warm rewarding success chime, soft bell and glass, uplifting, short, desktop UI' },
  { id: 'whoosh3', ref: 'whoosh', t: 39.9, gain: -8 },
  { id: 'click3', ref: 'click', t: 42.0, gain: -12 },
  { id: 'click4', ref: 'click', t: 42.9, gain: -12 },
  { id: 'stop', t: 44.45, dur: 1.5, gain: -6, prompt: 'Cinematic time freeze: sudden tape stop and deep suction swell, tension hit, short' },
  { id: 'guard', t: 44.9, dur: 0.9, gain: -8, prompt: 'Gentle caution tone, two soft descending glass notes, helpful not alarming, desktop UI sound, no voice, no music' },
  { id: 'fly', t: 44.7, dur: 1.4, gain: -8, prompt: 'Magical swoosh fly-by with sparkle trail, playful ghost flying past quickly' },
  { id: 'pop3', ref: 'pop', t: 46.6, gain: -11 },
  { id: 'click5', ref: 'click', t: 48.9, gain: -12 },
  { id: 'type2', ref: 'type', t: 49.7, gain: -14 },
  { id: 'click6', ref: 'click', t: 50.8, gain: -12 },
  { id: 'success', ref: 'confirm', t: 51.0, gain: -7 },
  { id: 'whoosh4', ref: 'whoosh', t: 54.3, gain: -8 },
  { id: 'shield', t: 54.7, dur: 2.5, gain: -9, prompt: 'Soft energy shield powering up, warm protective hum with shimmering glass overtones' },
  { id: 'riser2', ref: 'riser', t: 58.4, gain: -7 },
  { id: 'finale', t: 60.6, dur: 5, gain: -4, prompt: 'Cinematic logo reveal hit, deep warm boom with a long magical sparkling tail and soft choir air' },
]

// Music: ElevenLabs Music composition plan, one section per scene.
export const MUSIC = {
  global: [
    'cinematic', 'emotional', 'modern ambient trailer', 'warm analog synth pads', 'felt piano', 'soft pulsing arpeggios',
    'airy textures', 'hopeful', 'instrumental',
  ],
  negative: ['vocals', 'lyrics', 'singing', 'rap', 'heavy drums', 'aggressive', 'distorted guitar', 'EDM drop'],
  sections: [
    { name: 'Loss', scene: 'loss', styles: ['sparse melancholic felt piano', 'deep sub drone', 'lots of space', 'quiet'] },
    { name: 'Reveal', scene: 'reveal', styles: ['slow swelling build', 'shimmering pads rising', 'big warm hit at the end of the build'] },
    { name: 'Capture', scene: 'capture', styles: ['curious light pulsing synth arpeggio', 'soft ticking percussion', 'gentle forward motion'] },
    { name: 'Map', scene: 'map', styles: ['expansive', 'wide pads', 'glassy bell melody', 'wonder'] },
    { name: 'Teach', scene: 'teach', styles: ['rising tension with low pulse', 'sudden hush', 'then warm resolution'] },
    { name: 'Trust', scene: 'trust', styles: ['confident uplifting build', 'steady pulse', 'growing strings'] },
    { name: 'Finale', scene: 'end', styles: ['full warm cinematic finale chord', 'long reverb tail', 'resolves and fades to silence'] },
  ],
}
