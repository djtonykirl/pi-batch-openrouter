# Web UI: Import Databricks Export and Download approved.jsonl, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the UC metadata pilot's Pi-side steps run entirely in the web UI.
- Import a Databricks export bundle (`tables.jsonl`, `context.md`, `manifest.json`) with its hashes verified.
- Download the reviewed `approved.jsonl`, together with the Databricks inbox path it belongs in.

**Architecture:**
- **A pure `src/metadata/bundle.ts`** checks a bundle against its manifest and works out where the files go. Two web endpoints reuse the server's existing workspace-write safety (containment, hard-deny, symlink refusal, no silent overwrite).
- **The UC Metadata studio tab** gains an import control that fills in its own fields.
- **The handoff card** gains a download button.
- **The web UI never contacts Databricks.** Files move by browser upload and download only. Governance SPEC rule: "Pi never connects to Databricks, never holds Databricks credentials".

**Tech Stack:** TypeScript ESM, node:test; `src/web/server.ts` and `src/web/ui.ts` (session cookie, Host/Origin/CSRF gates, CSP nonce, `data-action` delegated listeners, `escapeHtml`).

**Spec:**
- The governance SPEC, on branch `feature/27717199-uc-metadata-governance`: `DataBricks/Notebooks/UC_Metadata_Governance/contract/SPEC.md` in `C:\CODE\LighthouseModernization`, sections "Volume layout" and "Hashing and provenance".
- Companion plan: `…/UC_Metadata_Governance/design/2026-10-29-phase-b-tags-export-apply-plan.md` (Task 7 runbook).

## Global Constraints
- **Manifest shape** (from SPEC): `{run_id, domain_prefix, contract_version, files: [{path, sha256, bytes}], table_count, created_ts}`. File hashes are sha256 of the raw bytes. `context.md` and `tables.jsonl` are UTF-8 with LF and must never be re-encoded: write exactly the uploaded bytes.
- **Destination:** `metadata/<domain_prefix lowercased>/<run_id>/{tables.jsonl,context.md,manifest.json}` in the workspace.
  - `run_id` must match `^[A-Za-z0-9._-]{1,100}$`, and `domain_prefix` must match `^[A-Z0-9]{4}$`. Anything else is refused.
  - An existing destination file is refused unless `overwrite` is true.
- **Databricks inbox path** (shown to the user, never contacted): `/Volumes/<catalog>/lighthouse_governance/metadata/inbox/<domain_prefix>/<run_id>/approved.jsonl`.
  - `<catalog>` is not in the manifest, so the UI shows it as `<catalog>` with a text field, remembered per browser in localStorage.
- **Size limits:** each file must be at most `workflows.maxDatasetBytes`. The bundle must have exactly the three files named in the manifest; unknown or missing files are refused.
- **Web security:** new routes sit behind the existing gates, with no inline handlers, and all server text goes through `escapeHtml`/`textContent`. Downloads go through workspace containment (`resolveWorkspaceInput`), are `.jsonl` only, and are sent with `Content-Disposition: attachment`.
- **Error text never echoes file contents.**

## Review Focus
1. **A manifest hash mismatch** (the file was changed or re-encoded, for example CRLF): refused, naming the file. Nothing is written. *Test in Task 1.*
2. **Re-importing the same run:** refused without overwrite; with overwrite, all three files are replaced together, or none if one fails. *Test in Task 2.*
3. **A crafted `run_id` or `domain_prefix`** (`../x`, `PNPT/../`): refused before any path is built. *Test in Task 1.*
4. **Downloading a file outside the workspace, or not a `.jsonl`:** 400. *Test in Task 2.*
5. **Imported paths filled into the UC Metadata tab:** a dry run with them succeeds with no manual edits apart from domain, prefix and model. *Test in Task 3.*

---

### Task 1: The pure bundle check

**Files:**
- Create `src/metadata/bundle.ts`.
- Create `test/metadata-bundle.test.ts`.

**Interfaces, produced:**
- `interface BundleManifest { run_id: string; domain_prefix: string; contract_version: string; files: Array<{ path: string; sha256: string; bytes: number }>; table_count: number; created_ts: string }`
- `checkBundle(files: Array<{ name: string; bytes: Buffer }>, opts: { maxBytes: number }) -> { ok: true; manifest: BundleManifest; dest: string; writes: Array<{ relPath: string; bytes: Buffer }> } | { ok: false; problems: string[] }`
  - It parses `manifest.json` from the uploaded files.
  - It requires exactly `tables.jsonl` and `context.md`, compared on base name. The manifest's `path` may include folders; compare base names.
  - It checks the bytes and sha256 of each file against the manifest, and the ID patterns.
  - `dest` = `metadata/<prefix lower>/<run_id>`.
  - `writes` lists all three files, the manifest included.
