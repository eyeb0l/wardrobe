<div align="center">

# Wardrobe

A personal catalogue of the clothes you already own. Wardrobe turns your photos and product links into clean cutouts and modelled photos, puts together outfits from your own pieces, and tells you whether something you're thinking of buying would actually add to what you have. It's built for one person running their own copy, locally or privately hosted on Vercel.

[Open Wardrobe →](https://wardrobe.iriss.dev/) · Private access through Vercel Authentication.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22](https://img.shields.io/badge/node-22.x-191919?style=flat-square)](package.json)

[Original project post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modelled wardrobe editor](docs/screenshots/editor.png)

## Features

- **Wardrobe:** import clothes from photos or product pages, review the generated cutouts and modelled photos, and browse everything by category. Choose **Rearrange** to drag pieces or use the arrow controls to change their order within a category; changes save automatically across devices.
- **Outfits:** generate modelled looks from your own pieces, favourite saved looks, filter by garment and occasion, and log what you wore. Optional AI search and piece-swap suggestions help refine a look.
- **Shopping:** find gaps in your wardrobe, or check a product link, listing screenshot or photo against what you own before you buy.

## Quick start

Requires Node.js 22.x and npm.

```bash
git clone https://github.com/eyeb0l/wardrobe.git
cd wardrobe
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). A short setup flow introduces Wardrobe, Outfits and Shopping; reopen it any time from **Setup & guide**.

Browsing needs no API key: choose **Explore first**. To import clothes and generate images, copy `.env.example` to `.env` (keep an existing `.env`), add your `OPENAI_API_KEY`, place a PNG identity reference at `data/model-reference.png`, and restart. You never need to enter credentials into the setup page.

## Documentation

- [Importing and editing clothes](docs/IMPORTING.md): photo and website imports, cutouts, on-device background removal and upload limits
- [Outfits](docs/OUTFITS.md): generation rules, saved-look search, piece swaps and accessory suggestions
- [Shopping assistant](docs/SHOPPING.md): gap-finding, piece checks and visual overlap
- [Manual modelled photos](docs/MODELED_PHOTOS.md): supplying your own photo when generation fails
- [Configuration, storage and privacy](docs/CONFIGURATION.md): environment variables, model references and where data lives
- [Hosting on Vercel](docs/HOSTING.md): private access across devices, cloud storage and the initial data copy
- [Backups](docs/BACKUPS.md) and [local storage](docs/LOCAL_STORAGE.md): backup and recovery
- [Using Wardrobe with Codex](docs/CODEX_SKILLS.md): bundled import, outfit and shopping skills
- [Contributing](CONTRIBUTING.md): development checks and code boundaries

## License

[MIT](LICENSE)
