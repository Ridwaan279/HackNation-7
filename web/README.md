# Apprentice website

The Apprentice website as plain HTML, CSS and JavaScript. There is no build step: deploy this folder as it is.

The flow: the front page is the ghost and a **Kickstart** button. Kickstart starts the ghost's voice and shows the two versions side by side (web app, or desktop app, recommended). Picking one gives a short overview, then the web app's dashboard or the download.

| File | What it is |
|---|---|
| `index.html`, `styles.css` | The page. Fonts: Geist and Instrument Serif (Google Fonts). Icons: Phosphor Light, inlined. |
| `app.js` | Routing (`#/`, `#/choose`, `#/web`, `#/desktop`, `#/dashboard`, `#/guide/<id>`), the recorder (screen sharing, screenshots on change, speech-to-text, video), the dashboard and the guide editor. Recordings are kept in IndexedDB, in the browser. |
| `voice.js` | The ghost's voice: the ElevenLabs agent (SDK loaded on first use) with the client tools `show_options`, `highlight_download` and `open_mode`, or a browser-voice tour when no agent is set. |
| `config.js` | **Settings:** `downloadUrl`, `githubUrl`, `elevenLabsAgentId`. |
| `assets/` | 3D renders (made with three.js, including the two version cards) and product shots of MiniERP. |
| `downloads/` | `Apprentice-Windows.zip`, built by `scripts/make-download`. |

Run it locally (screen sharing needs `localhost` or `https`):

```bash
python -m http.server 5173     # from this folder, then open http://localhost:5173 in Chrome or Edge
```

How to deploy it, make the download button work and connect the voice agent: see the main [README](../README.md#the-website).
