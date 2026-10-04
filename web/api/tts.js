// Protégé's voice: ElevenLabs text-to-speech for the website, as a Vercel serverless function.
// The API key stays here (Vercel → Settings → Environment Variables → ELEVENLABS_API_KEY), never in the page.
// GET /api/tts?text=… returns MP3. Identical lines are cached at the edge, so a repeated line costs nothing.
// On hosts without functions (or without the key) the page falls back to the browser's own voice.

const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL' // "Sarah": calm, natural. Change with ELEVENLABS_VOICE_ID.
const MAX_CHARS = 420

module.exports = async (req, res) => {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return res.status(501).json({ error: 'ELEVENLABS_API_KEY is not set' })
  if (req.method !== 'GET') return res.status(405).json({ error: 'use GET' })
  // Only this website may use the voice (browsers send Sec-Fetch-Site on fetch requests).
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return res.status(403).json({ error: 'same origin only' })
  if (!req.headers['sec-fetch-site']) return res.status(403).json({ error: 'browser requests only' })
  const text = String(req.query.text ?? '').trim()
  if (!text || text.length > MAX_CHARS) return res.status(400).json({ error: `text must be 1 to ${MAX_CHARS} characters` })

  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE
  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
    }),
  }).catch((e) => ({ ok: false, status: 502, text: async () => String(e) }))
  if (!upstream.ok) return res.status(502).json({ error: `ElevenLabs answered ${upstream.status}: ${(await upstream.text()).slice(0, 300)}` })

  res.setHeader('content-type', 'audio/mpeg')
  res.setHeader('cache-control', 'public, max-age=86400, s-maxage=31536000, immutable')
  res.status(200).send(Buffer.from(await upstream.arrayBuffer()))
}
