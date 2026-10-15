# FRIDGE FM

Experimental cryo-acoustic synthesizer running in your browser. Original single-page Web Audio implementation, packaged for reproducible Vite builds and GitHub Pages deployment.

## Quick start

Requires Node.js 22+.

```bash
npm install
npm run dev
```

Open the local address printed by Vite. For a production build:

```bash
npm run check
npm run build
npm run preview
```

## GitHub Pages

Push to `main`. In the GitHub repository go to **Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/` automatically.

## Architecture

- `index.html`: original synthesizer UI and custom styles
- `src/app.js`: original synthesis engine and UI logic, with JSZip imported locally
- `src/styles.css`: compiled Tailwind CSS entry
- `vite.config.js`: portable relative asset paths for project Pages

## Notes

Audio playback requires a user gesture. WAV rendering, presets, and ZIP batch exports run in-browser. Google Fonts still requires an internet connection; browser fallback fonts are provided. Browser audio output, device sample rates, and rendering performance vary. Test exported audio with your DAW before using it in production.

This packaging preserves the existing instrument logic; it does not independently certify DSP quality or every interactive feature. The source project was a single HTML file; a future refactor could split DSP and UI into testable modules.
