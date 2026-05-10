# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**HusbandLabs** — A static landing page at husbandlabs.com showcasing Nate's side projects. Retro pixel-art design using Press Start 2P font with a dark/light mode responsive card grid.

## Structure

- `public/` — deployable assets (uploaded to Cloudflare Pages)
  - `index.html` — single-page site with inline CSS and minimal JS
  - `og-image.png` — Open Graph social sharing image
  - `cow-say-icon.png` — app icon for the "What Does the Cow Say" card
  - `robots.txt` — search engine directives
- `wrangler.toml` — Cloudflare Pages project config
- `package.json` — `npm run dev` and `npm run deploy` scripts

## Featured Projects

- Hamsterhopper.com — Arcade web game
- PicFit.ai — AI try-on visualizations
- DroneHunterGame.com — Arcade prototype
- TheBestBabyNames.com — Baby name discovery tool
- What Does the Cow Say (TestFlight beta) — iOS See 'n Say-style animal-sound wheel for kids

## Tech Stack

- **Static HTML/CSS/JS** — no framework, no build step
- **Hosting**: Cloudflare Pages (project name: `husbandlabs`, custom domain: husbandlabs.com)
- **DNS**: Cloudflare zone for husbandlabs.com (account 4219a576830c72b0e6e4ca358e61473a)

## Design

- Font: Press Start 2P (Google Fonts)
- Dark theme with `prefers-color-scheme: light` override
- CSS custom properties (`--bg`, `--card`, `--ink`, `--accent`)
- Responsive grid: `auto-fit` and `minmax(240px, 1fr)`

## Development & Deploy

```bash
npm install
npm run dev      # local preview via wrangler pages dev public
npm run deploy   # wrangler pages deploy public --project-name husbandlabs --branch main
```

First-time auth: `wrangler login` (OAuth) or set `CLOUDFLARE_API_TOKEN` env var with Pages:Edit scope.
