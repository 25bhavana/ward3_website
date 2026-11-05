# Ward 3 Website — Complaint System: Diagnosis, Fixes & Setup Guide

_Prepared 5 Nov 2026. Covers: root cause of the Make failure, code changes made,
exact Make.com setup, WhatsApp Cloud API reality check, and a full test checklist._

---

## 0. First, two facts that change the picture

1. **There is no `shilpa-chute-final-corrected` nested folder in the repo.**
   The live repo (`main` branch, the only branch) contains exactly:
   `index.html`, `assets/images/shilpa-tulshiram-chute.jpg`, and placeholder
   `README.txt` files in the gallery folders. The root `index.html` **is** the
   live site and **is** the latest version. The nested folder you remember is
   probably a local copy on your computer that was never pushed. Nothing is
   duplicated or stale on GitHub — good.

2. **The complaint form was not broken.** The `<form>` tag is well-formed, not
   nested, every field has a valid `name`, and **no JavaScript touched the form
   at all** — the old script only did language toggle, menu, and animations.
   So the form was doing a normal full-page POST to FormSubmit. The reason Make
   saw nothing is the **FormSubmit → Make `_webhook` relay itself**, not the form.

---

## 1. Root cause: why Make showed "No data detected"

You relied on FormSubmit's hidden `_webhook` field to forward submissions to Make.
That chain fails for a combination of reasons, all consistent with your logs
(*"request accepted… waiting for data… exceeded maximum wait time… stopped"*):

| # | Cause | Why it breaks Make |
|---|-------|--------------------|
| A | **FormSubmit requires email activation.** The very first submission to `rohitchute1610@gmail.com` only triggers a confirmation email; FormSubmit does **not** process or forward **anything** (email *or* webhook) until you click that activation link once. If it was never activated, the `_webhook` never fired. | Make receives nothing, ever. |
| B | **Make "Run once" listens for ~60 seconds, then stops.** FormSubmit's webhook forwarding is asynchronous and server-to-server; by the time (if ever) it relays, Make has already timed out and stopped listening. | "Exceeded maximum wait time." |
| C | **FormSubmit's `_webhook` is fire-and-forget and historically unreliable** on the free tier. There is no delivery guarantee, no retry, and the payload shape is not what Make's data-structure detector expects. | "Data structure not determined yet." |

**Conclusion:** chaining `FormSubmit → _webhook → Make` is the wrong architecture
for a reliable, production complaint system. It has been removed.

---

## 2. New architecture (implemented)

