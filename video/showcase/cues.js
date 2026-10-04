// Timing for the 59 s product showcase: the cinematic film (../cues.js, authored on a 66 s timeline) re-cut around
// three inserts of real footage from the Windows desktop app (../footage/app-session.mp4).
// showcase/edit.mjs assembles the picture; audio.mjs and mix.mjs take --film showcase. Times are seconds.

import * as FILM from '../cues.js'

export const NAME = 'protege-demo'
export const DURATION = 59
export const FPS = 30
export const OUTPUT = 59 // the edit is cut at its delivered length: no retiming in the mix
export const K = FILM.OUTPUT / FILM.DURATION // film segments play 1.1x faster, as in the 60 s cut
export const FADE = 0.5 // crossfade between segments

// The edit. Film segments take [from, to] on the film's authored timeline; footage segments take [from, to] in the
// footage file and a playback speed. `label` is the caption on the footage frame.
const EDL = [
  { src: 'film', from: 0, to: 14 }, // the loss, the reveal
  { src: 'footage', from: 7.6, to: 13.6, speed: 1, label: '01 · Name the task, press record' },
  { src: 'film', from: 18.6, to: 28.9 }, // capture: accessibility scan, masking, the ghost asks why
  { src: 'footage', from: 25, to: 31, speed: 1.09, label: '02 · Work Map, then a spoken debrief' },
  { src: 'film', from: 35.6, to: 39.8 }, // the Work Map page, confirmed by the expert
  { src: 'film', from: 40.2, to: 53.3 }, // teach: the new hire's mistake is caught before Post
  { src: 'footage', from: 3.95, to: 6.95, speed: 0.71, label: '03 · What Protégé knows, privacy at a glance' },
  { src: 'film', from: 60, to: 66 }, // end card
]
let at = 0
export const SEGMENTS = EDL.map((s) => {
  const dur = s.src === 'film' ? (s.to - s.from) * K : (s.to - s.from) / s.speed
  const seg = { ...s, start: at, end: at + dur }
  at += dur
  return seg
})
// Film time -> showcase time (null if that moment was cut).
export function fromFilm(t) {
  const s = SEGMENTS.find((x) => x.src === 'film' && t >= x.from && t < x.to)
  return s ? s.start + (t - s.from) * K : null
}
// Footage time -> showcase time (null if that moment was cut).
export function fromFootage(t) {
  const s = SEGMENTS.find((x) => x.src === 'footage' && t >= x.from && t < x.to)
  return s ? s.start + (t - s.from) / s.speed : null
}
const seg = (i) => SEGMENTS[i]

// Scene boundaries for the music's composition plan (showcase time).
export const SCENES = {
  loss: [0, 8 * K],
  reveal: [8 * K, seg(1).start],
  realapp: [seg(1).start, seg(2).start],
  capture: [seg(2).start, seg(3).start],
  map: [seg(3).start, seg(5).start],
  teach: [seg(5).start, seg(6).start],
  always: [seg(6).start, seg(7).start],
  end: [seg(7).start, DURATION],
}

export const VOICES = FILM.VOICES

// Spoken lines: the film's lines that survive the cut (moved to showcase time, slots scaled like the 60 s cut),
// plus new narration over the real footage.
const keep = ['n1', 'n2', 'n3', 'n3b', 'g1', 's1', 'n6', 'g2', 'n7', 'n9']
const r2 = (x) => Math.round(x * 100) / 100
export const LINES = [
  ...FILM.LINES.filter((l) => keep.includes(l.id)).map((l) => ({ ...l, t: r2(fromFilm(l.t)), max: r2(l.max * K) })),
  { id: 'f1', voice: 'narrator', t: 12.95, max: 5.6, text: 'This is the real app. An expert names the task, presses record, and simply works.' },
  { id: 'f1b', voice: 'narrator', t: 18.95, max: 3.0, text: 'It reads every field, and masks anything sensitive.' },
  { id: 'f2', voice: 'narrator', t: 28.3, max: 8.6, text: 'When the expert stops, it builds the guide and a Work Map, then asks about anything it couldn’t see.' },
  { ...FILM.LINES.find((l) => l.id === 'n8'), t: 49.45, max: 4.2 },
].sort((a, b) => a.t - b.t)

// Sound effects: the film's cues that survive the cut, plus cues for the footage. `ref` reuses another effect's file.
const byId = Object.fromEntries(FILM.SFX.filter((s) => !s.ref).map((s) => [s.id, s]))
const filmSfx = FILM.SFX.map((s) => ({ ...s, t: fromFilm(s.t) })).filter((s) => s.t !== null)
export const SFX = [
  ...filmSfx,
  { id: 'fx-rec', ref: 'click', t: fromFootage(10.1), gain: -11 },
  { id: 'fx-hello', ref: 'chime', t: fromFootage(11.65), gain: -11 },
  { id: 'fx-out1', ref: 'whoosh', t: seg(2).start - 0.25, gain: -11 },
  { id: 'fx-in2', ref: 'whoosh', t: seg(3).start - 0.25, gain: -10 },
  { id: 'fx-debrief', ref: 'click', t: fromFootage(26.2), gain: -11 },
  { id: 'fx-thanks', ref: 'pop', t: fromFootage(27.0), gain: -11 },
  { id: 'fx-question', ref: 'pop', t: fromFootage(29.4), gain: -11 },
  { id: 'fx-in3', ref: 'whoosh', t: seg(6).start - 0.25, gain: -10 },
  { id: 'fx-riser', ref: 'riser', t: seg(7).start - 2.0, gain: -8 },
].map((s) => ({ ...s, t: r2(s.t) }))
// If the cut dropped an effect that others reuse, its first remaining use takes over its prompt, so audio.mjs makes the file.
for (const id of new Set(SFX.filter((s) => s.ref).map((s) => s.ref))) {
  if (SFX.some((s) => s.id === id)) continue
  const i = SFX.findIndex((s) => s.ref === id)
  SFX[i] = { ...byId[id], t: SFX[i].t, gain: SFX[i].gain }
}

// Music: ElevenLabs Music composition plan, one section per scene of the cut.
export const MUSIC = {
  global: FILM.MUSIC.global,
  negative: FILM.MUSIC.negative,
  sections: [
    { name: 'Loss', scene: 'loss', styles: ['sparse melancholic felt piano', 'deep sub drone', 'lots of space', 'quiet'] },
    { name: 'Reveal', scene: 'reveal', styles: ['slow swelling build', 'shimmering pads rising', 'big warm hit at the end of the build'] },
    { name: 'Real app', scene: 'realapp', styles: ['light curious pulse', 'clean modern synth plucks', 'grounded and friendly'] },
    { name: 'Capture', scene: 'capture', styles: ['curious light pulsing synth arpeggio', 'soft ticking percussion', 'gentle forward motion'] },
    { name: 'Map', scene: 'map', styles: ['expansive', 'wide pads', 'glassy bell melody', 'wonder'] },
    { name: 'Teach', scene: 'teach', styles: ['rising tension with low pulse', 'sudden hush', 'then warm resolution'] },
    { name: 'Always on', scene: 'always', styles: ['confident uplifting build', 'steady pulse', 'growing strings'] },
    { name: 'Finale', scene: 'end', styles: ['full warm cinematic finale chord', 'long reverb tail', 'resolves and fades to silence'] },
  ],
}
