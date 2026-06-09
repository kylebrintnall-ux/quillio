# Quillio

Turn briefs into docs in seconds.

Quillio is a Slack workflow tool. You fire a slash command with a campaign
brief, and it builds a formatted Google Doc — campaign summary, writer
direction, and a fully scaffolded section for every requested asset — then posts
it back to Slack with one-click actions to open the doc or generate first-draft
copy.

## How it works

```
/quillio [brief]
   │
   ├─▶ (≤3s) ":quillio-scroll: Building your document…"   ◀── immediate ack
   │
   └─▶ (async, ~7s+)
         1. Gemini parses the brief → { summary, writerPrompt, assets }
         2. Read asset specs from the Google Sheet, filtered to those assets
         3. Create a formatted Google Doc in the Drive folder
         4. Post a Block Kit message: title, asset list,
            [Open in Drive] [Generate First Draft] [Skip]

[Generate First Draft]
   └─▶ Gemini drafts copy per field and inserts it under each label,
       then confirms back to Slack.
```

### Why Node, not Apps Script

Slack slash commands **must** get an HTTP response within 3 seconds, but the
full workflow (Gemini + Sheets + Docs + Slack) takes 7+ seconds. Google Apps
Script can't return early and keep working — `doPost` only "responds" when the
function returns. This app sends Slack its `200` acknowledgment **first**, then
runs the workflow asynchronously after the response is flushed. That single
requirement is the reason this lives in Node/Express. See
`src/server.js` — the ack is sent before `runBriefWorkflow()` is ever called.

## Project layout

```
src/
  server.js              Express app; ack-first slash command + interactions
  config.js              Env vars and baked-in IDs/URLs
  google.js              Auth → Drive/Docs/Sheets clients (service account +
                         optional OAuth2 for writes)
  workflow.js            Orchestrates the async pipeline (destination-agnostic)
  services/
    gemini.js            Brief parsing + per-field draft generation
    sheets.js            Reads & groups the asset spec Sheet
    slack.js             Block Kit message + Slack posting helpers
  destinations/          Output adapters — where the brief gets written
    index.js             Registry; selects the adapter via DESTINATION
    googleDocs.js        Google Docs adapter (create + stateless draft)
    docBuilder.js        Builds the Docs batchUpdate (text + styling)
```

### Adding a new destination

`workflow.js` never touches a Google API directly — it calls
`getDestination().createDocument(...)` / `.generateDraft(...)`. To add Notion,
OneDrive, etc.: write `src/destinations/<name>.js` exporting
`{ name, createDocument({ brief, summary, writerPrompt, assetSpecs }) → { id, url, title }, generateDraft(id) → { title, fieldCount } }`,
register it in `destinations/index.js`, and select it with the `DESTINATION`
env var. No workflow changes required.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key. Create one at <https://aistudio.google.com/app/apikey>. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✅ | The **full JSON** of a Google Cloud service-account key, as a single-line string. Always used to read the Sheet. |
| `PORT` | ✅ | HTTP port. Railway sets this automatically; defaults to `3000` locally. |
| `SLACK_WEBHOOK_URL` | ✅ | Incoming webhook the Block Kit result is posted to. It's a secret, so it isn't baked into the code. |
| `GOOGLE_CLIENT_ID` | ⬜ | OAuth2 client ID. Required only if using OAuth2 for Drive/Docs writes. |
| `GOOGLE_CLIENT_SECRET` | ⬜ | OAuth2 client secret. Required only if using OAuth2 for Drive/Docs writes. |
| `GOOGLE_REFRESH_TOKEN` | ⬜ | OAuth2 refresh token. **If set, all Drive/Docs writes run as this OAuth2 user** instead of the service account (the personal-Gmail path). If unset, the service account does the writes. |
| `DESTINATION` | ⬜ | Output adapter id. Defaults to `google-docs`. |
| `GEMINI_MODEL` | ⬜ | Gemini model id. Defaults to `gemini-2.5-flash`. |
| `SHEET_ID` | ⬜ | Asset specs Sheet. Defaults to `1sdYw1NQ27OYeCaVCHRN50xVVbQoTnDvn5cZXag34Aw4`. |
| `DRIVE_FOLDER_ID` | ⬜ | Folder docs are created in. Defaults to `1gdf5-R3J8IGY1I5pJJj2O-KFOju0UsqU`. |
| `SLACK_SIGNING_SECRET` | ⬜ | If set, every incoming Slack request is signature-verified. |

See `.env.example` for a copy-paste template.

## The asset spec Sheet

