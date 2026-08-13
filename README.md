# Horses by HNH — Tips Page

Deploys to **tips.hoovesnhounds.com** on Netlify.

---

## Before you start

Two things to have ready:

1. **The logo** — save the PNG as `public/logo.png`. It's used in the masthead,
   the favicon and the home-screen icon.
2. **A password** — whatever you and Nath will both use to post tips.

---

## 1. Get the code into GitHub

Same as you did for the tracker: create a new empty repo, then from this folder:

```bash
git init
git add .
git commit -m "Tips page"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/hnh-tips.git
git push -u origin main
```

## 2. Create the Netlify site

1. Netlify → **Add new site** → **Import an existing project** → pick the repo
2. Build settings should auto-fill from `netlify.toml`. Confirm they read:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
3. Deploy

## 3. Set the password

**This step is required — posting won't work without it.**

Site configuration → **Environment variables** → Add a variable:

| Key | Value |
|---|---|
| `ADMIN_PASSWORD` | your chosen password |

Then **Deploys → Trigger deploy → Clear cache and deploy site**. Environment
variables only take effect on a fresh build.

## 4. Enable Blobs

Netlify Blobs is where the tips are stored. It's on by default for new sites —
if the page loads but saving fails, check Site configuration → **Blobs** is
enabled, and redeploy.

## 5. Point the domain at it

In Netlify: Domain management → **Add a domain** → `tips.hoovesnhounds.com`.
Netlify will show you a target like `your-site-name.netlify.app`.

Then in Squarespace (Settings → Domains → your domain → DNS Settings):

| Type | Host | Data |
|---|---|---|
| CNAME | `tips` | `your-site-name.netlify.app` |

Save. DNS usually propagates in 15–30 minutes but can take a few hours. Netlify
issues the HTTPS certificate automatically once it resolves — if it's still
showing a warning after an hour, hit **Renew certificate** in Netlify.

---

## Using it

- **Post tips**: open the site, tap **Admin**, enter the password, fill in the
  selections, hit Publish. Set the race day to tomorrow's date.
- **Settle**: next day, Admin → Settle. Mark won/lost, add the returned SP and a
  post-race note. The record updates itself.
- **Share**: under each day's card, *Copy post for X* and *Make image*.

The password is checked by the Netlify Function, never in the browser, and it's
held in memory only — closing the tab logs you out.

---

## Still to do

**Per-day link previews.** `index.html` carries static Open Graph tags, so every
link unfurls with the same card. For a preview showing that day's actual
selections you need a prerender function that serves crawlers a version of the
page with per-day `og:image` and `og:title` tags. Worth doing — it's the
difference between a link that gets clicked on X and one that doesn't.

**Push notifications.** Needs a service worker plus a push service. The
add-to-home-screen prompt and the email list cover it for now.

**A preview image.** Save one as `public/preview.png` (1200×630) or the link
card will show a broken image. The share tool's generated card works well for
this — make one and save it under that name.

---

## Where things live

| File | What it does |
|---|---|
| `src/App.jsx` | The whole page — tips, record, admin, sharing |
| `netlify/functions/tips.js` | Read/write API and password check |
| `index.html` | Meta tags, link previews |
| `public/manifest.webmanifest` | Home-screen install |

The carried-over April–August record is the `PRIOR` block at the top of
`src/App.jsx`. Tipsters are the `TIPSTERS` array just below it — add a third
name there and it appears everywhere automatically.