- `inboxPath(manifest: BundleManifest, catalog: string) -> string`

- [ ] **Step 1: Tests.**
  - A valid bundle (fixture built in the test with real sha256) gives `ok` and the exact `dest`/`writes`.
  - A one-byte change in `context.md` gives a problem naming `context.md` and containing no content.
  - CRLF re-encoding of `tables.jsonl` is caught as a mismatch.
  - A missing `context.md`, or an extra file, is refused.
  - `run_id` `../x` and `domain_prefix` `PNPT_` or `pn pt` are refused.
  - A file larger than `maxBytes` is refused.
  - `inboxPath` gives `/Volumes/uc_dev_global_rnd_mdip_01/lighthouse_governance/metadata/inbox/PNPT/r1/approved.jsonl`.

  Run them; expected FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Run `npx tsc -p tsconfig.test.json && node --test .test-build/test/metadata-bundle.test.js`. Expected: PASS. Commit `feat(metadata): verify Databricks export bundles against their manifest`.

### Task 2: Endpoints

**Files:**
- Modify `src/web/server.ts`.
- Create `test/metadata-bundle-web.test.ts`.

**Interfaces, produced:**
- `POST /api/metadata/import-bundle`, with body `{ files: UploadedFileInput[]; overwrite?: boolean }`. Files are base64 (`contentBase64`), decoded to exact bytes and never converted to text.
  - It runs `checkBundle`. It then writes all three files using the same safety checks as `/api/workspace/write-file`. Factor that logic into a shared helper rather than copying it.
  - The write is all or nothing: check every destination first, then write each to a temporary file and rename.
  - Response `201 { dest, contextPath, inputPath, manifest: { run_id, domain_prefix, contract_version, table_count } }`; `400 { error, problems }` on refusal; `409` when files exist and `overwrite` is not true.
- `GET /api/metadata/approved-file?path=<rel>`: workspace-contained, `.jsonl` only, sent as an attachment with the exact bytes.

- [ ] **Step 1: Tests.**
  - Both routes return 401 without a session, and 403 for a foreign Origin.
  - An import writes exactly the uploaded bytes (byte comparison, LF kept).
  - A re-import gives 409; with `overwrite`, all three files are replaced.
  - A hash mismatch writes nothing.
  - Download of `metadata/pnpt/r1/approved.jsonl` returns its bytes with an attachment header.
  - `../outside.jsonl` and `x.md` give 400.

  Run them; expected FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Run `npm test` and `npm run check`. Commit `feat(web): import Databricks export bundles and download approved.jsonl`.

### Task 3: UI

**Files:**
- Modify `src/web/ui.ts`.
- Modify `README.md`.
- Test: extend `test/metadata-bundle-web.test.ts`.

- [ ] **Step 1: The UC Metadata studio tab** gets an **Import Databricks export** button.
  - It opens a file input for multiple files and reads them as base64.
  - It posts them to `/api/metadata/import-bundle`.
  - On a 409, it asks with an in-page confirm (no `window.confirm`) whether to overwrite, and retries.
  - On success, it fills the Context and Tables fields with `contextPath` and `inputPath`, shows "Imported run <run_id> (<table_count> tables, contract v<contract_version>)", and sets the UC prefix field to `<domain_prefix>_` when it's empty.
- [ ] **Step 2: The metadata handoff card** gets a **Download approved.jsonl** button.
  - It's enabled once the approved-file path field points to an existing file. It uses `GET /api/metadata/approved-file`.
  - Beside it, a "Databricks inbox" line shows `inboxPath`, with a `<catalog>` text field remembered in localStorage (wrapped in try/catch).
  - `run_id` and `domain_prefix` come from the `manifest.json` next to the job's context file (read through a new small `GET /api/metadata/bundle-info?contextPath=` that returns the manifest's IDs, or none). When there's no manifest, the line explains how to find the path.
- [ ] **Step 3: Tests.**
  - The page contains both controls, wired by `data-action`.
  - `bundle-info` returns the IDs for an imported bundle and `{}` otherwise.
  - A dry run of `/api/jobs/metadata` using the imported paths returns no blockers. Use the governance contract's v1 fixture as `tables.jsonl`.
- [ ] **Step 4: README.** In the metadata section, add "Working with the Databricks governance pipeline": import the export, then plan, review and approve, then download `approved.jsonl`, then upload it to the inbox. Add one line on the "never contacts Databricks" rule.
- [ ] **Step 5:** Run `npm test` and `npm run check`. Commit `feat(web): Import Databricks export and Download approved.jsonl in the UC Metadata flow`.
- [ ] **Manual check:**
  - Import a bundle produced by the governance export (or the contract fixtures) in the browser.
  - Dry-run.
  - On a finished job, download `approved.jsonl`, and confirm the inbox path is shown.
