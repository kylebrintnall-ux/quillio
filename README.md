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
   ├─▶ (≤3s) "Brief received — building your doc now."   ◀── immediate ack
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
  google.js              Service-account auth → Drive/Docs/Sheets clients
  workflow.js            Orchestrates the async pipeline
  services/
    gemini.js            Brief parsing + per-field draft generation
    sheets.js            Reads & groups the asset spec Sheet
    docBuilder.js        Builds the Docs batchUpdate (text + styling)
    docs.js              Creates the doc; stateless draft insertion
    slack.js             Block Kit message + Slack posting helpers
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key. Create one at <https://aistudio.google.com/app/apikey>. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✅ | The **full JSON** of a Google Cloud service-account key, as a single-line string. |
| `PORT` | ✅ | HTTP port. Railway sets this automatically; defaults to `3000` locally. |
| `GEMINI_MODEL` | ⬜ | Gemini model id. Defaults to `gemini-2.5-flash`. |
| `SHEET_ID` | ⬜ | Asset specs Sheet. Defaults to `1skbkkKlHMDUzeG8_bFpcSjrvweumivePuSOvr5qIfqk`. |
| `DRIVE_FOLDER_ID` | ⬜ | Folder docs are created in. Defaults to `1gdf5-R3J8IGY1I5pJJj2O-KFOju0UsqU`. |
| `SLACK_WEBHOOK_URL` | ✅ | Incoming webhook the Block Kit result is posted to. It's a secret, so it isn't baked into the code. |
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

### 2. Share the Sheet and Drive folder with the service account

The service account is a distinct Google identity — it can only see what's
shared with it.

- Open the **asset specs Sheet** → **Share** → paste the service account
  `client_email` → give it **Viewer** access.
- Open the **Drive folder** → **Share** → paste the same email → give it
  **Editor** access (it needs to create docs inside the folder).

> If the folder lives in a **Shared Drive**, add the service account as a member
> of that Shared Drive instead.

### 3. Get a Gemini API key

Create one at <https://aistudio.google.com/app/apikey> and set `GEMINI_API_KEY`.

### 4. Configure the Slack app

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
   full JSON), and `SLACK_WEBHOOK_URL`. `PORT` is injected by Railway
   automatically. Add any optional overrides you need.
4. Deploy, then open **Settings → Networking → Generate Domain** to get the
   public URL.
5. Put that domain into the Slack app's slash-command and interactivity Request
   URLs (`/slack/command` and `/slack/interactions`).

## License

MIT
