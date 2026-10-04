# Apprentice web recorder

A static web app (plain HTML, CSS and JavaScript; no build step) that records how an expert does a task and turns it into a step guide:

- shares a window, tab or screen (`getDisplayMedia`) and keeps a screenshot whenever the screen changes (at most every 3, 5 or 10 s, chosen before recording), plus a **Take a screenshot** button;
- the first 10 seconds are for the expert's introduction (what they will show, and for whom). That becomes the guide's introduction, and screenshots start afterwards;
- records the expert's voice into a video (`MediaRecorder`) and writes down what they say (Web Speech API in Chrome and Edge). Each sentence is attached to the screenshot it belongs to;
- review: edit titles and notes, reorder, delete, enlarge screenshots; download the guide as one self-contained HTML file, print it to PDF, download the video;
- everything stays in the browser (IndexedDB). Nothing is uploaded.

A browser can't read other apps' fields or keystrokes, so the banner and the **Desktop app** page point to the Windows app for accessibility reading, masking, the voice agent, Work Maps, 24/7 learning and the tutor ghost.

## Run locally

Screen sharing needs `https://` or `localhost`:

```bash
cd web && python -m http.server 5173     # then open http://localhost:5173 in Chrome or Edge
```

## Deploy

It's a folder of static files, so any static host works. They all serve HTTPS, which screen sharing needs.

- **Vercel:** New Project → import the repo → Root Directory `web`, Framework Preset **Other**, no build command, output directory `.` (leave empty).
- **Netlify:** Add new site → import the repo → Base directory `web`, Publish directory `web`, no build command. Or drag the `web` folder onto app.netlify.com/drop.
- **Cloudflare Pages:** build command empty, build output directory `web`.
- **GitHub Pages:** publish the `web` folder (for example with an Action that uploads `web/` as the Pages artifact).

The **Download the app** links go to `DOWNLOAD_URL` at the top of `app.js`. Point it at a release (an `.exe` or `.zip`) once one is published. If the repository is private, visitors can't open the current link.

## Browser support

Chrome and Edge on a computer: everything. Firefox: recording and screenshots, no speech-to-text. Safari: screen sharing works in recent versions; speech-to-text varies. Phones can't share their screen from a web page.
