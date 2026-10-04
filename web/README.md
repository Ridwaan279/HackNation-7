# Apprentice website

The landing page, the web recorder and "Ask the ghost", as plain HTML, CSS and JavaScript. There is no build step: deploy this folder as it is.

| File | What it is |
|---|---|
| `index.html`, `styles.css` | The page. Fonts: Geist and Instrument Serif (Google Fonts). Icons: Phosphor Light, inlined. |
| `app.js` | Routing, scroll reveals, the recorder (screen sharing, screenshots on change, speech-to-text, video) and the guide editor. Recordings are kept in IndexedDB, in the browser. |
| `voice.js` | "Ask the ghost": the ElevenLabs voice agent (SDK loaded on the first click), with a browser-voice preview when no agent is set. |
| `config.js` | **Settings:** `downloadUrl`, `githubUrl`, `elevenLabsAgentId`. |
| `assets/` | 3D renders (made with three.js) and product shots of MiniERP. |
| `downloads/` | `Apprentice-Windows.zip`, built by `scripts/make-download`. |

Run it locally (screen sharing needs `localhost` or `https`):

```bash
python -m http.server 5173     # from this folder, then open http://localhost:5173 in Chrome or Edge
```

How to deploy it, make the download button work and connect the voice agent: see the main [README](../README.md#the-website).