The Sheet at `SHEET_ID` must have a header row with these columns (order
doesn't matter, names are matched case-insensitively):

`Asset Type` · `Channel` · `Field Name` · `Character Limit` · `Notes` ·
`Funnel Stage` · `Tone Notes`

One row per field. Rows are grouped by **Asset Type** to form each section of
the doc. Gemini may only choose assets from this fixed list:

- Display Banner
- Organic Social
- Dynamic Email
- Sales Basho
- Form Confirm Page
- Paid Social - LinkedIn
- Paid Social - Meta
- Paid Social - Twitter/X

## Setup

### 1. Create a Google Cloud service account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or pick) a project.
2. Enable the **Google Drive API**, **Google Docs API**, and **Google Sheets
   API** for that project (APIs & Services → Library).
3. Go to **APIs & Services → Credentials → Create Credentials → Service
   account**. Give it a name and create it.
4. Open the service account → **Keys → Add Key → Create new key → JSON**.
   Download the file.
5. The downloaded JSON contains a `client_email` like
   `quillio@your-project.iam.gserviceaccount.com`. **Copy that email** — you'll
   share resources with it next.
6. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the entire contents of the JSON file
   (one line). Locally you can do:

   ```bash
   GOOGLE_SERVICE_ACCOUNT_JSON=$(cat service-account.json | tr -d '\n')
   ```

### 2. Share the Sheet, and pick how docs get written

The service account is a distinct Google identity — it can only see what's
shared with it. **Always** share the Sheet with it:

- Open the **asset specs Sheet** → **Share** → paste the service account
  `client_email` → give it **Viewer** access.

Then choose **one** path for *writing* the docs:

**Path A — OAuth2 (personal Gmail).** A service account has essentially no
personal ("My Drive") storage quota, so a doc it *owns* fails to create with
`storageQuotaExceeded`. To write into a personal Gmail Drive, authenticate the
Drive/Docs writes as a real user via OAuth2 (step 3). `DRIVE_FOLDER_ID` is then
a normal My Drive folder owned by that user. **This is the path for
`kyle.brintnall@gmail.com`.**

**Path B — Service account + Shared Drive (Google Workspace).** Put
`DRIVE_FOLDER_ID`'s folder on a **Shared Drive** and add the service account as
a member (**Content Manager**). Files in a Shared Drive are owned by the drive,
not the service account, so they don't touch its quota. Leave the OAuth2 vars
unset and the service account does the writes. (Requires Workspace; Shared
Drives don't exist on personal Gmail.)

### 3. (Path A only) Generate an OAuth2 refresh token

This mints the `GOOGLE_REFRESH_TOKEN` that lets Quillio write docs as a real
user. Done once.

1. **Create an OAuth client.** Google Cloud Console → **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**. If prompted, configure
   the **OAuth consent screen** first (External; add your Gmail as a **Test
   user**). Choose application type **Web application** and add
   `https://developers.google.com/oauthplayground` as an **Authorized redirect
   URI**. Save the **Client ID** and **Client secret**.
2. Open the **OAuth2 Playground**: <https://developers.google.com/oauthplayground>.
3. Click the **⚙️ gear** (top right) → check **Use your own OAuth credentials**
   → paste your Client ID and Client secret.
4. In **Step 1** (left panel), paste these scopes into the "Input your own
   scopes" box and click **Authorize APIs**:

   ```
   https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents
   ```

5. Sign in **as the account that should own the docs** (e.g.
   `kyle.brintnall@gmail.com`) and grant access.
6. In **Step 2**, click **Exchange authorization code for tokens**. The token
   exchange hits `https://oauth2.googleapis.com/token`. Copy the
   **Refresh token**.
7. Set the three env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `GOOGLE_REFRESH_TOKEN`.

> **Keep the consent screen out of "Testing" long-term.** While the OAuth app is
> in *Testing*, refresh tokens for external users expire after ~7 days. Either
> **Publish** the consent screen (status → *In production*) so the refresh token
> is long-lived, or be prepared to re-mint it. Tokens are also invalidated if
> you revoke access or change the client secret.

### 4. Get a Gemini API key

Create one at <https://aistudio.google.com/app/apikey> and set `GEMINI_API_KEY`.

### 5. Configure the Slack app

1. Create a Slack app at <https://api.slack.com/apps>.
2. **Slash Commands → Create New Command**: command `/quillio`, Request URL
   `https://<your-railway-domain>/slack/command`.
3. **Interactivity & Shortcuts → On**, Request URL
   `https://<your-railway-domain>/slack/interactions`.
4. **Incoming Webhooks → On**, add a webhook to the target channel and set
   `SLACK_WEBHOOK_URL`.
5. (Optional) Copy the app's **Signing Secret** into `SLACK_SIGNING_SECRET` to
   enable request verification.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in the values
node --env-file=.env src/server.js
```

To exercise the Slack endpoints locally, expose the port with a tunnel (e.g.
`ngrok http 3000`) and point the Slack app's Request URLs at the tunnel.

## Deploy on Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app/), **New Project → Deploy from GitHub repo**
   and pick this repo. Nixpacks detects Node and runs `npm start`
   (also pinned in `railway.json` / `Procfile`).
3. **Variables**: add `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON` (paste the
   full JSON), and `SLACK_WEBHOOK_URL`. For the personal-Gmail (OAuth2) path,
   also add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `GOOGLE_REFRESH_TOKEN`. `PORT` is injected by Railway automatically. Add any
   optional overrides you need.
4. Deploy, then open **Settings → Networking → Generate Domain** to get the
   public URL.
5. Put that domain into the Slack app's slash-command and interactivity Request
   URLs (`/slack/command` and `/slack/interactions`).

## License

MIT
