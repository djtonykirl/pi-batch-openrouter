/**
 * Self-contained Single-Page Web UI for pi-batch-openrouter.
 * Served locally from 127.0.0.1 with an injected per-session CSRF token.
 */

export function renderWebUiHtml(opts: { csrfToken: string; workspaceRoot: string; nonce?: string }): string {
  const nonceAttr = (opts.nonce ?? "").replace(/[^A-Za-z0-9+/=_-]/g, "");
  // JSON inside <script>: "<" is escaped so a value can never close the script element (e.g. a folder named
  // "</script>"), and U+2028/U+2029 so it stays one JavaScript string literal.
  const scriptJson = (v: unknown) =>
    JSON.stringify(v)
      .replace(/</g, "\\u003c")
      .split(String.fromCharCode(0x2028)).join("\\u2028")
      .split(String.fromCharCode(0x2029)).join("\\u2029");
  const tokenJson = scriptJson(opts.csrfToken);
  const rootJson = scriptJson(opts.workspaceRoot);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Batch OpenRouter — Local Studio</title>
  <style>
    :root {
      --bg: #0f1117;
      --bg-panel: #161922;
      --bg-elevated: #1e2230;
      --bg-hover: #262b3d;
      --border: #2b3145;
      --text: #e6e9f2;
      --text-muted: #949cb3;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --info: #38bdf8;
      --mono: "JetBrains Mono", Consolas, Menlo, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    button, input, select, textarea {
      font-family: inherit;
      font-size: 13px;
      color: var(--text);
    }
    .topbar {
      height: 52px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      flex-shrink: 0;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 15px;
    }
    .workspace-pill {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg-elevated);
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }
    .workspace-pill:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .nav-tabs {
      display: flex;
      gap: 6px;
    }
    .nav-tab {
      background: transparent;
      border: 1px solid transparent;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-muted);
      font-weight: 500;
    }
    .nav-tab:hover { background: var(--bg-hover); color: var(--text); }
    .nav-tab.active {
      background: var(--bg-elevated);
      border-color: var(--accent);
      color: var(--text);
    }
    .topbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge-pill {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.16);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #c7d2fe;
    }
    .btn {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
      transition: background 0.12s;
    }
    .btn:hover:not(:disabled) { background: var(--bg-hover); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-sm { padding: 4px 8px; font-size: 12px; }
    .btn-danger { border-color: rgba(239, 68, 68, 0.5); color: #fca5a5; }

    .main-view {
      flex: 1;
      display: none;
      overflow: hidden;
    }
    .main-view.active { display: flex; }

    /* Layout columns */
    .sidebar {
      width: 300px;
      background: var(--bg-panel);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .sidebar-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .list-item {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .list-item:hover { background: var(--bg-hover); }
    .list-item.selected {
      background: var(--bg-elevated);
      border-color: var(--accent);
    }
    .list-item-title {
      font-weight: 600;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-item-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .status-dot {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-ready, .status-completed { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; }
    .status-polling, .status-submitted, .status-submitting, .status-validating, .status-in_progress, .status-finalizing, .status-waiting {
      background: rgba(245, 158, 11, 0.18); color: #fcd34d;
    }
    .status-partial, .status-compacting, .status-previewed {
      background: rgba(56, 189, 248, 0.18); color: #7dd3fc;
    }
    .status-failed, .status-corrupt, .status-expired {
      background: rgba(239, 68, 68, 0.18); color: #fca5a5;
    }
    .status-cancelled, .status-draft {
      background: rgba(148, 156, 179, 0.15); color: var(--text-muted);
    }

    .content-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }
    .pane-header {
      padding: 12px 18px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .context-meter {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .meter-bar {
      width: 110px;
      height: 7px;
      background: var(--bg-elevated);
      border-radius: 99px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .meter-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.2s;
    }

    /* Chat messages */
    .chat-stream {
      flex: 1;
      overflow-y: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .msg-card {
      max-width: 860px;
      border-radius: 10px;
      padding: 12px 16px;
      border: 1px solid var(--border);
      background: var(--bg-panel);
    }
    .msg-user {
      align-self: flex-end;
      background: #1b2034;
      border-color: #313a5e;
      min-width: 280px;
    }
    .msg-assistant {
      align-self: flex-start;
      background: var(--bg-panel);
      width: 100%;
    }
    .msg-event {
      align-self: center;
      font-size: 12px;
      color: var(--text-muted);
      background: var(--bg-elevated);
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
    }
    .msg-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .msg-body {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 14px;
    }
    .msg-body pre {
      background: #0b0d13;
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 12px;
    }
    .msg-body code {
      font-family: var(--mono);
      background: rgba(255,255,255,0.06);
      padding: 1px 4px;
      border-radius: 4px;
    }
    .att-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .att-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-family: var(--mono);
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: #c7d2fe;
    }
    .att-chip button {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0 2px;
    }
    .att-chip button:hover { color: var(--danger); }

    .inflight-banner {
      margin: 0 18px 10px;
      padding: 10px 14px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.35);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
    }

    /* Composer */
    .composer {
      padding: 12px 18px 16px;
      background: var(--bg-panel);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .composer.dragover {
      outline: 2px dashed var(--accent);
      background: rgba(99, 102, 241, 0.08);
    }
    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .composer-row {
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }
    .composer textarea {
      flex: 1;
      min-height: 68px;
      max-height: 220px;
      resize: vertical;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      outline: none;
    }
    .composer textarea:focus { border-color: var(--accent); }

    /* Inputs & Tables */
    input[type="text"], input[type="number"], select, textarea.form-control {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      outline: none;
    }
    input[type="text"]:focus, select:focus, textarea.form-control:focus {
      border-color: var(--accent);
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th, .data-table td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    .data-table th {
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .kv-grid {
      display: grid;
      grid-template-columns: 170px 1fr;
      gap: 6px 12px;
      font-size: 13px;
    }
    .kv-label { color: var(--text-muted); }
    .kv-val { font-family: var(--mono); font-size: 12px; word-break: break-all; }

    /* Modals */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 20px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 820px;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    .modal-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 15px;
    }
    .modal-body {
      padding: 16px 18px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .modal-footer {
      padding: 12px 18px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .alert-box {
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 12px;
      white-space: pre-wrap;
    }
    .alert-danger { background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4); color: #fecaca; }
    .alert-warning { background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.4); color: #fde68a; }
    .alert-success { background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.4); color: #a7f3d0; }

    .toast-container {
      position: fixed;
      bottom: 18px;
      right: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 200;
    }
    .toast {
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--bg-elevated);
      border: 1px solid var(--accent);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      font-size: 13px;
      max-width: 380px;
    }
    iframe.artifact-frame {
      width: 100%;
      height: 520px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fff;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span>📦 Pi Batch OpenRouter</span>
      <span class="workspace-pill" id="workspacePill"></span>
    </div>
    <nav class="nav-tabs">
      <button class="nav-tab active" data-tab="chat">💬 Batch Chat</button>
      <button class="nav-tab" data-tab="jobs">📦 Batch Jobs & Studio</button>
      <button class="nav-tab" data-tab="workspace">📁 Workspace & Settings</button>
    </nav>
    <div class="topbar-right">
      <span class="badge-pill" id="badgePill">Idle</span>
      <button class="btn btn-sm" id="pollAllBtn" title="Poll OpenRouter now for all active batch jobs">🔄 Poll Now</button>
      <button class="btn btn-sm btn-primary" id="newJobTopBtn">＋ New Batch Job</button>
    </div>
  </header>

  <!-- ==================== TAB 1: BATCH CHAT ==================== -->
  <section class="main-view active" id="view-chat">
    <aside class="sidebar">
      <div class="sidebar-header">
        <strong>Chat Threads</strong>
        <button class="btn btn-sm btn-primary" id="newThreadBtn">＋ New Thread</button>
      </div>
      <div style="padding: 8px 12px 0;">
        <input type="text" id="threadSearchInput" placeholder="Filter threads…" style="width: 100%;">
      </div>
      <div class="sidebar-list" id="threadList"></div>
    </aside>

    <div class="content-pane" id="chatContentPane">
      <div class="pane-header" id="chatHeader" style="display:none;">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <strong id="chatThreadTitle" style="font-size:15px;"></strong>
          <button class="btn btn-sm" id="renameThreadBtn" title="Rename thread">✏️</button>
          <span style="font-family:var(--mono); font-size:11px; color:var(--text-muted);" id="chatThreadId"></span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <label style="font-size:12px; color:var(--text-muted);">Model:</label>
          <input type="text" id="chatModelInput" list="knownModelsList" style="width:220px; font-family:var(--mono); font-size:12px;">
          <button class="btn btn-sm" id="setChatModelBtn">Set</button>
          <span class="badge-pill" id="chatPrivacyBadge" style="display:none;"></span>
          <select id="threadPrivacyLevel" title="Raise this thread's privacy level. Lowering is disabled: a thread cannot go below the project level or its own raised level." style="font-size:12px; padding:3px 6px;">
            <option value="standard">standard</option>
            <option value="no-training">no-training</option>
            <option value="zdr">zdr</option>
          </select>
          <div class="context-meter" title="Estimated next request size vs auto-compact threshold">
            <span id="contextMeterText">0 tok</span>
            <div class="meter-bar"><div class="meter-fill" id="contextMeterFill" style="width:0%"></div></div>
          </div>
          <button class="btn btn-sm" id="compactThreadBtn" title="Summarise earlier exchanges via batch compaction">🗜️ Compact</button>
          <button class="btn btn-sm" id="exportThreadBtn" title="Download Markdown transcript">⬇️ Export .md</button>
        </div>
      </div>

      <div id="chatModelPickerBar" style="display:none; padding:6px 16px; gap:10px; align-items:center; flex-wrap:wrap; border-bottom:1px solid var(--border); font-size:12px;">
        <label style="color:var(--text-muted);">Pick a model:</label>
        <select id="chatModelPicker" style="max-width:320px; font-family:var(--mono); font-size:12px;"></select>
        <label style="color:var(--text-muted); display:flex; align-items:center; gap:4px;"><input type="checkbox" id="show-blocked-toggle"> Show blocked</label>
        <button class="btn btn-sm" id="refresh-models-chat" title="Reload the model list and ZDR providers from OpenRouter">Refresh models</button>
        <span style="color:var(--text-muted);" id="chatCatalogState"></span>
      </div>
      <div id="chatModelAlert" style="padding:0 16px;"></div>

      <div class="chat-stream" id="chatStream">
        <div style="margin:auto; text-align:center; color:var(--text-muted);">
          <p>Select a chat thread or click <strong>＋ New Thread</strong> to start an asynchronous conversation with an OpenRouter batch model.</p>
        </div>
      </div>

      <div id="chatInflightContainer"></div>

      <div class="composer" id="chatComposer" style="display:none;">
        <div class="composer-toolbar">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-sm" id="openWorkspacePickerChatBtn">📁 Attach Workspace Files / Folder</button>
            <label class="btn btn-sm" style="cursor:pointer;">
              📎 Upload File / PDF / Image
              <input type="file" id="chatUploadInput" multiple style="display:none;">
            </label>
            <select id="chatPdfModeSelect" title="How attached PDFs are sent to OpenRouter" style="font-size:12px; padding:3px 6px;">
              <option value="text">PDF Mode: Extract Text Locally (all models)</option>
              <option value="multimodal">PDF Mode: Multimodal File Part (vision/PDF models)</option>
            </select>
            <button class="btn btn-sm" id="preflightChatBtn" title="Run secret scan and size check on message + attachments">🛡️ Verify & Scan</button>
          </div>
          <span style="font-size:11px; color:var(--text-muted);" id="chatComposerHint">Drag & drop text, code, CSV, JSON, PDF, or images here</span>
        </div>
        <div class="att-list" id="chatPendingAttachments"></div>
        <div id="chatPreflightAlert"></div>
        <div class="composer-row">
          <textarea id="chatMessageInput" placeholder="Type a message for the batch model… (Ctrl+Enter to send. If a turn is already pending, your message queues automatically)"></textarea>
          <button class="btn btn-primary" id="sendChatBtn" style="height:42px; padding:0 18px;">Send Batch Turn</button>
        </div>
      </div>
    </div>
  </section>

  <!-- ==================== TAB 2: BATCH JOBS & STUDIO ==================== -->
  <section class="main-view" id="view-jobs">
    <aside class="sidebar" style="width: 350px;">
      <div class="sidebar-header">
        <strong>Batch Jobs (.pi/batches)</strong>
        <select id="jobStatusFilter" style="font-size:12px; padding:3px 6px;">
          <option value="all">All Jobs</option>
          <option value="active">Active</option>
          <option value="ready">Ready</option>
          <option value="partial">Partial</option>
          <option value="failed">Failed / Corrupt</option>
          <option value="goal">Goals (Ask)</option>
          <option value="workflow">Workflows</option>
          <option value="chat">Chat Turns</option>
        </select>
      </div>
      <div class="sidebar-list" id="jobList"></div>
    </aside>

    <div class="content-pane" id="jobDetailPane">
      <div style="margin:auto; text-align:center; color:var(--text-muted);">
        <p>Select a batch job from the left or click <strong>＋ New Batch Job</strong> to create a Goal, Map-Files, or Dataset batch.</p>
      </div>
    </div>
  </section>

  <!-- ==================== TAB 3: WORKSPACE & SETTINGS ==================== -->
  <section class="main-view" id="view-workspace">
    <div class="content-pane" style="overflow-y:auto; padding:24px; gap:24px;">
      <div style="max-width:960px; display:flex; flex-direction:column; gap:24px;">
        <div class="msg-card">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <h3 style="margin:0 0 4px 0;">📂 Active Project Workspace</h3>
              <div style="font-family:var(--mono); font-size:13px; color:#a5b4fc;" id="settingsActiveWorkspacePath"></div>
            </div>
            <button class="btn btn-primary" id="openSwitchWorkspaceSettingsBtn">📁 Switch Workspace Folder…</button>
          </div>
        </div>

        <div class="msg-card">
          <h3 style="margin-top:0;">🔒 Privacy</h3>
          <p style="font-size:12px; color:var(--text-muted); margin-top:0;">
            The level only tightens what this extension sends. OpenRouter's own logging and training settings are controlled in your account at
            <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer" style="color:#a5b4fc;">openrouter.ai/settings/privacy</a>; the extension cannot check them.
          </p>
          <div id="privacyNotice" style="display:none;"></div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
            <label for="privacy-level-select" style="font-size:12px; color:var(--text-muted);">Project privacy level</label>
            <select id="privacy-level-select">
              <option value="standard">standard</option>
              <option value="no-training">no-training</option>
              <option value="zdr">zdr</option>
            </select>
            <span style="font-size:12px; color:var(--text-muted);" id="privacyLevelSource"></span>
          </div>
          <div style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:12px;">
            <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
              <input type="checkbox" id="attest-privacy-chk"> My OpenRouter account disables training for these model groups
            </label>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;">
              <button class="btn btn-sm btn-primary" id="attest-privacy-confirm" disabled>Confirm attestation</button>
              <button class="btn btn-sm" id="attest-privacy-remove" style="display:none;">Remove attestation</button>
              <span style="font-size:12px; color:var(--text-muted);" id="attestState"></span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-sm" id="refresh-models-settings">Refresh models</button>
            <span style="font-size:12px; color:var(--text-muted);" id="settingsCatalogState"></span>
          </div>
          <div id="privacyAlert" style="margin-top:10px;"></div>
        </div>

        <div class="msg-card">
          <h3 style="margin-top:0;">⚙️ Default Batch Settings & Project Instructions</h3>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
            <div>
              <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Default Batch Model</label>
              <input type="text" id="settingsDefaultModel" list="knownModelsList" style="width:100%; font-family:var(--mono);">
            </div>
            <div>
              <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Default OpenRouter Account Alias</label>
              <input type="text" id="settingsDefaultAccount" style="width:100%; font-family:var(--mono);">
            </div>
          </div>
          <div>
            <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Project Chat Instructions (<code>.pi/BATCH_CHAT.md</code> — included in system prompt, secret-scanned)</label>
            <textarea id="settingsProjectInstructions" class="form-control" style="width:100%; min-height:110px; font-family:var(--mono);"></textarea>
          </div>
          <div id="settingsAlert" style="margin-top:10px;"></div>
          <div style="margin-top:12px; display:flex; justify-content:flex-end;">
            <button class="btn btn-primary" id="saveSettingsBtn">Save Settings</button>
          </div>
        </div>

        <div class="msg-card">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
            <h3 style="margin:0;">📁 Workspace Context & Ignore Rules Inspector</h3>
            <input type="text" id="workspaceInspectorFilter" placeholder="Filter workspace paths…" style="width:240px;">
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin-top:0;">
            Shows how <code>buildContextPackage</code> evaluates workspace files against <code>hard-deny</code>, <code>.pi/batchignore</code>, <code>.gitignore</code>, and size limits.
          </p>
          <div style="max-height:420px; overflow-y:auto; border:1px solid var(--border); border-radius:8px;">
            <table class="data-table" id="workspaceFilesTable">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Status / Rule</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ==================== MODAL: WORKSPACE FILE PICKER ==================== -->
  <div class="modal-backdrop" id="workspacePickerModal">
    <div class="modal">
      <div class="modal-header">
        <span>📁 Attach Workspace Files & Directories</span>
        <button class="btn btn-sm" data-close="workspacePickerModal">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex; gap:8px;">
          <input type="text" id="pickerSearchInput" placeholder="Search files or directories (e.g. src/service.ts)…" style="flex:1;">
          <label style="display:flex; align-items:center; gap:4px; font-size:12px; color:var(--text-muted);">
            <input type="checkbox" id="pickerShowExcluded"> Show excluded files
          </label>
        </div>
        <div style="max-height:340px; overflow-y:auto; border:1px solid var(--border); border-radius:6px;">
          <table class="data-table" id="pickerTable">
            <thead>
              <tr>
                <th>Path</th>
                <th>Kind</th>
                <th>Size</th>
                <th>Status</th>
                <th>Select</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div id="pickerFilePreview" style="display:none;">
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;" id="pickerPreviewTitle"></div>
          <pre id="pickerPreviewBody" style="max-height:180px; overflow:auto; background:#0b0d13; padding:10px; border-radius:6px; border:1px solid var(--border); font-family:var(--mono); font-size:11px; margin:0;"></pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-close="workspacePickerModal">Done</button>
      </div>
    </div>
  </div>

  <!-- ==================== MODAL: NEW BATCH JOB STUDIO ==================== -->
  <div class="modal-backdrop" id="newJobModal">
    <div class="modal">
      <div class="modal-header">
        <span>＋ New Batch Job Studio</span>
        <button class="btn btn-sm" data-close="newJobModal">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex; gap:8px;">
          <button class="btn btn-sm btn-primary job-kind-btn" data-kind="ask">Ask / Goal (Files + Uploads)</button>
          <button class="btn btn-sm job-kind-btn" data-kind="map-files">Map-Files Workflow (1 req / file)</button>
          <button class="btn btn-sm job-kind-btn" data-kind="dataset">Dataset Workflow (CSV / JSONL)</button>
          <button class="btn btn-sm job-kind-btn" data-kind="metadata">UC Metadata</button>
        </div>

        <div id="jobFormAsk" class="job-form-section">
          <label style="font-size:12px; color:var(--text-muted);">Objective / Prompt</label>
          <textarea id="askObjectiveInput" class="form-control" style="min-height:90px;" placeholder="Describe the analysis or task to run at 50% batch discount…"></textarea>
        </div>

        <div id="jobFormDataset" class="job-form-section" style="display:none;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <label style="font-size:12px; color:var(--text-muted);">Project Workflow (.pi/batch-workflows/*.yaml)</label>
              <select id="datasetWorkflowSelect" style="width:100%;"></select>
            </div>
            <div>
              <label style="font-size:12px; color:var(--text-muted);">Dataset Path (CSV / JSONL)</label>
              <input type="text" id="datasetInputPath" placeholder="data/items.csv" style="width:100%; font-family:var(--mono);">
            </div>
          </div>
        </div>

        <div id="jobFormMetadata" class="job-form-section" style="display:none;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <div>
              <label style="font-size:12px; color:var(--text-muted);">Context file (reviewed &lt;Domain&gt;_context.md)</label>
              <input type="text" id="metadataContextInput" placeholder="metadata/pinpoint/context.md" style="width:100%; font-family:var(--mono);">
            </div>
            <div>
              <label style="font-size:12px; color:var(--text-muted);">Tables file (tables.jsonl)</label>
              <input type="text" id="metadataTablesInput" placeholder="metadata/pinpoint/tables.jsonl" style="width:100%; font-family:var(--mono);">
            </div>
            <div>
              <label style="font-size:12px; color:var(--text-muted);">Domain (optional, lowercase slug)</label>
              <input type="text" id="metadataDomainInput" placeholder="pinpoint" style="width:100%; font-family:var(--mono);">
            </div>
            <div>
              <label style="font-size:12px; color:var(--text-muted);">UC prefix (optional, e.g. PNPT_)</label>
              <input type="text" id="metadataPrefixInput" placeholder="PNPT_" style="width:100%; font-family:var(--mono);">
            </div>
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:6px;">Give both domain and UC prefix to enforce the UC description, comment and tag standards; leave both empty for plain proposals. Proposals only: nothing is applied to Databricks.</div>
        </div>

        <div id="jobFormFilesSection" style="display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
            <div style="display:flex; gap:8px; align-items:center;">
              <button class="btn btn-sm" id="openWorkspacePickerJobBtn">📁 Pick Workspace Files / Contexts</button>
              <label class="btn btn-sm" id="jobUploadLabel" style="cursor:pointer;">
                📎 Upload File / PDF / Image
                <input type="file" id="jobUploadInput" multiple style="display:none;">
              </label>
            </div>
            <div id="mapFilesGroupWrap" style="display:none;">
              <label style="font-size:12px; color:var(--text-muted);">Files per request (group size):</label>
              <input type="number" id="mapFilesGroupSize" value="1" min="1" style="width:65px;">
            </div>
          </div>
          <div class="att-list" id="jobPendingAttachments"></div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">
          <div>
            <label style="font-size:12px; color:var(--text-muted);">Model Slug</label>
            <input type="text" id="jobModelInput" list="knownModelsList" style="width:100%; font-family:var(--mono);">
          </div>
          <div>
            <label style="font-size:12px; color:var(--text-muted);">Output Format</label>
            <select id="jobFormatSelect" style="width:100%;">
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px; color:var(--text-muted);">Provider Pin (optional)</label>
            <input type="text" id="jobProviderPinInput" placeholder="e.g. anthropic" style="width:100%; font-family:var(--mono);">
          </div>
        </div>

        <div id="jobDryRunOutput"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="previewJobBtn">🔍 Dry-Run / Preview Package</button>
        <button class="btn" id="savePreviewJobBtn">💾 Save as Previewed Job</button>
        <button class="btn btn-primary" id="submitJobNowBtn">🚀 Submit Batch to OpenRouter</button>
      </div>
    </div>
  </div>

  <!-- ==================== MODAL: SWITCH WORKSPACE FOLDER ==================== -->
  <div class="modal-backdrop" id="switchWorkspaceModal">
    <div class="modal">
      <div class="modal-header">
        <span>📂 Switch Active Workspace Folder</span>
        <button class="btn btn-sm" data-close="switchWorkspaceModal">✕</button>
      </div>
      <div class="modal-body">
        <div>
          <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Direct Folder Path</label>
          <div style="display:flex; gap:8px;">
            <input type="text" id="switchWorkspaceInput" placeholder="C:/Users/.../my-project" style="flex:1; font-family:var(--mono);">
            <button class="btn" id="browseWorkspaceInputBtn" title="Browse subdirectories of this path">🔍 Browse</button>
            <button class="btn btn-primary" id="confirmSwitchWorkspaceBtn">Switch to Folder</button>
          </div>
        </div>

        <div id="switchWorkspaceQuickLinks" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;"></div>
        <div id="switchWorkspaceAlert"></div>

        <div>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
            <span style="font-size:12px; color:var(--text-muted);">Browsing: <code id="browseCurrentDirLabel" style="color:var(--text);"></code></span>
            <button class="btn btn-sm btn-primary" id="switchToCurrentBrowsedBtn">✓ Use This Folder</button>
          </div>
          <div style="max-height:300px; overflow-y:auto; border:1px solid var(--border); border-radius:6px;">
            <table class="data-table" id="browseDirsTable">
              <thead>
                <tr>
                  <th>Directory</th>
                  <th>Status</th>
                  <th style="text-align:right;">Action</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-close="switchWorkspaceModal">Cancel</button>
      </div>
    </div>
  </div>

  <!-- ==================== MODAL: SAVE GENERATED FILE TO WORKSPACE ==================== -->
  <div class="modal-backdrop" id="saveToWorkspaceModal">
    <div class="modal">
      <div class="modal-header">
        <span>💾 Save Generated File to Workspace</span>
        <button class="btn btn-sm" data-close="saveToWorkspaceModal">✕</button>
      </div>
      <div class="modal-body">
        <div>
          <label style="display:block; font-size:12px; color:var(--text-muted); margin-bottom:4px;">Relative Path inside Workspace (<code id="saveModalWorkspaceRoot"></code>)</label>
          <input type="text" id="saveToWorkspacePathInput" placeholder="src/generated.ts" style="width:100%; font-family:var(--mono);">
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-muted); cursor:pointer;">
          <input type="checkbox" id="saveToWorkspaceOverwrite"> Overwrite if file already exists
        </label>
        <div id="saveToWorkspaceAlert"></div>
        <div id="saveToWorkspacePreviewWrap">
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;" id="saveToWorkspaceMeta"></div>
          <pre id="saveToWorkspacePreview" style="max-height:240px; overflow:auto; background:#0b0d13; padding:10px; border-radius:6px; border:1px solid var(--border); font-family:var(--mono); font-size:11px; margin:0;"></pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-close="saveToWorkspaceModal">Cancel</button>
        <button class="btn btn-primary" id="confirmSaveToWorkspaceBtn">💾 Write File to Disk</button>
      </div>
    </div>
  </div>

  <datalist id="knownModelsList"></datalist>
  <div class="toast-container" id="toastContainer"></div>

  <script nonce="${nonceAttr}">
    const CSRF_TOKEN = ${tokenJson};
    let WORKSPACE_ROOT = ${rootJson};

    const state = {
      activeTab: "chat",
      workspaceRoot: WORKSPACE_ROOT,
      recentWorkspaces: [WORKSPACE_ROOT],
      browsedDir: WORKSPACE_ROOT,
      config: null,
      threads: [],
      activeThreadId: null,
      activeThreadDetail: null,
      jobs: [],
      selectedJobId: null,
      selectedJobDetail: null,
      jobSubTab: "result",
      workflows: [],
      models: [],
      workspaceEntries: [],
      pickerTarget: "chat", // "chat" | "job"
      chatAttachments: { files: [], contexts: [], uploads: [] },
      jobAttachments: { files: [], contexts: [], uploads: [] },
      jobStudioKind: "ask",
      privacy: null,
      picker: { entries: [], catalog: null, key: "" },
      showBlocked: false,
      pickedRoute: null,
    };

    function updateWorkspaceDisplay(rootPath) {
      WORKSPACE_ROOT = rootPath;
      state.workspaceRoot = rootPath;
      const pill = document.getElementById("workspacePill");
      pill.textContent = "📁 " + rootPath + " ▾";
      pill.title = "Active workspace: " + rootPath + " (Click to switch folder)";
      const settingsPath = document.getElementById("settingsActiveWorkspacePath");
      if (settingsPath) settingsPath.textContent = rootPath;
    }
    updateWorkspaceDisplay(WORKSPACE_ROOT);

    function escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    // Click actions are data, never inline JavaScript: a button carries data-action (a name from ACTIONS) and
    // data-args (a JSON array), and one delegated listener calls the handler. Untrusted values (file names, job IDs)
    // therefore never reach a JavaScript parser.
    const ACTIONS = new Set([
      "copyExtractedBlock", "downloadExtractedBlock", "openSaveBlockModal", "exportReplyArtifact", "inspectJobFromChat",
      "retryActiveChatTurn", "pollSingleJob", "removeAttachment", "toggleWorkspaceSelection", "previewWorkspaceFile",
      "quickAttachToChat", "inspectJobItem", "generateJobArtifact", "exportDatasetJob", "previewArtifactFrame",
      "submitPreviewedJob", "cancelBatchJob", "retryBatchJob", "synthesizeBatchJob", "setJobSubTab",
      "writeMetadataReview", "writeMetadataApproved", "validateMetadataApproved",
    ]);
    function act(name, ...args) {
      return 'data-action="' + escapeHtml(name) + '" data-args="' + escapeHtml(JSON.stringify(args)) + '"';
    }
    document.addEventListener("click", (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
      if (!el) return;
      const name = el.getAttribute("data-action");
      if (!ACTIONS.has(name) || typeof window[name] !== "function") return;
      let args = [];
      try {
        args = JSON.parse(el.getAttribute("data-args") || "[]");
      } catch {
        return;
      }
      if (!Array.isArray(args)) return;
      ev.preventDefault();
      window[name](...args);
    });

    function formatBytes(bytes) {
      if (bytes === undefined || bytes === null) return "";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    }

    const LANG_EXT = {
      ts: "ts", typescript: "ts", tsx: "tsx", js: "js", javascript: "js", jsx: "jsx",
      py: "py", python: "py", json: "json", jsonl: "jsonl", csv: "csv", html: "html",
      css: "css", md: "md", markdown: "md", yaml: "yaml", yml: "yaml", sql: "sql",
      sh: "sh", bash: "sh", ps1: "ps1", powershell: "ps1", rs: "rs", rust: "rs",
      go: "go", java: "java", c: "c", cpp: "cpp", xml: "xml", svg: "svg", toml: "toml"
    };

    window.__extractedBlocks = {};
    let __blockSeq = 0;

    function inferCodeBlockMeta(info, rawCode, indexInMsg) {
      const trimmedInfo = (info || "").trim();
      let lang = "text";
      let suggestedPath = "";
      if (trimmedInfo) {
        const parts = trimmedInfo.split(/\\s+/);
        const first = parts[0] || "";
        if (first.includes(":")) {
          const sp = first.split(":");
          lang = sp[0] || "text";
          suggestedPath = sp.slice(1).join(":");
        } else if (first.includes("/") && /\\.[a-zA-Z0-9]{1,8}$/.test(first)) {
          suggestedPath = first;
          lang = first.split(".").pop().toLowerCase();
        } else {
          lang = first.toLowerCase();
        }
        for (const p of parts.slice(1)) {
          const kv = /^(?:file|path|title)=['"]?([^'"]+)['"]?$/i.exec(p);
          const cand = kv ? kv[1] : p;
          if (/\\.[a-zA-Z0-9]{1,8}$/.test(cand)) {
            suggestedPath = cand;
            break;
          }
        }
      }
      if (!suggestedPath) {
        const firstLine = (rawCode || "").split("\\n", 1)[0]?.trim() || "";
        const m = /^(?:\\/\\/|#|--|<!--)\\s*(?:file:\\s*|path:\\s*)?([a-zA-Z0-9_./-]+\\.[a-zA-Z0-9]{1,8})(?:\\s*-->)?$/i.exec(firstLine);
        if (m && m[1]) suggestedPath = m[1];
      }
      suggestedPath = suggestedPath.replace(/^['"\`\\/]+|['"\`]+$/g, "");
      if (!suggestedPath) {
        const ext = LANG_EXT[lang] || "txt";
        suggestedPath = "output-" + indexInMsg + "." + ext;
      }
      return { lang, suggestedPath };
    }

    function formatMarkdownLite(text) {
      const rawText = String(text || "");
      const placeholders = [];
      let blockIdx = 1;

      // 1. Extract fenced code blocks before HTML-escaping so raw content stays exact
      let working = rawText.replace(/\`\`\`([^\\n\`]*)\\n([\\s\\S]*?)\`\`\`/g, (_m, info, code) => {
        const id = "blk_" + (++__blockSeq);
        const meta = inferCodeBlockMeta(info, code, blockIdx++);
        const lines = code ? code.replace(/\\n$/, "").split("\\n").length : 0;
        window.__extractedBlocks[id] = {
          kind: "code",
          lang: meta.lang,
          suggestedPath: meta.suggestedPath,
          content: code,
          lines,
        };
        const html =
          '<div style="margin:8px 0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:#0b0d13;">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; background:var(--bg-elevated); border-bottom:1px solid var(--border); font-size:11px; flex-wrap:wrap;">' +
          '<span style="font-family:var(--mono); color:#a5b4fc;">📄 ' +
          escapeHtml(meta.suggestedPath) +
          ' <span style="color:var(--text-muted);">(' +
          escapeHtml(meta.lang) +
          " · " +
          lines +
          " line" +
          (lines === 1 ? "" : "s") +
          ")</span></span>" +
          '<span style="display:flex; gap:6px;">' +
          '<button class="btn btn-sm" ' + act("copyExtractedBlock", id) + '>📋 Copy</button>' +
          '<button class="btn btn-sm" ' + act("downloadExtractedBlock", id) + '>⬇️ Download</button>' +
          '<button class="btn btn-sm btn-primary" ' + act("openSaveBlockModal", id) + '>💾 Save to Workspace…</button>' +
          "</span></div>" +
          '<pre style="margin:0; border:none; border-radius:0;"><code>' +
          escapeHtml(code) +
          "</code></pre></div>";
        const token = "@@BLOCK_PLACEHOLDER_" + placeholders.length + "@@";
        placeholders.push(html);
        return token;
      });

      // 2. Extract embedded data-URI images (data:image/(png|jpeg|webp|gif);base64,...)
      working = working.replace(/(?:!\\[([^\\]]*)\\]\\()?(data:(image\\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+))\\)?/g, (_m, alt, dataUrl, mime, b64) => {
        const id = "blk_" + (++__blockSeq);
        const ext = mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1];
        const suggestedPath = "image-" + (blockIdx++) + "." + ext;
        window.__extractedBlocks[id] = {
          kind: "image",
          lang: ext,
          suggestedPath,
          contentBase64: dataUrl,
          mimeType: mime,
          bytes: Math.floor((b64.length * 3) / 4),
        };
        const html =
          '<div style="margin:8px 0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:#0b0d13; padding:10px;">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:11px;">' +
          '<span style="font-family:var(--mono); color:#a5b4fc;">🖼️ ' + escapeHtml(alt || suggestedPath) + " (" + escapeHtml(mime) + ")</span>" +
          '<span style="display:flex; gap:6px;">' +
          '<button class="btn btn-sm" ' + act("downloadExtractedBlock", id) + '>⬇️ Download Image</button>' +
          '<button class="btn btn-sm btn-primary" ' + act("openSaveBlockModal", id) + '>💾 Save to Workspace…</button>' +
          "</span></div>" +
          '<img src="' + escapeHtml(dataUrl) + '" alt="' + escapeHtml(alt || suggestedPath) + '" style="max-width:100%; max-height:360px; border-radius:6px; display:block;">' +
          "</div>";
        const token = "@@BLOCK_PLACEHOLDER_" + placeholders.length + "@@";
        placeholders.push(html);
        return token;
      });

      let safe = escapeHtml(working);
      // Inline code
      safe = safe.replace(/\`([^\`\\n]+)\`/g, "<code>$1</code>");
      // Bold
      safe = safe.replace(/\\*\\*([^\\*\\n]+)\\*\\*/g, "<strong>$1</strong>");
      // Restore block placeholders
      safe = safe.replace(/@@BLOCK_PLACEHOLDER_(\\d+)@@/g, (_m, idx) => placeholders[Number(idx)] || "");
      return safe;
    }

    function showToast(msg, level = "info") {
      const c = document.getElementById("toastContainer");
      const el = document.createElement("div");
      el.className = "toast";
      if (level === "error" || level === "warning") el.style.borderColor = "var(--warning)";
      el.textContent = msg;
      c.appendChild(el);
      setTimeout(() => el.remove(), 4500);
    }

    async function api(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (opts.body && typeof opts.body === "object") {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(opts.body);
      }
      if (opts.method && opts.method !== "GET") {
        headers["X-Batch-Token"] = CSRF_TOKEN;
      }
      const res = await fetch(path, { ...opts, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      return data;
    }

    // ---------------- Navigation ----------------
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        state.activeTab = tab;
        document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
        document.querySelectorAll(".main-view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab));
        if (tab === "workspace") loadWorkspaceFiles();
      });
    });

    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(btn.dataset.close).classList.remove("open");
      });
    });

    // ---------------- Bootstrap & SSE ----------------
    async function bootstrap() {
      const data = await api("/api/bootstrap");
      if (data.workspaceRoot) updateWorkspaceDisplay(data.workspaceRoot);
      if (data.recentWorkspaces) state.recentWorkspaces = data.recentWorkspaces;
      state.config = data.config;
      state.threads = data.threads || [];
      state.jobs = data.jobs || [];
      state.workflows = data.workflows || [];
      state.models = data.models || [];
      updateBadge(data.badge);

      const dl = document.getElementById("knownModelsList");
      dl.innerHTML = state.models.map((m) => '<option value="' + escapeHtml(m) + '"></option>').join("");

      document.getElementById("settingsDefaultModel").value = state.config.defaultModel || "";
      document.getElementById("settingsDefaultAccount").value = state.config.defaultAccount || "";
      document.getElementById("settingsProjectInstructions").value = data.projectInstructions || "";
      document.getElementById("jobModelInput").value = state.config.defaultModel || "";

      const wfSel = document.getElementById("datasetWorkflowSelect");
      wfSel.innerHTML = state.workflows.length
        ? state.workflows.map((w) => '<option value="' + escapeHtml(w.name) + '">' + escapeHtml(w.name) + (w.valid ? "" : " (invalid)") + "</option>").join("")
        : '<option value="">(no .pi/batch-workflows/*.yaml found)</option>';

      renderThreadList();
      renderJobList();
      await loadPrivacy();

      if (!state.activeThreadId && state.threads.length > 0) {
        await selectThread(state.threads[0].id);
      } else if (state.activeThreadId) {
        await selectThread(state.activeThreadId);
      } else {
        document.getElementById("chatHeader").style.display = "none";
        document.getElementById("chatComposer").style.display = "none";
        document.getElementById("chatInflightContainer").innerHTML = "";
        document.getElementById("chatStream").innerHTML =
          '<div style="margin:auto; text-align:center; color:var(--text-muted);"><p>Select a chat thread or click <strong>＋ New Thread</strong> to start an asynchronous conversation with an OpenRouter batch model.</p></div>';
      }
      if (state.selectedJobId) {
        await selectJob(state.selectedJobId);
      } else {
        document.getElementById("jobDetailPane").innerHTML =
          '<div style="margin:auto; text-align:center; color:var(--text-muted);"><p>Select a batch job from the left or click <strong>＋ New Batch Job</strong> to create a Goal, Map-Files, or Dataset batch.</p></div>';
      }
    }

    function updateBadge(text) {
      const pill = document.getElementById("badgePill");
      pill.textContent = text || "📦 Batch: Idle";
    }

    function connectSse() {
      const es = new EventSource("/api/events");
      es.onmessage = async (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (payload.type === "settled") {
            showToast("📦 Batch " + payload.localId + " settled (" + payload.status + ")");
          }
          if (payload.type === "workspace_changed" && payload.workspaceRoot && payload.workspaceRoot !== state.workspaceRoot) {
            state.activeThreadId = null;
            state.selectedJobId = null;
            await bootstrap();
            if (state.activeTab === "workspace") await loadWorkspaceFiles();
            return;
          }
          if (payload.type === "privacy" || payload.type === "catalog") {
            state.picker.key = "";
            await loadPrivacy();
          }
          await refreshStateQuiet();
        } catch {}
      };
    }

    // ---------------- Workspace Folder Switcher ----------------
    async function openSwitchWorkspaceModal() {
      document.getElementById("switchWorkspaceAlert").innerHTML = "";
      document.getElementById("switchWorkspaceInput").value = state.workspaceRoot;
      document.getElementById("switchWorkspaceModal").classList.add("open");
      await browseWorkspaceDirs(state.workspaceRoot);
    }

    async function browseWorkspaceDirs(targetPath) {
      const alertEl = document.getElementById("switchWorkspaceAlert");
      alertEl.innerHTML = "";
      try {
        const res = await api("/api/workspace/browse-dirs?path=" + encodeURIComponent(targetPath || ""));
        state.browsedDir = res.current;
        document.getElementById("switchWorkspaceInput").value = res.current;
        document.getElementById("browseCurrentDirLabel").textContent = res.current;

        // Render quick links (Home + Recent Workspaces)
        const quickEl = document.getElementById("switchWorkspaceQuickLinks");
        const recents = (res.recentWorkspaces || []).map(
          (r) =>
            '<button class="btn btn-sm" data-quick-switch="' +
            escapeHtml(r) +
            '" title="Switch directly to ' +
            escapeHtml(r) +
            '">🕒 ' +
            escapeHtml(r.split("/").pop() || r) +
            "</button>",
        );
        quickEl.innerHTML =
          '<span style="font-size:11px; color:var(--text-muted);">Quick Jump:</span>' +
          (res.homeDir ? '<button class="btn btn-sm" data-quick-browse="' + escapeHtml(res.homeDir) + '">🏠 Home</button>' : "") +
          recents.join("");

        quickEl.querySelectorAll("[data-quick-browse]").forEach((btn) => {
          btn.addEventListener("click", () => browseWorkspaceDirs(btn.dataset.quickBrowse));
        });
        quickEl.querySelectorAll("[data-quick-switch]").forEach((btn) => {
          btn.addEventListener("click", () => switchWorkspaceTo(btn.dataset.quickSwitch));
        });

        const tbody = document.querySelector("#browseDirsTable tbody");
        const rows = [];
        if (res.parent) {
          rows.push(
            "<tr>" +
              '<td colspan="2"><a href="#" data-browse-dir="' +
              escapeHtml(res.parent) +
              '" style="color:#a5b4fc; text-decoration:none; font-family:var(--mono);">⬆️ .. (Parent Directory: ' +
              escapeHtml(res.parent) +
              ")</a></td>" +
              '<td style="text-align:right;"><button class="btn btn-sm" data-browse-dir="' +
              escapeHtml(res.parent) +
              '">Open Parent</button></td>' +
              "</tr>",
          );
        }
        for (const d of res.directories || []) {
          rows.push(
            "<tr>" +
              '<td style="font-family:var(--mono);"><a href="#" data-browse-dir="' +
              escapeHtml(d.path) +
              '" style="color:var(--text); text-decoration:none;">📁 ' +
              escapeHtml(d.name) +
              "</a></td>" +
              "<td>" +
              (d.hasPiBatch ? '<span class="status-dot status-ready">📦 .pi workspace</span>' : '<span style="color:var(--text-muted); font-size:11px;">folder</span>') +
              "</td>" +
              '<td style="text-align:right; display:flex; gap:6px; justify-content:flex-end;">' +
              '<button class="btn btn-sm" data-browse-dir="' +
              escapeHtml(d.path) +
              '">Browse</button>' +
              '<button class="btn btn-sm btn-primary" data-switch-dir="' +
              escapeHtml(d.path) +
              '">Switch Here</button>' +
              "</td>" +
              "</tr>",
          );
        }
        if (rows.length === 0) {
          rows.push('<tr><td colspan="3" style="color:var(--text-muted);">No subdirectories found.</td></tr>');
        }
        tbody.innerHTML = rows.join("");
        tbody.querySelectorAll("[data-browse-dir]").forEach((el) => {
          el.addEventListener("click", (ev) => {
            ev.preventDefault();
            browseWorkspaceDirs(el.dataset.browseDir);
          });
        });
        tbody.querySelectorAll("[data-switch-dir]").forEach((el) => {
          el.addEventListener("click", () => switchWorkspaceTo(el.dataset.switchDir));
        });
      } catch (err) {
        alertEl.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    }

    async function switchWorkspaceTo(targetPath) {
      const alertEl = document.getElementById("switchWorkspaceAlert");
      alertEl.innerHTML = "";
      try {
        const res = await api("/api/workspace/switch", {
          method: "POST",
          body: { path: targetPath },
        });
        document.getElementById("switchWorkspaceModal").classList.remove("open");
        state.activeThreadId = null;
        state.activeThreadDetail = null;
        state.selectedJobId = null;
        state.selectedJobDetail = null;
        state.chatAttachments = { files: [], contexts: [], uploads: [] };
        state.jobAttachments = { files: [], contexts: [], uploads: [] };
        renderPendingAttachments("chat");
        renderPendingAttachments("job");
        updateWorkspaceDisplay(res.workspaceRoot);
        await bootstrap();
        if (state.activeTab === "workspace") await loadWorkspaceFiles();
        showToast("📁 Switched workspace to " + res.workspaceRoot);
      } catch (err) {
        alertEl.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    }

    document.getElementById("workspacePill").addEventListener("click", openSwitchWorkspaceModal);
    document.getElementById("openSwitchWorkspaceSettingsBtn").addEventListener("click", openSwitchWorkspaceModal);
    document.getElementById("browseWorkspaceInputBtn").addEventListener("click", () => {
      browseWorkspaceDirs(document.getElementById("switchWorkspaceInput").value.trim());
    });
    document.getElementById("confirmSwitchWorkspaceBtn").addEventListener("click", () => {
      switchWorkspaceTo(document.getElementById("switchWorkspaceInput").value.trim());
    });
    document.getElementById("switchToCurrentBrowsedBtn").addEventListener("click", () => {
      switchWorkspaceTo(state.browsedDir);
    });

    async function refreshStateQuiet() {
      try {
        const data = await api("/api/bootstrap");
        state.threads = data.threads || [];
        state.jobs = data.jobs || [];
        updateBadge(data.badge);
        renderThreadList();
        renderJobList();
        if (state.activeThreadId) await selectThread(state.activeThreadId, true);
        if (state.selectedJobId) await selectJob(state.selectedJobId, true);
      } catch {}
    }

    // ---------------- Chat Threads ----------------
    function renderThreadList() {
      const q = (document.getElementById("threadSearchInput").value || "").toLowerCase();
      const el = document.getElementById("threadList");
      const filtered = state.threads.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
      if (filtered.length === 0) {
        el.innerHTML = '<div style="padding:14px; color:var(--text-muted); font-size:12px;">No threads match.</div>';
        return;
      }
      el.innerHTML = filtered
        .map((t) => {
          const sel = t.id === state.activeThreadId ? "selected" : "";
          const statusBadge = t.pending
            ? '<span class="status-dot status-waiting">waiting</span>'
            : t.compacting
              ? '<span class="status-dot status-compacting">compacting</span>'
              : t.lastFailure
                ? '<span class="status-dot status-failed">failed</span>'
                : "";
          return (
            '<div class="list-item ' + sel + '" data-thread-id="' + escapeHtml(t.id) + '">' +
            '<div class="list-item-title">' + escapeHtml(t.title) + "</div>" +
            '<div class="list-item-meta">' +
            statusBadge +
            "<span>" + escapeHtml(t.model) + "</span>" +
            "<span>· " + (t.messageCount ?? 0) + " msgs</span>" +
            "</div></div>"
          );
        })
        .join("");
      el.querySelectorAll("[data-thread-id]").forEach((row) => {
        row.addEventListener("click", () => selectThread(row.dataset.threadId));
      });
    }

    document.getElementById("threadSearchInput").addEventListener("input", renderThreadList);

    async function selectThread(threadId, preserveScroll = false) {
      state.activeThreadId = threadId;
      renderThreadList();
      const detail = await api("/api/threads/" + encodeURIComponent(threadId));
      state.activeThreadDetail = detail;
      document.getElementById("chatHeader").style.display = "flex";
      document.getElementById("chatComposer").style.display = "flex";
      document.getElementById("chatThreadTitle").textContent = detail.thread.title;
      document.getElementById("chatThreadId").textContent = detail.thread.id + (detail.costSummary ? " · " + detail.costSummary : "");
      if (document.activeElement !== document.getElementById("chatModelInput")) {
        document.getElementById("chatModelInput").value = detail.thread.model;
      }
      renderThreadPrivacy(detail);

      const est = detail.estimate;
      const pct = est.limit > 0 ? Math.min(100, Math.round((est.tokens / est.limit) * 100)) : 0;
      document.getElementById("contextMeterText").textContent = "~" + est.tokens + " tok (" + pct + "%)";
      document.getElementById("contextMeterFill").style.width = pct + "%";

      renderChatMessages(detail, preserveScroll);
    }

    function renderChatMessages(detail, preserveScroll) {
      const stream = document.getElementById("chatStream");
      const prevScroll = stream.scrollTop;
      const entries = detail.entries || [];
      if (entries.length === 0) {
        stream.innerHTML =
          '<div style="margin:auto; text-align:center; color:var(--text-muted); max-width:480px;">' +
          "<h3>Thread " + escapeHtml(detail.thread.id) + " ready</h3>" +
          "<p>Send a message below or attach workspace files, code, CSV/JSON datasets, PDFs, or images. Each turn is submitted as a 50%-discounted OpenRouter batch job.</p>" +
          "</div>";
      } else {
        stream.innerHTML = entries
          .map((e) => {
            if (e.type === "user") {
              const atts = (e.attachments || [])
                .map(
                  (a) =>
                    '<span class="att-chip" title="SHA-256: ' +
                    escapeHtml(a.sha256) +
                    '">📎 ' +
                    escapeHtml(a.path || a.name) +
                    " · " +
                    escapeHtml(a.kind.toUpperCase()) +
                    (a.mode ? " (" + escapeHtml(a.mode) + ")" : "") +
                    " · " +
                    formatBytes(a.bytes) +
                    "</span>",
                )
                .join("");
              const previewBlock = e.inlinedText
                ? '<details style="margin-top:8px;"><summary style="cursor:pointer; font-size:11px; color:var(--text-muted);">Inspect packaged file text (' +
                  e.inlinedText.length +
                  ' chars)</summary><pre style="max-height:220px; overflow:auto; margin-top:6px;"><code>' +
                  escapeHtml(e.inlinedText) +
                  "</code></pre></details>"
                : "";
              return (
                '<div class="msg-card msg-user">' +
                '<div class="msg-header"><span><strong>You</strong> · #' + e.seq + "</span><span>" + escapeHtml(e.at.slice(11, 19)) + "</span></div>" +
                '<div class="msg-body">' + formatMarkdownLite(e.text) + "</div>" +
                (atts ? '<div class="att-list">' + atts + "</div>" : "") +
                previewBlock +
                "</div>"
              );
            }
            if (e.type === "assistant") {
              return (
                '<div class="msg-card msg-assistant">' +
                '<div class="msg-header" style="flex-wrap:wrap;">' +
                '<span><strong style="color:#a5b4fc;">' + escapeHtml(e.model) + "</strong> · #" + e.seq + "</span>" +
                '<span style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
                (e.finishReason === "length" ? '<span class="status-dot status-waiting">truncated: max_tokens</span>' : "") +
                '<button class="btn btn-sm" title="Render & download this reply as Markdown (.md)" ' + act("exportReplyArtifact", e.jobId, "markdown") + '>⬇️ .md</button>' +
                '<button class="btn btn-sm" title="Render & download this reply as HTML (.html)" ' + act("exportReplyArtifact", e.jobId, "html") + '>📄 .html</button>' +
                '<button class="btn btn-sm" title="Render & download this reply as PDF (.pdf)" ' + act("exportReplyArtifact", e.jobId, "pdf") + '>📕 .pdf</button>' +
                '<button class="btn btn-sm" ' + act("inspectJobFromChat", e.jobId) + '>📦 ' + escapeHtml(e.jobId) + "</button>" +
                "</span></div>" +
                '<div class="msg-body">' + formatMarkdownLite(e.text) + "</div>" +
                "</div>"
              );
            }
            if (e.type === "compaction") {
              return (
                '<div class="msg-card" style="align-self:stretch; background:rgba(56,189,248,0.07); border-color:rgba(56,189,248,0.3);">' +
                '<div class="msg-header"><strong>🗜️ Compacted Conversation (through #' + e.throughSeq + " · " + escapeHtml(e.model) + ")</strong><span>" + escapeHtml(e.jobId) + "</span></div>" +
                '<details><summary style="cursor:pointer; font-size:12px; color:#7dd3fc;">View Compaction Summary</summary>' +
                '<div class="msg-body" style="margin-top:8px;">' + formatMarkdownLite(e.summary) + "</div></details></div>"
              );
            }
            if (e.type === "failure") {
              const unknown = e.code === "submission_unknown";
              return (
                '<div class="alert-box alert-danger" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">' +
                "<span>⚠️ Turn failed: " + escapeHtml(e.message) + "</span>" +
                (unknown
                  ? '<button class="btn btn-sm" ' + act("retryActiveChatTurn", true) + '>⚠️ Retry anyway (check OpenRouter first)</button>'
                  : '<button class="btn btn-sm" ' + act("retryActiveChatTurn", false) + '>🔄 Retry Turn</button>') +
                "</div>"
              );
            }
            if (e.type === "model") {
              return '<div class="msg-event">Model switched: ' + escapeHtml(e.from) + " → <strong>" + escapeHtml(e.to) + "</strong></div>";
            }
            if (e.type === "title") {
              return '<div class="msg-event">Retitled (' + escapeHtml(e.source) + "): <strong>" + escapeHtml(e.title) + "</strong></div>";
            }
            return '<div class="msg-event">' + escapeHtml(e.text || "") + "</div>";
          })
          .join("");
      }

      // Render in-flight banner if pending or compacting
      const inflight = document.getElementById("chatInflightContainer");
      const p = detail.thread.pending;
      const c = detail.thread.compacting;
      if (p || c) {
        const activeJob = detail.pendingJob || detail.compactingJob;
        const jobStatus = activeJob ? activeJob.localStatus + (activeJob.providerStatus ? " / " + activeJob.providerStatus : "") : "submitting";
        const jobId = (p && p.jobId) || (c && c.jobId) || "";
        inflight.innerHTML =
          '<div class="inflight-banner">' +
          "<div>" +
          "<strong>⏳ " + (p ? "Batch Turn in Flight" : "Compaction in Flight") + "</strong> " +
          (jobId ? "(<code>" + escapeHtml(jobId) + "</code> · " + escapeHtml(jobStatus) + ")" : "") +
          '<div style="font-size:11px; color:var(--text-muted);">Messages sent while waiting are queued in the thread and automatically submitted as one turn when the reply lands.</div>' +
          "</div>" +
          '<div style="display:flex; gap:8px;">' +
          (jobId ? '<button class="btn btn-sm" ' + act("pollSingleJob", jobId) + '>🔄 Poll Job Now</button>' : "") +
          (jobId ? '<button class="btn btn-sm" ' + act("inspectJobFromChat", jobId) + '>Inspect</button>' : "") +
          "</div></div>";
      } else {
        inflight.innerHTML = "";
      }

      if (!preserveScroll) {
        stream.scrollTop = stream.scrollHeight;
      } else {
        stream.scrollTop = prevScroll;
      }
    }

    window.inspectJobFromChat = async (jobId) => {
      document.querySelector('[data-tab="jobs"]').click();
      await selectJob(jobId);
    };

    window.exportReplyArtifact = async (jobId, format) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/artifact", {
          method: "POST",
          body: { format, item: "chat:0000:reply" },
        });
        const artId = res.artifact.artifactId;
        window.open("/api/artifacts/" + encodeURIComponent(artId) + "/content?download=1", "_blank");
        showToast("Generated " + format.toUpperCase() + " artifact (" + artId + ")");
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    let activeSaveBlockId = null;

    window.copyExtractedBlock = async (blockId) => {
      const blk = window.__extractedBlocks[blockId];
      if (!blk) return;
      try {
        await navigator.clipboard.writeText(blk.content || "");
        showToast("📋 Copied " + blk.suggestedPath + " to clipboard");
      } catch {
        showToast("Unable to access clipboard", "error");
      }
    };

    window.downloadExtractedBlock = (blockId) => {
      const blk = window.__extractedBlocks[blockId];
      if (!blk) return;
      const filename = (blk.suggestedPath || "output.txt").split("/").pop() || "output.txt";
      const a = document.createElement("a");
      if (blk.kind === "image" && blk.contentBase64) {
        a.href = blk.contentBase64;
      } else {
        const blob = new Blob([blk.content || ""], { type: "text/plain;charset=utf-8" });
        a.href = URL.createObjectURL(blob);
      }
      a.download = filename;
      a.click();
      showToast("⬇️ Downloaded " + filename);
    };

    window.openSaveBlockModal = (blockId) => {
      const blk = window.__extractedBlocks[blockId];
      if (!blk) return;
      activeSaveBlockId = blockId;
      document.getElementById("saveModalWorkspaceRoot").textContent = state.workspaceRoot;
      document.getElementById("saveToWorkspacePathInput").value = blk.suggestedPath || "output.txt";
      document.getElementById("saveToWorkspaceOverwrite").checked = false;
      document.getElementById("saveToWorkspaceAlert").innerHTML = "";
      if (blk.kind === "image") {
        document.getElementById("saveToWorkspaceMeta").textContent = "Image (" + blk.mimeType + " · " + formatBytes(blk.bytes) + ")";
        document.getElementById("saveToWorkspacePreview").textContent = "[Base64 image data: " + blk.suggestedPath + "]";
      } else {
        document.getElementById("saveToWorkspaceMeta").textContent = blk.lang + " · " + blk.lines + " line(s)";
        document.getElementById("saveToWorkspacePreview").textContent = (blk.content || "").slice(0, 8000);
      }
      document.getElementById("saveToWorkspaceModal").classList.add("open");
    };

    document.getElementById("confirmSaveToWorkspaceBtn").addEventListener("click", async () => {
      const blk = activeSaveBlockId ? window.__extractedBlocks[activeSaveBlockId] : null;
      if (!blk) return;
      const relPath = document.getElementById("saveToWorkspacePathInput").value.trim();
      const overwrite = document.getElementById("saveToWorkspaceOverwrite").checked;
      const alertEl = document.getElementById("saveToWorkspaceAlert");
      alertEl.innerHTML = "";
      try {
        const res = await api("/api/workspace/write-file", {
          method: "POST",
          body: {
            relPath,
            content: blk.kind === "code" ? blk.content : undefined,
            contentBase64: blk.kind === "image" ? blk.contentBase64 : undefined,
            overwrite,
          },
        });
        document.getElementById("saveToWorkspaceModal").classList.remove("open");
        showToast("💾 Saved " + res.relPath + " (" + formatBytes(res.bytes) + ") to workspace");
        if (state.activeTab === "workspace") await loadWorkspaceFiles();
      } catch (err) {
        alertEl.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    });

    window.pollSingleJob = async (jobId) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/check", { method: "POST" });
        showToast("Polled " + jobId + ": " + res.status);
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.retryActiveChatTurn = async (force) => {
      if (!state.activeThreadId) return;
      if (force && !confirm("OpenRouter may already have accepted (and billed) this turn. Check your OpenRouter activity first. Resubmit anyway?")) return;
      try {
        const res = await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/retry", { method: "POST", body: force ? { force: true } : {} });
        showToast("Resubmitted turn as " + res.jobId);
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    document.getElementById("newThreadBtn").addEventListener("click", async () => {
      const res = await api("/api/threads", { method: "POST", body: {} });
      await refreshStateQuiet();
      await selectThread(res.thread.id);
    });

    document.getElementById("renameThreadBtn").addEventListener("click", async () => {
      if (!state.activeThreadDetail) return;
      const next = prompt("New thread title:", state.activeThreadDetail.thread.title);
      if (!next || !next.trim()) return;
      await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/rename", {
        method: "POST",
        body: { title: next.trim() },
      });
      await selectThread(state.activeThreadId, true);
      renderThreadList();
    });

    document.getElementById("setChatModelBtn").addEventListener("click", async () => {
      if (!state.activeThreadId) return;
      const slug = document.getElementById("chatModelInput").value.trim();
      if (!slug) return;
      try {
        await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/model", {
          method: "POST",
          body: { model: slug, route: pickedRouteFor(slug) },
        });
        document.getElementById("chatModelAlert").innerHTML = "";
        showToast("Thread model updated to " + slug);
        await selectThread(state.activeThreadId, true);
      } catch (err) {
        document.getElementById("chatModelAlert").innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
        showToast(err.message, "error");
      }
    });

    document.getElementById("compactThreadBtn").addEventListener("click", async () => {
      if (!state.activeThreadId) return;
      const focus = prompt("Optional focus instructions for compaction summary (leave blank for default):", "");
      if (focus === null) return;
      try {
        const res = await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/compact", {
          method: "POST",
          body: { instructions: focus.trim() || undefined },
        });
        showToast("Compaction batch started: " + res.jobId);
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("exportThreadBtn").addEventListener("click", () => {
      if (!state.activeThreadId) return;
      window.open("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/export", "_blank");
    });

    // ---------------- Attachments Management (Chat & Job Studio) ----------------
    function renderPendingAttachments(target) {
      const bag = target === "chat" ? state.chatAttachments : state.jobAttachments;
      const container = document.getElementById(target === "chat" ? "chatPendingAttachments" : "jobPendingAttachments");
      const chips = [];
      bag.files.forEach((f, idx) => {
        chips.push(
          '<span class="att-chip">📄 ' +
            escapeHtml(f) +
            ' <button type="button" ' + act("removeAttachment", target, "files", idx) + '>✕</button></span>',
        );
      });
      bag.contexts.forEach((c, idx) => {
        chips.push(
          '<span class="att-chip">📁 ' +
            escapeHtml(c) +
            ' (dir) <button type="button" ' + act("removeAttachment", target, "contexts", idx) + '>✕</button></span>',
        );
      });
      bag.uploads.forEach((u, idx) => {
        chips.push(
          '<span class="att-chip">📎 ' +
            escapeHtml(u.name) +
            " (" +
            formatBytes(u.size) +
            (u.pdfMode ? " · " + u.pdfMode : "") +
            ') <button type="button" ' + act("removeAttachment", target, "uploads", idx) + '>✕</button></span>',
        );
      });
      container.innerHTML = chips.join("");
    }

    window.removeAttachment = (target, kind, index) => {
      const bag = target === "chat" ? state.chatAttachments : state.jobAttachments;
      bag[kind].splice(index, 1);
      renderPendingAttachments(target);
      document.getElementById("chatPreflightAlert").innerHTML = "";
    };

    async function handleBrowserFiles(fileList, target) {
      const bag = target === "chat" ? state.chatAttachments : state.jobAttachments;
      const pdfMode = document.getElementById("chatPdfModeSelect").value;
      for (const file of Array.from(fileList)) {
        const b64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read " + file.name));
          reader.readAsDataURL(file);
        });
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        const isImage = /^image\\//.test(file.type) || /\\.(png|jpe?g|webp|gif)$/i.test(file.name);
        // Binary content cannot be secret-scanned: sending it needs an explicit per-file confirmation.
        let allowUnscanned = false;
        if (isImage || (isPdf && pdfMode === "multimodal")) {
          allowUnscanned = confirm(
            '"' + file.name + '" is sent as binary content and cannot be scanned for secrets. Send it unscanned?',
          );
          if (!allowUnscanned) continue;
        }
        bag.uploads.push({
          name: file.name,
          mimeType: file.type || undefined,
          size: file.size,
          contentBase64: b64,
          ...(isPdf ? { pdfMode } : {}),
          ...(allowUnscanned ? { allowUnscanned: true } : {}),
        });
      }
      renderPendingAttachments(target);
    }

    document.getElementById("chatUploadInput").addEventListener("change", async (ev) => {
      await handleBrowserFiles(ev.target.files, "chat");
      ev.target.value = "";
    });

    document.getElementById("jobUploadInput").addEventListener("change", async (ev) => {
      await handleBrowserFiles(ev.target.files, "job");
      ev.target.value = "";
    });

    const chatComposer = document.getElementById("chatComposer");
    chatComposer.addEventListener("dragover", (e) => {
      e.preventDefault();
      chatComposer.classList.add("dragover");
    });
    chatComposer.addEventListener("dragleave", () => chatComposer.classList.remove("dragover"));
    chatComposer.addEventListener("drop", async (e) => {
      e.preventDefault();
      chatComposer.classList.remove("dragover");
      if (e.dataTransfer?.files?.length) {
        await handleBrowserFiles(e.dataTransfer.files, "chat");
      }
    });

    document.getElementById("preflightChatBtn").addEventListener("click", async () => {
      const alertBox = document.getElementById("chatPreflightAlert");
      try {
        const text = document.getElementById("chatMessageInput").value;
        const res = await api("/api/attachments/preflight", {
          method: "POST",
          body: {
            text,
            attachments: state.chatAttachments,
          },
        });
        if (res.blockers.length > 0) {
          alertBox.innerHTML = '<div class="alert-box alert-danger"><strong>Blocked:</strong>\\n' + escapeHtml(res.blockers.join("\\n")) + "</div>";
        } else {
          alertBox.innerHTML =
            '<div class="alert-box alert-success">✅ Preflight passed: ' +
            res.attachments.length +
            " attachment(s), ~" +
            res.estimatedTokens +
            " tokens, 0 secrets found." +
            (res.warnings.length ? "\\nWarnings: " + escapeHtml(res.warnings.join("; ")) : "") +
            "</div>";
        }
      } catch (err) {
        alertBox.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    });

    async function sendChatMessage() {
      if (!state.activeThreadId) return;
      const input = document.getElementById("chatMessageInput");
      const text = input.value;
      const bag = state.chatAttachments;
      const hasAtt = bag.files.length + bag.contexts.length + bag.uploads.length > 0;
      if (!text.trim() && !hasAtt) return;

      const sendBtn = document.getElementById("sendChatBtn");
      const alertBox = document.getElementById("chatPreflightAlert");
      sendBtn.disabled = true;
      alertBox.innerHTML = "";
      try {
        const res = await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/send", {
          method: "POST",
          body: {
            text,
            attachments: hasAtt ? bag : undefined,
          },
        });
        input.value = "";
        state.chatAttachments = { files: [], contexts: [], uploads: [] };
        renderPendingAttachments("chat");
        showToast(res.queued ? "Message queued for next turn" : "Submitted batch turn " + res.jobId);
        if (res.warnings && res.warnings.length) showToast("⚠ " + res.warnings.join(" "), "error");
        await refreshStateQuiet();
      } catch (err) {
        alertBox.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      } finally {
        sendBtn.disabled = false;
      }
    }

    document.getElementById("sendChatBtn").addEventListener("click", sendChatMessage);
    document.getElementById("chatMessageInput").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendChatMessage();
      }
    });

    // ---------------- Workspace File Picker ----------------
    async function openWorkspacePicker(target) {
      state.pickerTarget = target;
      document.getElementById("pickerFilePreview").style.display = "none";
      document.getElementById("workspacePickerModal").classList.add("open");
      await loadWorkspaceFiles();
      renderPickerTable();
    }

    document.getElementById("openWorkspacePickerChatBtn").addEventListener("click", () => openWorkspacePicker("chat"));
    document.getElementById("openWorkspacePickerJobBtn").addEventListener("click", () => openWorkspacePicker("job"));
    document.getElementById("pickerSearchInput").addEventListener("input", renderPickerTable);
    document.getElementById("pickerShowExcluded").addEventListener("change", renderPickerTable);

    async function loadWorkspaceFiles() {
      const data = await api("/api/workspace/files");
      state.workspaceEntries = data.entries || [];
      renderWorkspaceInspectorTable();
    }

    function renderPickerTable() {
      const q = (document.getElementById("pickerSearchInput").value || "").toLowerCase();
      const showExcluded = document.getElementById("pickerShowExcluded").checked;
      const bag = state.pickerTarget === "chat" ? state.chatAttachments : state.jobAttachments;
      const tbody = document.querySelector("#pickerTable tbody");
      const rows = state.workspaceEntries
        .filter((e) => (showExcluded || e.selectable) && (!q || e.relPath.toLowerCase().includes(q)))
        .slice(0, 150);

      tbody.innerHTML = rows
        .map((e) => {
          const isDir = e.kind === "directory";
          const already = isDir ? bag.contexts.includes(e.relPath) : bag.files.includes(e.relPath);
          const statusHtml = e.selectable
            ? '<span class="status-dot status-ready">selectable</span>'
            : '<span class="status-dot status-cancelled">' + escapeHtml(e.excludedLayer || "excluded") + "</span>";
          return (
            "<tr>" +
            '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(e.relPath) + "</td>" +
            "<td>" + escapeHtml(e.kind) + "</td>" +
            "<td>" + (isDir ? "—" : formatBytes(e.bytes)) + "</td>" +
            "<td>" + statusHtml + "</td>" +
            '<td style="display:flex; gap:6px;">' +
            (e.selectable
              ? '<button class="btn btn-sm ' +
                (already ? "btn-primary" : "") +
                '" ' +
                act("toggleWorkspaceSelection", e.relPath, e.kind) +
                ">" +
                (already ? "✓ Attached" : "＋ Attach") +
                "</button>"
              : "") +
            (!isDir && e.selectable
              ? '<button class="btn btn-sm" ' + act("previewWorkspaceFile", e.relPath) + '>👁️ Preview</button>'
              : "") +
            "</td></tr>"
          );
        })
        .join("");
    }

    window.toggleWorkspaceSelection = (relPath, kind) => {
      const bag = state.pickerTarget === "chat" ? state.chatAttachments : state.jobAttachments;
      const list = kind === "directory" ? bag.contexts : bag.files;
      const idx = list.indexOf(relPath);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(relPath);
      renderPendingAttachments(state.pickerTarget);
      renderPickerTable();
    };

    window.previewWorkspaceFile = async (relPath) => {
      try {
        const res = await api("/api/workspace/file-preview?path=" + encodeURIComponent(relPath));
        document.getElementById("pickerFilePreview").style.display = "block";
        document.getElementById("pickerPreviewTitle").textContent =
          res.relPath + " (" + formatBytes(res.bytes) + ", " + res.characters + " chars, sha256:" + res.sha256.slice(0, 12) + "…)";
        document.getElementById("pickerPreviewBody").textContent = res.content;
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    function renderWorkspaceInspectorTable() {
      const q = (document.getElementById("workspaceInspectorFilter").value || "").toLowerCase();
      const tbody = document.querySelector("#workspaceFilesTable tbody");
      if (!tbody) return;
      const rows = state.workspaceEntries.filter((e) => !q || e.relPath.toLowerCase().includes(q)).slice(0, 200);
      tbody.innerHTML = rows
        .map((e) => {
          const status = e.selectable
            ? '<span class="status-dot status-ready">selectable</span>'
            : '<span class="status-dot status-cancelled">' + escapeHtml(e.excludedLayer + (e.rule ? ": " + e.rule : "")) + "</span>";
          return (
            "<tr>" +
            '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(e.relPath) + "</td>" +
            "<td>" + escapeHtml(e.kind) + "</td>" +
            "<td>" + (e.kind === "directory" ? "—" : formatBytes(e.bytes)) + "</td>" +
            "<td>" + status + "</td>" +
            "<td>" +
            (e.selectable
              ? '<button class="btn btn-sm" ' + act("quickAttachToChat", e.relPath, e.kind) + '>Attach to Chat</button>'
              : "") +
            "</td></tr>"
          );
        })
        .join("");
    }
    document.getElementById("workspaceInspectorFilter").addEventListener("input", renderWorkspaceInspectorTable);

    window.quickAttachToChat = (relPath, kind) => {
      const list = kind === "directory" ? state.chatAttachments.contexts : state.chatAttachments.files;
      if (!list.includes(relPath)) list.push(relPath);
      renderPendingAttachments("chat");
      document.querySelector('[data-tab="chat"]').click();
      showToast("Attached " + relPath + " to chat composer");
    };

    // ---------------- Batch Jobs Dashboard & Inspector ----------------
    function renderJobList() {
      const filter = document.getElementById("jobStatusFilter").value;
      const el = document.getElementById("jobList");
      const activeSet = new Set(["draft", "previewed", "submitting", "submitted", "polling", "provider_completed", "retrieving", "cancel_requested"]);
      const filtered = state.jobs.filter((j) => {
        if (filter === "all") return true;
        if (filter === "active") return activeSet.has(j.localStatus);
        if (filter === "ready") return j.localStatus === "ready";
        if (filter === "partial") return j.localStatus === "partial";
        if (filter === "failed") return j.localStatus === "failed" || j.localStatus === "corrupt" || j.localStatus === "expired";
        if (filter === "goal") return !j.kind || j.kind === "goal";
        if (filter === "workflow") return j.kind === "workflow" || j.kind === "synthesis";
        if (filter === "chat") return j.kind === "chat";
        return true;
      });

      if (filtered.length === 0) {
        el.innerHTML = '<div style="padding:14px; color:var(--text-muted); font-size:12px;">No batch jobs match this filter.</div>';
        return;
      }

      el.innerHTML = filtered
        .map((j) => {
          const sel = j.localId === state.selectedJobId ? "selected" : "";
          return (
            '<div class="list-item ' + sel + '" data-job-id="' + escapeHtml(j.localId) + '">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">' +
            '<span style="font-family:var(--mono); font-size:12px; font-weight:600;">' + escapeHtml(j.localId) + "</span>" +
            '<span class="status-dot status-' + escapeHtml(j.localStatus) + '">' + escapeHtml(j.localStatus) + "</span>" +
            "</div>" +
            '<div class="list-item-title" style="font-weight:400;">' + escapeHtml(j.objective) + "</div>" +
            '<div class="list-item-meta">' +
            "<span>" + escapeHtml(j.model) + "</span>" +
            "<span>· " + j.requestCount + " req(s)</span>" +
            (j.usage?.cost !== undefined ? "<span>· $" + Number(j.usage.cost).toFixed(5) + "</span>" : "") +
            "</div></div>"
          );
        })
        .join("");

      el.querySelectorAll("[data-job-id]").forEach((row) => {
        row.addEventListener("click", () => selectJob(row.dataset.jobId));
      });
    }

    document.getElementById("jobStatusFilter").addEventListener("change", renderJobList);

    async function selectJob(localId) {
      state.selectedJobId = localId;
      renderJobList();
      const detail = await api("/api/jobs/" + encodeURIComponent(localId));
      state.selectedJobDetail = detail;
      renderJobDetail(detail);
    }

    function renderJobDetail(detail) {
      const pane = document.getElementById("jobDetailPane");
      const j = detail.job;
      const isPreviewed = j.localStatus === "previewed";
      const isActive = ["submitted", "polling", "provider_completed", "retrieving", "cancel_requested"].includes(j.localStatus);
      const isTerminal = ["ready", "partial", "failed", "cancelled", "expired", "corrupt"].includes(j.localStatus);
      const isChat = j.kind === "chat";

      let subContent = "";
      if (state.jobSubTab === "result") {
        subContent =
          '<div class="msg-card" style="max-width:none;">' +
          '<h4 style="margin-top:0;">' + escapeHtml(detail.readDefault.title) + "</h4>" +
          '<div class="msg-body">' + formatMarkdownLite(detail.readDefault.body) + "</div>" +
          "</div>";
      } else if (state.jobSubTab === "items") {
        const items = detail.items || [];
        subContent =
          '<div class="msg-card" style="max-width:none;">' +
          '<table class="data-table"><thead><tr><th>#</th><th>Custom ID</th><th>Source</th><th>Status</th><th>Chars</th><th>Inspect</th></tr></thead><tbody>' +
          items
            .map(
              (it) =>
                "<tr>" +
                "<td>" + String(it.ordinal).padStart(3, "0") + "</td>" +
                '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(it.customId) + "</td>" +
                '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(it.sourceLabel) + "</td>" +
                '<td><span class="status-dot status-' + escapeHtml(it.status) + '">' + escapeHtml(it.status) + "</span></td>" +
                "<td>" + (it.characters ?? "—") + "</td>" +
                '<td><button class="btn btn-sm" ' + act("inspectJobItem", j.localId, it.ordinal) + '>View Prompt & Output</button></td>' +
                "</tr>",
            )
            .join("") +
          "</tbody></table>" +
          '<div id="itemInspectorBox" style="margin-top:14px;"></div>' +
          "</div>";
      } else if (state.jobSubTab === "artifacts") {
        const arts = detail.artifacts || [];
        subContent =
          '<div class="msg-card" style="max-width:none; display:flex; flex-direction:column; gap:12px;">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">' +
          "<strong>Generate Controlled Artifact from Validated Result</strong>" +
          '<div style="display:flex; gap:8px;">' +
          '<button class="btn btn-sm btn-primary" ' + act("generateJobArtifact", j.localId, "html") + '>Render HTML</button>' +
          '<button class="btn btn-sm btn-primary" ' + act("generateJobArtifact", j.localId, "pdf") + '>Render PDF</button>' +
          '<button class="btn btn-sm" ' + act("generateJobArtifact", j.localId, "markdown") + '>Save Markdown</button>' +
          (j.workflow ? '<button class="btn btn-sm" ' + act("exportDatasetJob", j.localId, "jsonl") + '>Export JSONL</button>' : "") +
          (j.workflow ? '<button class="btn btn-sm" ' + act("exportDatasetJob", j.localId, "csv") + '>Export CSV</button>' : "") +
          "</div></div>" +
          (arts.length
            ? '<table class="data-table"><thead><tr><th>Artifact ID</th><th>Format</th><th>Path</th><th>Size</th><th>Preview / Download</th></tr></thead><tbody>' +
              arts
                .map(
                  (a) =>
                    "<tr>" +
                    '<td style="font-family:var(--mono);">' + escapeHtml(a.artifactId) + "</td>" +
                    "<td>" + escapeHtml(a.format.toUpperCase()) + "</td>" +
                    '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(a.output?.path || "") + "</td>" +
                    "<td>" + formatBytes(a.output?.bytes) + "</td>" +
                    '<td style="display:flex; gap:6px;">' +
                    '<button class="btn btn-sm" ' + act("previewArtifactFrame", a.artifactId) + '>Preview</button>' +
                    '<a class="btn btn-sm" href="/api/artifacts/' + encodeURIComponent(a.artifactId) + '/content?download=1" target="_blank" style="text-decoration:none;">Download</a>' +
                    "</td></tr>",
                )
                .join("") +
              "</tbody></table>"
            : '<div style="color:var(--text-muted); font-size:12px;">No artifacts rendered yet for this job.</div>') +
          '<div id="artifactFrameContainer"></div>' +
          "</div>";
      } else if (state.jobSubTab === "events") {
        subContent =
          '<div class="msg-card" style="max-width:none;">' +
          '<table class="data-table"><thead><tr><th>Timestamp</th><th>Event</th><th>Transition</th><th>Details</th></tr></thead><tbody>' +
          (detail.events || [])
            .map(
              (ev) =>
                "<tr>" +
                '<td style="font-family:var(--mono); font-size:12px;">' + escapeHtml(ev.eventAt) + "</td>" +
                "<td>" + escapeHtml(ev.eventType) + "</td>" +
                "<td>" + (ev.previousStatus ? escapeHtml(ev.previousStatus + " → " + ev.newStatus) : "—") + "</td>" +
                '<td style="font-family:var(--mono); font-size:11px;">' + escapeHtml(ev.details ? JSON.stringify(ev.details) : "") + "</td>" +
                "</tr>",
            )
            .join("") +
          "</tbody></table></div>";
      }

      pane.innerHTML =
        '<div class="pane-header">' +
        '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
        '<strong style="font-family:var(--mono); font-size:15px;">' + escapeHtml(j.localId) + "</strong>" +
        '<span class="status-dot status-' + escapeHtml(j.localStatus) + '">' + escapeHtml(j.localStatus) + "</span>" +
        (j.providerStatus ? '<span style="font-size:12px; color:var(--text-muted);">Provider: ' + escapeHtml(j.providerStatus) + "</span>" : "") +
        "</div>" +
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
        (isPreviewed ? '<button class="btn btn-sm btn-primary" ' + act("submitPreviewedJob", j.localId) + '>🚀 Submit Previewed Batch</button>' : "") +
        (isActive ? '<button class="btn btn-sm" ' + act("pollSingleJob", j.localId) + '>🔄 Poll Now</button>' : "") +
        (isActive || isPreviewed ? '<button class="btn btn-sm btn-danger" ' + act("cancelBatchJob", j.localId) + '>Cancel</button>' : "") +
        (isTerminal && !isChat ? '<button class="btn btn-sm" ' + act("retryBatchJob", j.localId, false) + '>🔁 Retry All</button>' : "") +
        (isTerminal && !isChat && j.requestCount > 1 ? '<button class="btn btn-sm" ' + act("retryBatchJob", j.localId, true) + '>🔁 Retry Failed Items</button>' : "") +
        ((j.localStatus === "ready" || j.localStatus === "partial") && !isChat && j.requestCount > 1 && j.kind !== "synthesis"
          ? '<button class="btn btn-sm btn-primary" ' + act("synthesizeBatchJob", j.localId) + '>✨ Synthesize</button>'
          : "") +
        "</div></div>" +
        '<div style="padding:18px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:16px;">' +
        '<div class="msg-card" style="max-width:none;">' +
        '<div class="kv-grid">' +
        '<div class="kv-label">Objective</div><div class="kv-val">' + escapeHtml(j.objective) + "</div>" +
        '<div class="kv-label">Model / Account</div><div class="kv-val">' + escapeHtml(j.model + " (" + j.account + ")") + "</div>" +
        '<div class="kv-label">Privacy</div><div class="kv-val">' + escapeHtml(describeJobPrivacy(j)) + "</div>" +
        '<div class="kv-label">Remote deletion</div><div class="kv-val">' + escapeHtml(describeRemoteDeletion(j)) + "</div>" +
        '<div class="kv-label">Provider Batch ID</div><div class="kv-val">' + escapeHtml(j.providerBatchId || "—") + "</div>" +
        '<div class="kv-label">Context / Requests</div><div class="kv-val">' + j.requestCount + " request(s) · " + j.context.fileCount + " file(s) · " + j.context.characters + " chars</div>" +
        '<div class="kv-label">Usage & Cost</div><div class="kv-val">' +
        (j.usage ? "In: " + (j.usage.inputTokens ?? 0) + " tok · Out: " + (j.usage.outputTokens ?? 0) + " tok · Cost: $" + Number(j.usage.cost ?? 0).toFixed(6) : "Not reported yet") +
        "</div>" +
        '<div class="kv-label">Request SHA-256</div><div class="kv-val">' + escapeHtml(j.requestSha256) + "</div>" +
        (j.error ? '<div class="kv-label">Error</div><div class="kv-val" style="color:#fca5a5;">[' + escapeHtml(j.error.code) + "] " + escapeHtml(j.error.message) + "</div>" : "") +
        "</div></div>" +
        '<div style="display:flex; gap:8px;">' +
        '<button class="btn btn-sm ' + (state.jobSubTab === "result" ? "btn-primary" : "") + '" ' + act("setJobSubTab", "result") + '>📄 Result & Overview</button>' +
        '<button class="btn btn-sm ' + (state.jobSubTab === "items" ? "btn-primary" : "") + '" ' + act("setJobSubTab", "items") + '>🧩 Items (' + j.requestCount + ")</button>" +
        (!isChat ? '<button class="btn btn-sm ' + (state.jobSubTab === "artifacts" ? "btn-primary" : "") + '" ' + act("setJobSubTab", "artifacts") + '>🖨️ Artifacts & Exports</button>' : "") +
        '<button class="btn btn-sm ' + (state.jobSubTab === "events" ? "btn-primary" : "") + '" ' + act("setJobSubTab", "events") + '>🕒 Lifecycle Events</button>' +
        "</div>" +
        metadataActionsCard(j) +
        subContent +
        "</div>";
    }

    function metadataActionsCard(j) {
      if (!j.workflow || j.workflow.name !== "databricks-metadata") return "";
      if (!["ready", "partial", "failed", "cancelled", "expired", "corrupt"].includes(j.localStatus)) return "";
      const inPath = (j.workflow.input && j.workflow.input.path) || "metadata/tables.jsonl";
      const dir = inPath.includes("/") ? inPath.slice(0, inPath.lastIndexOf("/") + 1) : "";
      const field = (id, label, value) =>
        '<div><label style="font-size:12px; color:var(--text-muted);">' + label + '</label><input type="text" id="' + id + '" value="' + escapeHtml(value) + '" style="width:100%; font-family:var(--mono);"></div>';
      return (
        '<div class="msg-card" style="max-width:none; display:flex; flex-direction:column; gap:10px;">' +
        "<strong>UC Metadata handoff</strong>" +
        '<div style="font-size:12px; color:var(--text-muted);">Writes files into the workspace through the artifact system. Proposals only: nothing is applied to Databricks.</div>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
        field("metadataReviewOut", "Review file (.md)", dir + "review.md") +
        field("metadataApprovedOut", "Approved file (.jsonl)", dir + "approved.jsonl") +
        "</div>" +
        '<div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">' +
        '<label><input type="checkbox" id="metadataOverwrite"> Overwrite existing file</label>' +
        '<label><input type="checkbox" id="metadataAllowPartial"> Allow partial (tables without a proposal keep their existing values)</label>' +
        "</div>" +
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
        '<button class="btn btn-sm btn-primary" ' + act("writeMetadataReview", j.localId) + ">Write review.md</button>" +
        '<button class="btn btn-sm btn-primary" ' + act("writeMetadataApproved", j.localId) + ">Write approved.jsonl</button>" +
        '<button class="btn btn-sm" ' + act("validateMetadataApproved", j.localId) + ">Validate approved file</button>" +
        "</div>" +
        '<div id="metadataActionOutput"></div>' +
        "</div>"
      );
    }

    function metadataOutput(html) {
      const box = document.getElementById("metadataActionOutput");
      if (box) box.innerHTML = html;
    }
    function metadataCounts(c) {
      return c ? c.total + " value(s): " + c.keptExisting + " existing kept, " + c.fromProposal + " from proposals, " + c.nullApproved + " null" : "";
    }
    function metadataProblems(problems) {
      return problems && problems.length ? '<div class="alert-box alert-danger">Problems:\\n- ' + escapeHtml(problems.join("\\n- ")) + "</div>" : "";
    }

    window.writeMetadataReview = async (jobId) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/metadata/review", {
          method: "POST",
          body: { out: document.getElementById("metadataReviewOut").value.trim() || undefined, overwrite: document.getElementById("metadataOverwrite").checked },
        });
        metadataOutput('<div class="alert-box alert-success">Review written: ' + escapeHtml(res.path) + " (artifact " + escapeHtml(res.artifactId) + ")" + (res.gaps ? "\\n" + res.gaps + " table(s) without a usable proposal are listed in it" : "") + "</div>");
        showToast("Wrote " + res.path);
      } catch (err) {
        metadataOutput('<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>");
      }
    };

    window.writeMetadataApproved = async (jobId) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/metadata/approved", {
          method: "POST",
          body: {
            out: document.getElementById("metadataApprovedOut").value.trim(),
            overwrite: document.getElementById("metadataOverwrite").checked,
            allowPartial: document.getElementById("metadataAllowPartial").checked,
          },
        });
        metadataOutput(
          '<div class="alert-box alert-success">Draft handoff written: ' + escapeHtml(res.path) + "\\nsha256 " + escapeHtml(res.sha256) + "\\n" + escapeHtml(metadataCounts(res.counts)) +
            "\\nThis is a draft for review; edit approved_* values, then validate it.</div>" + metadataProblems(res.problems),
        );
        showToast("Wrote " + res.path);
      } catch (err) {
        metadataOutput('<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>");
      }
    };

    window.validateMetadataApproved = async (jobId) => {
      try {
        const res = await api("/api/metadata/validate-approved", {
          method: "POST",
          body: { file: document.getElementById("metadataApprovedOut").value.trim(), job: jobId },
        });
        metadataOutput(
          '<div class="alert-box ' + (res.problems.length ? "alert-danger" : "alert-success") + '">' + escapeHtml(res.path) + ": " + res.rows + " table row(s)" + (res.jobId ? " from job " + escapeHtml(res.jobId) : "") + "; " + escapeHtml(metadataCounts(res.counts)) + "</div>" + metadataProblems(res.problems),
        );
      } catch (err) {
        metadataOutput('<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>");
      }
    };

    window.setJobSubTab = (tab) => {
      state.jobSubTab = tab;
      if (state.selectedJobDetail) renderJobDetail(state.selectedJobDetail);
    };

    window.inspectJobItem = async (jobId, ordinal) => {
      const box = document.getElementById("itemInspectorBox");
      if (!box) return;
      const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/item/" + ordinal);
      box.innerHTML =
        '<div style="border-top:1px solid var(--border); padding-top:12px;">' +
        "<h4>" + escapeHtml(res.title) + "</h4>" +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">' +
        '<div><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Submitted Prompt</div>' +
        '<pre style="max-height:300px; overflow:auto; background:#0b0d13; padding:10px; border-radius:6px; border:1px solid var(--border); font-size:11px;"><code>' +
        escapeHtml(res.prompt || "") +
        "</code></pre></div>" +
        '<div><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Item Result / Details</div>' +
        '<pre style="max-height:300px; overflow:auto; background:#0b0d13; padding:10px; border-radius:6px; border:1px solid var(--border); font-size:11px;"><code>' +
        escapeHtml(res.body || "") +
        "</code></pre></div></div></div>";
    };

    window.submitPreviewedJob = async (jobId) => {
      try {
        await api("/api/jobs/" + encodeURIComponent(jobId) + "/submit", { method: "POST" });
        showToast("Submitted " + jobId + " to OpenRouter");
        await selectJob(jobId);
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.cancelBatchJob = async (jobId) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/cancel", { method: "POST" });
        showToast(res.message);
        await selectJob(jobId);
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.retryBatchJob = async (jobId, failedOnly) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/retry", {
          method: "POST",
          body: { failedOnly },
        });
        showToast("Created retry job " + res.job.localId);
        await refreshStateQuiet();
        await selectJob(res.job.localId);
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.synthesizeBatchJob = async (jobId) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/synthesize", {
          method: "POST",
          body: { allowPartial: true },
        });
        showToast("Created synthesis job " + res.job.localId);
        await refreshStateQuiet();
        await selectJob(res.job.localId);
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.generateJobArtifact = async (jobId, format) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/artifact", {
          method: "POST",
          body: { format, allowPartial: true },
        });
        showToast("Rendered " + format.toUpperCase() + " artifact " + res.artifact.artifactId);
        await selectJob(jobId);
        window.previewArtifactFrame(res.artifact.artifactId);
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    window.previewArtifactFrame = (artifactId) => {
      const c = document.getElementById("artifactFrameContainer");
      if (!c) return;
      c.innerHTML =
        '<div style="margin-top:10px;"><div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Sandboxed Artifact Preview (' +
        escapeHtml(artifactId) +
        ')</div><iframe class="artifact-frame" sandbox="" src="/api/artifacts/' +
        encodeURIComponent(artifactId) +
        '/content"></iframe></div>';
    };

    window.exportDatasetJob = async (jobId, format) => {
      try {
        const res = await api("/api/jobs/" + encodeURIComponent(jobId) + "/export", {
          method: "POST",
          body: { format },
        });
        showToast("Exported " + res.record.records + " rows to " + res.record.path);
        await selectJob(jobId);
      } catch (err) {
        showToast(err.message, "error");
      }
    };

    // ---------------- New Batch Job Studio Modal ----------------
    document.getElementById("newJobTopBtn").addEventListener("click", () => {
      document.getElementById("jobDryRunOutput").innerHTML = "";
      document.getElementById("newJobModal").classList.add("open");
    });

    document.querySelectorAll(".job-kind-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.jobStudioKind = btn.dataset.kind;
        document.querySelectorAll(".job-kind-btn").forEach((b) => b.classList.toggle("btn-primary", b.dataset.kind === state.jobStudioKind));
        const kind = state.jobStudioKind;
        document.getElementById("jobFormAsk").style.display = kind === "dataset" || kind === "metadata" ? "none" : "block";
        document.getElementById("jobFormDataset").style.display = kind === "dataset" ? "block" : "none";
        document.getElementById("jobFormMetadata").style.display = kind === "metadata" ? "block" : "none";
        document.getElementById("jobFormFilesSection").style.display = kind === "dataset" || kind === "metadata" ? "none" : "flex";
        document.getElementById("mapFilesGroupWrap").style.display = state.jobStudioKind === "map-files" ? "block" : "none";
        document.getElementById("jobUploadLabel").style.display = state.jobStudioKind === "ask" ? "inline-flex" : "none";
      });
    });

    async function runJobStudio(mode) {
      // mode: "dryrun" | "preview" | "submit"
      const outBox = document.getElementById("jobDryRunOutput");
      outBox.innerHTML = "";
      const model = document.getElementById("jobModelInput").value.trim() || undefined;
      const format = document.getElementById("jobFormatSelect").value;
      const providerPin = document.getElementById("jobProviderPinInput").value.trim() || undefined;
      try {
        let endpoint = "/api/jobs/ask";
        let payload = {};
        if (state.jobStudioKind === "ask") {
          endpoint = "/api/jobs/ask";
          payload = {
            objective: document.getElementById("askObjectiveInput").value,
            files: state.jobAttachments.files,
            contexts: state.jobAttachments.contexts,
            uploads: state.jobAttachments.uploads,
            model,
            format,
            providerPin,
            mode,
          };
        } else if (state.jobStudioKind === "map-files") {
          endpoint = "/api/jobs/map-files";
          payload = {
            objective: document.getElementById("askObjectiveInput").value,
            files: state.jobAttachments.files,
            contexts: state.jobAttachments.contexts,
            groupSize: Number(document.getElementById("mapFilesGroupSize").value) || 1,
            model,
            format,
            providerPin,
            mode,
          };
        } else if (state.jobStudioKind === "metadata") {
          endpoint = "/api/jobs/metadata";
          payload = {
            context: document.getElementById("metadataContextInput").value.trim(),
            input: document.getElementById("metadataTablesInput").value.trim(),
            domain: document.getElementById("metadataDomainInput").value.trim() || undefined,
            ucPrefix: document.getElementById("metadataPrefixInput").value.trim() || undefined,
            model,
            providerPin,
            mode,
          };
        } else {
          endpoint = "/api/jobs/dataset";
          payload = {
            workflow: document.getElementById("datasetWorkflowSelect").value,
            input: document.getElementById("datasetInputPath").value.trim(),
            model,
            providerPin,
            mode,
          };
        }

        const res = await api(endpoint, { method: "POST", body: payload });
        if (mode === "dryrun") {
          if (res.blockers && res.blockers.length > 0) {
            outBox.innerHTML = '<div class="alert-box alert-danger"><strong>Blocked:</strong>\\n' + escapeHtml(res.blockers.join("\\n")) + "</div>";
          } else if (state.jobStudioKind === "metadata") {
            outBox.innerHTML =
              '<pre style="max-height:320px; overflow:auto; white-space:pre-wrap; background:#0b0d13; padding:10px; border-radius:6px; border:1px solid var(--border); font-size:11px;">' +
              escapeHtml(res.preview) +
              "</pre>" +
              (res.warnings?.length ? '<div class="alert-box alert-danger">Warnings: ' + escapeHtml(res.warnings.join("; ")) + "</div>" : "");
          } else {
            outBox.innerHTML =
              '<div class="alert-box alert-success">✅ Dry-Run Validated:\\n' +
              escapeHtml(res.summary) +
              (res.warnings?.length ? "\\nWarnings: " + escapeHtml(res.warnings.join("; ")) : "") +
              "</div>";
          }
          return;
        }
        document.getElementById("newJobModal").classList.remove("open");
        state.jobAttachments = { files: [], contexts: [], uploads: [] };
        renderPendingAttachments("job");
        document.querySelector('[data-tab="jobs"]').click();
        await refreshStateQuiet();
        await selectJob(res.job.localId);
        showToast(mode === "preview" ? "Saved preview job " + res.job.localId : "Submitted batch job " + res.job.localId);
      } catch (err) {
        outBox.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    }

    document.getElementById("previewJobBtn").addEventListener("click", () => runJobStudio("dryrun"));
    document.getElementById("savePreviewJobBtn").addEventListener("click", () => runJobStudio("preview"));
    document.getElementById("submitJobNowBtn").addEventListener("click", () => runJobStudio("submit"));

    // ---------------- Topbar Poll & Settings ----------------
    document.getElementById("pollAllBtn").addEventListener("click", async () => {
      try {
        const res = await api("/api/jobs/check-all", { method: "POST" });
        showToast("Reconciled " + res.outcomes.length + " active job(s)");
        await refreshStateQuiet();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
      const alertEl = document.getElementById("settingsAlert");
      try {
        const res = await api("/api/config", {
          method: "POST",
          body: {
            defaultModel: document.getElementById("settingsDefaultModel").value.trim(),
            defaultAccount: document.getElementById("settingsDefaultAccount").value.trim(),
            projectInstructions: document.getElementById("settingsProjectInstructions").value,
          },
        });
        alertEl.innerHTML = '<div class="alert-box alert-success">Settings saved to ' + escapeHtml(res.file) + "</div>";
        await refreshStateQuiet();
      } catch (err) {
        alertEl.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
    });

    // ---------------- Privacy, model catalog and picker ----------------
    // Display and requests only: the server re-checks every level, model and route before anything is sent.
    const LEVEL_ORDER = ["standard", "no-training", "zdr"];

    function describeJobPrivacy(j) {
      if (!j.privacy) return "standard (made before privacy levels, or at the default level)";
      return j.privacy.level + " · route: " + j.privacy.route + " · " + j.privacy.enforcement;
    }

    function describeRemoteDeletion(j) {
      const d = j.remoteDeletion;
      if (d) {
        if (d.state === "done") return "deleted at OpenRouter " + (d.at || "");
        if (d.state === "pending" && d.waitingForKey) return "NEEDS ATTENTION: deletion waiting for an API key for account " + j.account + (d.lastError ? ": " + d.lastError : "");
        if (d.state === "pending") return "deletion pending (attempt " + d.attempts + (d.nextAttemptAt ? ", next " + d.nextAttemptAt : "") + ")" + (d.lastError ? ": " + d.lastError : "");
        return "NEEDS ATTENTION: deletion failed after " + d.attempts + " attempt(s)" + (d.lastError ? ": " + d.lastError : "") + "; the batch is kept at OpenRouter up to 30 days, delete it there";
      }
      if ((j.route || "batch") === "immediate") return "not applicable (no provider batch)";
      const strict = !!j.privacy && (j.privacy.level === "no-training" || j.privacy.level === "zdr");
      const ended = ["ready", "partial", "failed", "cancelled", "expired", "corrupt"].includes(j.localStatus);
      const deleting = !state.privacy || state.privacy.deleteRemoteBatches !== false;
      if (strict && deleting && !ended) return "held at OpenRouter until finished; deleted when it ends";
      return "kept up to 30 days";
    }

    function catalogText(c) {
      return c && c.text ? c.text : "";
    }

    function renderPrivacySettings() {
      const p = state.privacy;
      if (!p) return;
      document.getElementById("privacy-level-select").value = p.level;
      document.getElementById("privacyLevelSource").textContent = "(" + p.source + ")" + (p.deleteRemoteBatches ? " · finished batches are deleted at OpenRouter at no-training and zdr" : "");
      document.getElementById("attestState").textContent = p.accountNoTraining
        ? "Attested" + (p.attestedAt ? " " + p.attestedAt : "") + ". " + p.attestNote
        : "Not attested. Batch models are refused at no-training until you attest. " + p.attestNote;
      document.getElementById("attest-privacy-remove").style.display = p.accountNoTraining ? "" : "none";
      document.getElementById("attest-privacy-chk").checked = p.accountNoTraining;
      document.getElementById("attest-privacy-confirm").disabled = p.accountNoTraining || !document.getElementById("attest-privacy-chk").checked;
      document.getElementById("settingsCatalogState").textContent = catalogText(p.catalog);
    }

    async function loadPrivacy() {
      try {
        state.privacy = await api("/api/privacy");
        renderPrivacySettings();
        if (state.activeThreadDetail) renderThreadPrivacy(state.activeThreadDetail);
      } catch {}
    }

    function showPrivacyNotice(text) {
      const box = document.getElementById("privacyNotice");
      box.style.display = "";
      box.innerHTML = '<div class="alert-box alert-warning">' + escapeHtml(text) +
        ' <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer" style="color:#fde68a;">openrouter.ai/settings/privacy</a>' +
        ' <button class="btn btn-sm" id="privacyNoticeDismiss">Dismiss</button></div>';
      document.getElementById("privacyNoticeDismiss").addEventListener("click", () => {
        box.style.display = "none";
        box.innerHTML = "";
      });
    }

    function privacyError(err) {
      document.getElementById("privacyAlert").innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
    }

    document.getElementById("privacy-level-select").addEventListener("change", async (ev) => {
      document.getElementById("privacyAlert").innerHTML = "";
      try {
        const res = await api("/api/privacy", { method: "POST", body: { level: ev.target.value } });
        state.privacy = res;
        state.picker.key = "";
        renderPrivacySettings();
        if (res.notice) showPrivacyNotice(res.notice);
        if (state.activeThreadId) await selectThread(state.activeThreadId, true);
      } catch (err) {
        privacyError(err);
        renderPrivacySettings();
      }
    });

    document.getElementById("attest-privacy-chk").addEventListener("change", (ev) => {
      document.getElementById("attest-privacy-confirm").disabled = !ev.target.checked || (state.privacy && state.privacy.accountNoTraining);
    });

    async function setAttestation(attested) {
      document.getElementById("privacyAlert").innerHTML = "";
      try {
        state.privacy = await api("/api/privacy/attest", { method: "POST", body: { attested } });
        state.picker.key = "";
        renderPrivacySettings();
        if (state.activeThreadId) await selectThread(state.activeThreadId, true);
      } catch (err) {
        privacyError(err);
      }
    }
    document.getElementById("attest-privacy-confirm").addEventListener("click", () => setAttestation(true));
    document.getElementById("attest-privacy-remove").addEventListener("click", () => setAttestation(false));

    async function refreshModels() {
      const status = [document.getElementById("chatCatalogState"), document.getElementById("settingsCatalogState")];
      status.forEach((el) => { el.textContent = "loading models…"; });
      try {
        await api("/api/models/refresh", { method: "POST" });
      } catch (err) {
        privacyError(err);
        showToast(err.message, "error");
      }
      state.picker.key = "";
      await loadPrivacy();
      if (state.activeThreadDetail) renderThreadPrivacy(state.activeThreadDetail);
    }
    document.getElementById("refresh-models-chat").addEventListener("click", refreshModels);
    document.getElementById("refresh-models-settings").addEventListener("click", refreshModels);

    function renderThreadPrivacy(detail) {
      const level = detail.effectiveLevel || "standard";
      const t = detail.thread;
      const free = t.route === "immediate" || /:free$/.test(t.model);
      const badge = document.getElementById("chatPrivacyBadge");
      const parts = [];
      if (level === "zdr") parts.push("🔒 zdr");
      else if (level === "no-training") parts.push("🔒 no-train");
      if (free) parts.push("free");
      badge.style.display = parts.length ? "" : "none";
      badge.textContent = parts.join(" · ");

      const sel = document.getElementById("threadPrivacyLevel");
      sel.value = level;
      Array.from(sel.options).forEach((o) => {
        const lower = LEVEL_ORDER.indexOf(o.value) < LEVEL_ORDER.indexOf(level);
        o.disabled = lower;
        o.title = lower ? "Can't lower below the project level or this thread's raised level" : "";
      });
      sel.disabled = level === "zdr";
      sel.dataset.level = level;

      const key = [t.id, level, t.model, state.privacy && state.privacy.accountNoTraining].join("|");
      if (state.picker.key !== key) {
        state.picker.key = key;
        loadPicker(t.id);
      } else {
        renderPicker();
      }
    }

    document.getElementById("threadPrivacyLevel").addEventListener("change", async (ev) => {
      if (!state.activeThreadId) return;
      const alertEl = document.getElementById("chatModelAlert");
      alertEl.innerHTML = "";
      try {
        await api("/api/threads/" + encodeURIComponent(state.activeThreadId) + "/privacy", { method: "POST", body: { level: ev.target.value } });
        showToast("Thread privacy level raised to " + ev.target.value);
      } catch (err) {
        alertEl.innerHTML = '<div class="alert-box alert-danger">' + escapeHtml(err.message) + "</div>";
      }
      await selectThread(state.activeThreadId, true);
    });

    async function loadPicker(threadId) {
      try {
        const res = await api("/api/models?threadId=" + encodeURIComponent(threadId));
        if (threadId !== state.activeThreadId) return;
        state.picker.entries = res.entries || [];
        state.picker.catalog = res.catalog;
        renderPicker();
      } catch (err) {
        state.picker.key = "";
      }
    }

    function pickerLabel(e) {
      return e.id + "  " + e.labels.map((l) => "[" + l + "]").join(" ");
    }

    function renderPicker() {
      const bar = document.getElementById("chatModelPickerBar");
      bar.style.display = "flex";
      document.getElementById("chatCatalogState").textContent = catalogText(state.picker.catalog);
      const pick = document.getElementById("chatModelPicker");
      const groups = [
        ["batch", "Batch (cheaper, slower)"],
        ["immediate", "Immediate (free)"],
      ];
      let html = '<option value="">Choose a model…</option>';
      groups.forEach(([route, title]) => {
        const rows = state.picker.entries.filter((e) => e.route === route && (state.showBlocked || !e.blocked));
        if (!rows.length) return;
        html += '<optgroup label="' + escapeHtml(title) + '">' +
          rows.map((e) => '<option value="' + escapeHtml(e.id) + '" data-route="' + escapeHtml(e.route) + '"' + (e.blocked ? ' disabled title="' + escapeHtml(e.blocked) + '"' : "") + ">" +
            escapeHtml(pickerLabel(e) + (e.blocked ? "  (blocked)" : "")) + "</option>").join("") +
          "</optgroup>";
      });
      pick.innerHTML = html;
      const blocked = state.picker.entries.filter((e) => e.blocked).length;
      document.getElementById("show-blocked-toggle").title = blocked + " model(s) hidden by the privacy level";
    }

    document.getElementById("chatModelPicker").addEventListener("change", (ev) => {
      const opt = ev.target.selectedOptions[0];
      if (ev.target.value) {
        document.getElementById("chatModelInput").value = ev.target.value;
        state.pickedRoute = { model: ev.target.value, route: opt ? opt.getAttribute("data-route") : null };
      }
    });
    // Typing a different slug drops the picked route; the server then picks it from the model ID.
    document.getElementById("chatModelInput").addEventListener("input", () => {
      state.pickedRoute = null;
    });
    // The route the picker chose for this slug, if the box still holds it.
    function pickedRouteFor(slug) {
      const p = state.pickedRoute;
      return p && p.model === slug && p.route ? p.route : undefined;
    }
    document.getElementById("show-blocked-toggle").addEventListener("change", (ev) => {
      state.showBlocked = ev.target.checked;
      renderPicker();
    });

    bootstrap();
    connectSse();
  </script>
</body>
</html>`;
}
