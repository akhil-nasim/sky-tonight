# Sky Tonight

A single-page dashboard that shows what's in the night sky from your location: which planets are up and when, the Moon's phase, and when the International Space Station passes overhead. Every object comes with a short "why this matters" note.

No build step, no API keys, no backend. It's plain HTML, CSS and JavaScript.

Built by **Akhil Nasim**: [akhilnasim.com](https://akhilnasim.com)

## Features

- **Location**: use your device's location, or search for any city. Times are shown in that place's time zone, and the last location is remembered.
- **Tonight's times**: sunset, start and end of full darkness (astronomical twilight), and sunrise.
- **Moon**: a drawn phase image, percent illuminated, next moonrise and moonset, next full and new moon, when it's up tonight, and a viewing tip for the current phase.
- **Sky map**: an all-sky chart (zenith in the centre, north at the top) with a slider to step through the night.
- **Planets**: a card for each of Mercury through Neptune with visibility tonight, best time and direction, brightness, and a chart of its altitude from sunset to sunrise.
- **ISS**: live position, speed and altitude, plus visible passes over the next 3 days with a small sky-path diagram for each. Passes in daylight or in Earth's shadow are listed separately.
- **Red mode**: turns the page red so your eyes stay dark-adapted while you're outside.

## Running it

Serve the folder with any static file server, since browsers block some features on `file://` pages:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

The geolocation button needs a secure context: `localhost` or HTTPS. If you deploy the site, use HTTPS hosting such as GitHub Pages or Netlify.

## Deploying and SEO

The page includes a meta description, canonical URL, Open Graph and Twitter card tags, `WebApplication` structured data (JSON-LD), a web app manifest, `robots.txt` and `sitemap.xml`.

These all point to **`https://skytonight.akhilnasim.com/`**. Deploy the files to the root of that subdomain so `robots.txt`, `sitemap.xml` and the icons are served from `/`. If the address ever changes, find and replace it in `index.html`, `robots.txt` and `sitemap.xml`.

In Google Search Console, add `skytonight.akhilnasim.com` as its own property (or verify the whole `akhilnasim.com` domain), since subdomains are treated as separate sites.

After deploying, submit the sitemap in Google Search Console and check the share preview with a tool like [opengraph.xyz](https://www.opengraph.xyz).

## Data sources

| What | Source | Notes |
| --- | --- | --- |
| Planet and Moon positions | [Visible Planets API](https://api.visibleplanets.dev) | Sampled about hourly from sunset to sunrise (up to 18 requests, 4 at a time). |
| ISS orbit | [TLE API](https://tle.ivanstanojevic.me) (falls back to [CelesTrak](https://celestrak.org)) | Two-line element set for NORAD ID 25544. |
| ISS passes and live position | [satellite.js](https://github.com/shashwatak/satellite-js) | SGP4 propagation every 10 s over 72 h. |
| Moon phase, rise/set, sun times | [Astronomy Engine](https://github.com/cosinekitty/astronomy) | Computed in the browser. |
| City search | [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | Also provides the time zone. |

If the Visible Planets API can't be reached, positions are computed on-device with Astronomy Engine instead, and the planet section says so.

## How "visible" is decided

- **Planets and Moon**: visible when the object is at least 5° above the horizon while the Sun is more than 6° below it (after civil twilight).
- **ISS passes**: a pass counts when the station climbs at least 10° above the horizon. It's *visible* when, for at least a minute, the station is sunlit (cylindrical Earth-shadow model) while your sky is dark. Morning passes often "emerge from Earth's shadow" and evening passes "fade into" it.

## Project structure

```
index.html    Page layout
favicon.svg   Site icon (source for the PNG/ICO icons)
favicon.ico, favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png
og-image.png  1200×630 social share image
site.webmanifest, robots.txt, sitemap.xml
styles.css    Styling (dark night-sky theme, red mode)
app.js        Data fetching, astronomy calculations and rendering
content.js    "Why this matters" text and Moon-phase viewing tips
```

To change the explanations, edit `content.js`. Each object has a `tagline` and a `why` paragraph.

## Limitations

- Planet times come from hourly samples, so rise and set windows are accurate to about an hour.
- ISS predictions depend on how fresh the orbit data is. They're reliable for a few days and drift after that, especially after the station adjusts its orbit.
- No pass brightness (magnitude) estimate yet.
- Near the poles, during midnight sun the page reports that there's no night to show.
