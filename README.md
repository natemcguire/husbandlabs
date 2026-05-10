# HusbandLabs

Static landing site at [husbandlabs.com](https://husbandlabs.com), deployed to Cloudflare Pages.

## Develop

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

First time only: `wrangler login`, then run the deploy command above. After the first deploy, attach the custom domain `husbandlabs.com` from the Cloudflare Pages project settings (Custom domains → Set up a custom domain).
