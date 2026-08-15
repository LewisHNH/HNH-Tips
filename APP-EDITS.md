# Wiring the greyhounds into App.jsx

Four edits. Do them in order. After each one you can hit Commit — the site won't break part-way, because nothing renders until edit 3.

---

## Edit 1 — add the imports

**Find** the very first line:

```jsx
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
```

**Add these three lines directly underneath it:**

```jsx
import SportToggle, { useSport } from "./greyhounds/SportToggle.jsx";
import GreyhoundTips from "./greyhounds/GreyhoundTips.jsx";
import GreyhoundAdmin from "./greyhounds/GreyhoundAdmin.jsx";
```

---

## Edit 2 — let AdminView receive the PIN

**Find:**

```jsx
function AdminView({ days, save, exit }) {
```

**Replace with:**

```jsx
function AdminView({ days, save, exit, password }) {
```

---

## Edit 3 — add the Dogs tab to the admin

**Find** (in `AdminView`, the tab buttons):

```jsx
        <button onClick={exit}>Exit</button>
      </div>
```

**Replace with:**

```jsx
        <button aria-pressed={tab === "dogs"} onClick={() => setTab("dogs")}>Dogs</button>
        <button onClick={exit}>Exit</button>
      </div>

      {tab === "dogs" && <GreyhoundAdmin password={password} />}
```

---

## Edit 4 — add the sport toggle to the public page

**Find** (near the very bottom, inside `export default function App`):

```jsx
  const [error, setError] = useState("");
```

**Replace with:**

```jsx
  const [error, setError] = useState("");
  const [sport, setSport] = useSport("horses");
```

Then **find** (a few lines below, the last block before the closing tags):

```jsx
        {loading ? <div className="empty" style={{ marginTop: 24 }}>Loading…</div>
          : admin ? <AdminView days={days} save={save} exit={() => setAdmin(false)} />
          : <PublicView days={days} />}
```

**Replace with:**

```jsx
        {loading ? <div className="empty" style={{ marginTop: 24 }}>Loading…</div>
          : admin ? (
            <AdminView days={days} save={save} exit={() => setAdmin(false)} password={password} />
          ) : (
            <>
              <SportToggle sport={sport} onChange={setSport} />
              {sport === "horses" ? <PublicView days={days} /> : <GreyhoundTips />}
            </>
          )}
```

---

## That's it

Everything else in `App.jsx` is untouched. Your horses page, the PRIOR record, the tipster filter, the share tools, the settle screen — none of it changes.

## Environment variable

One only, in Netlify → Site configuration → Environment variables:

```
HNH_ADMIN_TOKEN = <the same PIN you already use for the admin>
```

The greyhound function now accepts the same `x-admin-password` header your existing `/api/tips` uses, so one PIN unlocks both. Set this to the identical value and the Dogs tab just works.

Telegram is optional and can wait:

```
TELEGRAM_BOT_TOKEN = <from @BotFather>
TELEGRAM_GREYHOUND_CHAT_ID = <your channel>
```

Without them, posting still works — Telegram is skipped silently.

## What you should see

- A **Horses / Greyhounds** toggle above the tips, in your existing gold segmented style
- Horses selected: exactly what you have now
- Greyhounds selected: the greyhound page, empty until you post a tip
- Admin: a new **Dogs** tab beside Post tips and Settle

The greyhound section will look bare on first load. Enter the free months and the group months through the Dogs tab and it fills in.
