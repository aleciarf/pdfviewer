# PDF Flip: shared Tags and Notes in GitHub

Destination: **aleciarf/pdfviewer**, file **shared-notes.json**.
GitHub stores the universal tags/notes. Cloudflare Worker is only the bridge that keeps the GitHub write token secret; it has no database.

Everyone can read published tags/notes. Anyone signed in to PDF Flip with Google can edit them. Drawings, PDFs and other private library data continue to use each user's Drive.

## 1. Create a GitHub token

Open https://github.com/settings/personal-access-tokens/new

- Choose the resource owner that owns **aleciarf/pdfviewer**.
- Repository access: **Only select repositories → pdfviewer**.
- Repository permissions: **Contents → Read and write**. Leave unrelated permissions disabled.
- Choose an expiration and generate the token.
- Keep it private. Enter it only as a Cloudflare encrypted secret in step 3. Do not put it in HTML, GitHub files, or chat.

If the repository belongs to an organization, approval may be required by that organization. A protected default branch must allow the token holder to create/update this data file, or use a dedicated data branch and set GITHUB_BRANCH accordingly.

## 2. Create the Cloudflare Worker

In Cloudflare, open **Workers & Pages → Create application → Create Worker** (the dashboard may offer **Start with Hello World**).

- Name: `pdf-flip-notes`.
- Deploy the initial Worker.
- Open **Edit code** and replace the starter code with **worker.js** from this folder.
- Click **Deploy**.

Do NOT upload worker.js as your Pages index.html. The Worker and your existing Pages site are separate applications.

## 3. Set the Worker secret

In the Worker's **Settings → Variables and Secrets**, add:

| Type | Name | Value |
| --- | --- | --- |
| Secret | GITHUB_TOKEN | The token from step 1 |

Optional plain-text variables:

- ALLOWED_ORIGIN: `https://pdf-flip.pages.dev` (already the default).
- GITHUB_BRANCH: leave unset to use the repository's default branch. If set, it must be an existing branch.

Save/deploy the settings. No Google client secret is needed. The existing PDF Flip Client ID is already in worker.js.

## 4. Connect PDF Flip

Copy the Worker's address, for example `https://pdf-flip-notes.YOUR-SUBDOMAIN.workers.dev`.

For a quick test on your own browser:

- Upload the included **index.html** to the PDF Flip Pages site.
- Open the account popup → More options → Site setup.
- Paste the Worker address into **Shared notes connection** and click **Save shared connection**.

For ALL visitors without setup:

- Send the Worker address back to Codex, so it can be embedded in the HTML.
- Or edit the public `SHARED_NOTES_API` constant in index.html to this address, then upload it to Pages.
- This address is public and contains no secret.

## 5. Test

1. Sign in to Google in PDF Flip.
2. Open a Drive-backed PDF. Add a tag and a short note. Wait a few seconds.
3. Confirm **shared-notes.json** appears in aleciarf/pdfviewer. You do not need to create it manually.
4. Open the same PDF in a second browser/account. The same tags and notes should appear. Shared updates refresh every 30 seconds or when returning to the tab.
5. Make drawings. Confirm they stay in your private Drive library.json and do not appear in shared-notes.json.

All users must open the same underlying Drive PDF (same Drive file ID). Separately uploaded copies have different identities and different shared notes. New local PDFs can be annotated publicly after their first Drive upload.

Existing private Tags/Notes are not silently published. Their old copies stay in your device/old private Drive revisions; shared fields start from shared-notes.json. Copy any old text you want to publish into the new shared fields explicitly.

## How autosave and conflicts work

- Tags/notes save after 2.5 seconds of inactivity, reducing GitHub commits.
- Drafts survive reloads on the same browser/account when storage is available.
- GitHub SHA checks retry simultaneous updates without overwriting unrelated pages.
- Different fields on the same page can merge automatically.
- If two people edit the same field, choose **Review changes → Use shared version** or **Publish my draft**.
- This is shared autosave with periodic refresh, not a live collaborative text editor.
- GitHub rate limits and token expiry can delay saving. The app keeps drafts and displays the error.
- Shared notes are public, including in Git history if this repository is public. Removing text from the current JSON does not remove it from old commits.

## Files in this package

- index.html: updated PDF Flip client (Worker address still to be configured).
- worker.js: Cloudflare Worker to copy into the Worker's editor.
- policy.html and terms.html: existing legal pages; policy now mentions public shared Tags/Notes and the Worker bridge.
- SETUP.md: these instructions.

Prepared code has been tested with mocked GitHub/Google services. It has not been deployed or tested against your live accounts.