The browser now sends to **two independent channels**, and a complaint is counted
as delivered if **either** succeeds — so no data is lost if one channel is down
(your reliability requirement #10):

```
                         ┌─────────────────────────────┐
  Citizen submits form → │ JavaScript: validate + guard │
                         └──────────────┬──────────────┘
          ┌─────────────────────────────┴───────────────────────────┐
          ▼ (Channel 1: EMAIL)                    ▼ (Channel 2: RELAY → Make)
  FormSubmit AJAX endpoint              Cloudflare Worker (keeps Make URL secret,
  → email to rohitchute1610@gmail.com     re-validates, rate-limits, honeypot)
                                        → Make webhook → email + (later) WhatsApp
```

- **Success message appears only after a channel actually confirms** (requirement
  #9). Until then it shows "Sending…"; on failure it shows an error, not success.
- **The leaked Make URL `…/4bcr6btwqgjsye7i4e45vg9cdec5tcdk` has been deleted**
  from the site. You will generate a fresh one (see §4).

---

## 3. Exact code changes

All changes are in `index.html`, plus one new file `cloudflare-worker.js`.

**`index.html`**
1. **Removed** the hidden `_webhook` field containing the leaked Make URL.
2. Changed the form `action` from `https://formsubmit.co/…` to the AJAX endpoint
   `https://formsubmit.co/ajax/rohitchute1610@gmail.com` (lets us await the result
   and show success only on real success). Added `id="complaintForm"` and `novalidate`.
3. Added `<input name="_captcha" value="false">` (required for the AJAX endpoint).
4. Added a **honeypot** field (`_honey`, visually hidden) — bots that fill it are
   dropped silently. Added CSS `.hp-wrap` to hide it and `.form-status` styles.
5. Added a bilingual **status line** (`#formStatus`, `aria-live="polite"`) under
   the button for Sending / success / error messages (Marathi + English).
6. Added a **submission handler script** that:
   - blocks double submission (disables the button while sending);
   - validates required fields and the **10-digit mobile** client-side;
   - builds a normalized JSON payload with a **reference number** (`WD3-…`) and
     an ISO **timestamp**;
   - POSTs to **both** channels and resolves success if either works.
   - Has one line you must set: `const RELAY_URL = '';` ← put your Worker (or Make) URL here.

**`cloudflare-worker.js`** (new) — the secure relay. Validates server-side,
honeypot, optional KV rate limiting, CORS locked to your origin, forwards a clean
payload to your private Make webhook. Full setup steps are in the file header.

_Nothing else was touched — design, Marathi/English content, images, gallery,
WhatsApp button, social links and responsiveness are all unchanged._

---

## 4. Make.com setup (step by step)

Do this **after** deploying the Worker (§5), or you can test Make first with a
temporary direct URL.

1. **Generate a fresh webhook.** In Make, open your scenario → the **Custom
   webhook** module → **Add** → name it (e.g. *Ward3 Complaints v2*) → **Save**.
   Copy the new `https://hook.eu1.make.com/…` URL. *(Treat the old one as burned.)*
2. **Feed it the data structure.** Either:
   - Put the new URL in the Worker's `MAKE_WEBHOOK_URL` secret, deploy, then submit
     one test complaint from the site; **or**
   - temporarily set `RELAY_URL` in `index.html` to the Make URL directly and submit once.
   Make will capture the sample and say **"Successfully determined."** The fields
   it will see (from the JSON payload):
   `reference, fullName, mobile, ward, category, message, submittedAt, source`.
3. **Add a Filter (anti-spam / validation)** right after the webhook: only continue
   if `mobile` matches `[0-9]{10}` and `message` is not empty. (The Worker already
   validates, but this is defence in depth.)
4. **Add the Email module** — *Email → Send an email* (or Gmail). Map:
   - Subject: `New Grievance {{reference}} — {{category}}`
   - To: `rohitchute1610@gmail.com` *(unchanged, as you asked)*
   - Body: Name `{{fullName}}`, Mobile `{{mobile}}`, Ward `{{ward}}`,
     Category `{{category}}`, Message `{{message}}`, Time `{{submittedAt}}`,
     Ref `{{reference}}`.
5. **Deduplication (requirement #7):** add a *Tools → Set variable* or a Data Store
   keyed on `reference` (or `mobile+message`) and a filter that skips if seen in the
   last few minutes. Simplest reliable option: a Make **Data Store**.
6. **Turn the scenario ON** (toggle to *Scheduling: Immediately*). "Run once" is
   only for capturing structure; it must be left scheduled/on to receive live traffic.
7. Add the WhatsApp module later (§6) once the API is approved.

---

## 5. Cloudflare Worker setup (recommended, ~10 min, free tier)

Keeps your Make URL private and does the server-side validation / rate limiting.

1. Cloudflare dashboard → **Workers & Pages → Create → Worker** → paste
   `cloudflare-worker.js` → Deploy.
2. Worker → **Settings → Variables and Secrets**:
   - `MAKE_WEBHOOK_URL` = your new Make URL **(type: Secret)**
   - `ALLOWED_ORIGIN` = `https://25bhavana.github.io` **(type: Text)**
3. *(Optional rate limiting)* **Storage & Databases → KV** → create a namespace →
   back in the Worker → **Bindings** → add KV binding named `RL`.
4. Copy the Worker URL (e.g. `https://ward3-relay.<sub>.workers.dev`) and set it
   as `RELAY_URL` in `index.html`. Commit & push.

*Quick alternative (less secure):* skip the Worker and set `RELAY_URL` directly to
the fresh Make webhook URL. It works, but the URL is then public and only protected
by the Make-side Filter — fine for a short test, not ideal for production.

---

## 6. WhatsApp — the honest findings

You want complaint alerts to arrive on **+91 93702 53998**, keep using the WhatsApp
**Business app** on it, and not buy a new number. Here is the reality:

**a) Coexistence can keep your Business app working.**
Meta's **Coexistence** (WhatsApp Business Platform) lets one number run the Business
**app** and the **Cloud API** at the same time. You connect it through **Embedded
Signup** (your own Meta Developer app + a Meta Business/WABA). Eligibility is checked
in that flow — the number must currently be on the WhatsApp **Business app** (not the
consumer app, and not already registered to a Cloud API elsewhere). So in principle
the existing app is **not** disconnected. **Do not** migrate/delete the number
outside the official Embedded Signup flow.

**b) The catch: sender ≠ recipient.**
The Cloud API **sends** messages *from* the registered number *to* a recipient. A
business-initiated alert (a complaint arriving) is **not** a reply within a 24-hour
window, so it needs an **approved message template**, and it must go **to a different
number** than the sender. **You cannot have the API send a template from
+91 93702 53998 to +91 93702 53998.** So, to get alerts on WhatsApp you need one of:

| Option | Sender number | Recipient (gets the alert) | Buy a number? |
|--------|---------------|----------------------------|---------------|
| 1 (recommended) | **+91 93702 53998** via Coexistence | a **second** staff/personal WhatsApp number | No |
| 2 | a **new** number on Cloud API | **+91 93702 53998** (untouched) | Yes |
| 3 (no WhatsApp API) | — | alerts by **email / Telegram** instead | No |

If the only number is 93702 53998 and it must be both sender and receiver, that is
**not possible** — a separate number is required for one end. Decide which end.

**c) Templates, verification, pricing.**
- You must create and get a **utility template** approved (e.g. *"New complaint
  {{1}} from {{2}}, category {{3}}"*). Approval is usually minutes to a day.
- **Business Verification** in Meta Business Manager is needed to lift the low
  unverified sending limit; you can start limited without it.
- **Pricing is per-message and changes often** (Meta moved to per-message pricing in
  2025). India **utility** template messages are cheap (fractions of a rupee each),
  and messages sent inside an open 24-hour customer window can be free — but **check
  Meta's current rate card**, don't trust a number I quote here.
- **Never put the Meta access token in the site.** It lives only in Make's WhatsApp
  connection (or the Worker as a secret). The static GitHub Pages site never holds it.

**Recommendation:** get **email + Make working and verified first**. Add WhatsApp as
Option 1 once you've picked the recipient number and had a template approved.

---

## 7. Test checklist — what I verified vs. what needs your accounts

I served the edited site locally and drove it in a browser.

| Test | Result | Notes |
|------|--------|-------|
| Empty required fields | ✅ **Passed** | Rejected with localized status, no network call |
| Invalid mobile (`123`) | ✅ **Passed** | Rejected in both Marathi and English |
| Marathi ⇄ English toggle | ✅ **Passed** | Whole site + status messages localize |
| Mobile layout | ✅ **Passed** | Form + error banner render cleanly at 375px |
| Success-before-success | ✅ **Passed** | Shows "Sending…", success only on real confirmation |
| Honeypot present & hidden | ✅ **Passed** | Off-screen, not shown to users |
| No JS blocks submit | ✅ **Verified** | Handler calls `preventDefault` then sends via fetch |
| Submit → **email arrives** | ⏳ **You** | Needs FormSubmit **activation** (see §8) + your inbox |
| Submit → **Make receives** | ⏳ **You** | Needs fresh webhook + Worker/Make URL in `RELAY_URL` |
| Duplicate submission | ⏳ **You** | Button-disable guard done client-side; add Make dedup (§4.5) |
| Spam / rate limit | ⏳ **You** | Honeypot done; enable KV rate limiting in Worker (§5.3) |
| WhatsApp alert | ⏳ **You** | After §6 template approval |

I did **not** fire a real valid submission, because it would send a live email to
your inbox (and FormSubmit isn't activated yet). Do the first real one yourself.

---

## 8. Remaining manual steps (yours)

1. **Activate FormSubmit:** submit one complaint, then open `rohitchute1610@gmail.com`
   and click the FormSubmit confirmation link **once**. Email won't work until you do.
2. **Generate a fresh Make webhook** (§4.1) — the old URL is compromised.
3. **Deploy the Worker** and set its secrets (§5), then set `RELAY_URL` in `index.html`.
4. **Build the Make scenario** (§4), turn it **ON**.
5. **Push to GitHub** (I can't push to your repo from here):
   ```bash
   git add index.html cloudflare-worker.js SETUP-AND-CHANGES.md
   git commit -m "Fix complaint delivery: dual-channel (FormSubmit AJAX + secure Make relay)"
   git push
   ```
6. **Decide the WhatsApp recipient number** (§6b) and get a template approved.
7. Run the ⏳ tests above end to end.

---

_Questions to confirm before going further: (1) which number should **receive**
WhatsApp alerts, given it can't be the same as the sender? (2) Worker route, or
direct-to-Make for now? (3) Keep email on `rohitchute1610@gmail.com` as you said —
confirmed, left unchanged._
