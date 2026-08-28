import { stripVTControlCharacters } from "node:util";
import { escapeHtmlText } from "@bb/domain";

export type LocalViewModel =
  | InfoViewModel
  | LoadingViewModel
  | PairingViewModel
  | StartupErrorViewModel;

export interface LoadingViewModel {
  kind: "loading";
  message: string;
  title: string;
}

export interface InfoViewModel {
  kind: "info";
  message: string;
  title: string;
}

export interface PairingViewModel {
  approvalUrl: string;
  coordinator: string;
  deviceName: string;
  expiresAt: number;
  kind: "pairing";
  userCode: string;
}

export interface StartupErrorViewModel {
  details: string;
  kind: "error";
  logText: string;
  title: string;
}

export interface CreateLocalViewUrlArgs {
  viewModel: LocalViewModel;
}

function formatPlainLogText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/gu, "\n");
}

function renderLoadingView(viewModel: LoadingViewModel): string {
  return `
    <main class="shell">
      <div class="spinner"></div>
      <h1>${escapeHtmlText(viewModel.title)}</h1>
      <p>${escapeHtmlText(viewModel.message)}</p>
    </main>
  `;
}

function renderInfoView(viewModel: InfoViewModel): string {
  return `
    <main class="shell">
      <h1>${escapeHtmlText(viewModel.title)}</h1>
      <p>${escapeHtmlText(viewModel.message)}</p>
    </main>
  `;
}

function renderPairingView(viewModel: PairingViewModel): string {
  const expiresAt = new Date(viewModel.expiresAt).toISOString();
  return `
    <main class="shell pairing-shell">
      <div class="eyebrow">Connect this Mac</div>
      <h1>Continue in your browser</h1>
      <p class="lede">BB opened the approval guide for <strong>${escapeHtmlText(viewModel.coordinator)}</strong>. The desktop app never receives your Authelia session.</p>
      <section class="pairing-card" aria-labelledby="pairing-code-title">
        <div id="pairing-code-title" class="pairing-label">Verify this code</div>
        <div class="pairing-code" data-testid="native-pairing-code">${escapeHtmlText(viewModel.userCode)}</div>
        <div class="pairing-device">${escapeHtmlText(viewModel.deviceName)}</div>
      </section>
      <a class="primary-action" href="${escapeHtmlText(viewModel.approvalUrl)}" target="_blank" rel="noreferrer">Open approval page</a>
      <ol class="steps">
        <li><span>1</span><div><strong>Open the approval page</strong><small>Use the button above if your browser did not come forward.</small></div></li>
        <li><span>2</span><div><strong>Match the code</strong><small>Approve only if the browser shows the same device and code.</small></div></li>
        <li><span>3</span><div><strong>Return here</strong><small>BB will connect this Mac automatically.</small></div></li>
      </ol>
      <p class="expiry">This one-time request expires <time datetime="${expiresAt}">${escapeHtmlText(expiresAt)}</time>.</p>
    </main>
  `;
}

function renderErrorView(viewModel: StartupErrorViewModel): string {
  const logText = formatPlainLogText(viewModel.logText);
  const logs =
    logText.trim().length > 0 ? `<pre>${escapeHtmlText(logText)}</pre>` : "";
  return `
    <main class="shell shell-error">
      <h1>${escapeHtmlText(viewModel.title)}</h1>
      <p>${escapeHtmlText(viewModel.details)}</p>
      ${logs}
    </main>
  `;
}

function renderLocalView(viewModel: LocalViewModel): string {
  let body: string;
  if (viewModel.kind === "loading") {
    body = renderLoadingView(viewModel);
  } else if (viewModel.kind === "info") {
    body = renderInfoView(viewModel);
  } else if (viewModel.kind === "pairing") {
    body = renderPairingView(viewModel);
  } else {
    body = renderErrorView(viewModel);
  }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>bb</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      align-items: center;
      background: Canvas;
      color: CanvasText;
      display: flex;
      height: 100vh;
      justify-content: center;
      margin: 0;
    }

    .titlebar-drag-region {
      app-region: drag;
      -webkit-app-region: drag;
      background: transparent;
      border: 0;
      height: 28px;
      left: 0;
      position: fixed;
      right: 0;
      top: 0;
      user-select: none;
      z-index: 10;
    }

    button,
    a,
    input,
    textarea,
    select,
    summary,
    pre {
      app-region: no-drag;
      -webkit-app-region: no-drag;
    }

    .shell {
      max-width: 680px;
      padding: 32px;
      text-align: center;
    }

    .shell-error {
      text-align: left;
    }

    .pairing-shell {
      max-width: 540px;
      padding-bottom: 48px;
    }

    .eyebrow {
      color: color-mix(in srgb, CanvasText 54%, transparent);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0;
      line-height: 1.25;
      margin: 16px 0 8px;
    }

    p {
      color: color-mix(in srgb, CanvasText 74%, transparent);
      font-size: 14px;
      line-height: 1.5;
      margin: 0;
    }

    .lede {
      margin: 0 auto;
      max-width: 470px;
    }

    .lede strong {
      color: CanvasText;
      font-weight: 550;
    }

    .pairing-card {
      background: color-mix(in srgb, CanvasText 5%, Canvas);
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 14px;
      margin: 24px 0 20px;
      padding: 22px;
    }

    .primary-action {
      background: CanvasText;
      border-radius: 8px;
      color: Canvas;
      display: inline-block;
      font-size: 13px;
      font-weight: 600;
      margin: 0 0 16px;
      padding: 10px 16px;
      text-decoration: none;
    }

    .pairing-label,
    .pairing-device,
    .expiry {
      color: color-mix(in srgb, CanvasText 58%, transparent);
      font-size: 12px;
    }

    .pairing-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 28px;
      font-weight: 650;
      letter-spacing: 0.08em;
      margin: 10px 0 8px;
    }

    .steps {
      display: grid;
      gap: 10px;
      list-style: none;
      margin: 0;
      padding: 0;
      text-align: left;
    }

    .steps li {
      align-items: center;
      display: grid;
      gap: 12px;
      grid-template-columns: 28px 1fr;
      padding: 6px 10px;
    }

    .steps li > span {
      align-items: center;
      background: color-mix(in srgb, CanvasText 9%, transparent);
      border-radius: 999px;
      display: flex;
      font-size: 12px;
      height: 28px;
      justify-content: center;
      width: 28px;
    }

    .steps strong,
    .steps small {
      display: block;
    }

    .steps strong {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 2px;
    }

    .steps small {
      color: color-mix(in srgb, CanvasText 58%, transparent);
      font-size: 12px;
      line-height: 1.35;
    }

    .expiry {
      margin-top: 18px;
    }

    pre {
      background: color-mix(in srgb, CanvasText 8%, transparent);
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      margin: 18px 0 0;
      max-height: 260px;
      overflow: auto;
      padding: 12px;
      white-space: pre-wrap;
    }

    .spinner {
      animation: spin 0.9s linear infinite;
      border: 2px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-top-color: CanvasText;
      border-radius: 999px;
      height: 24px;
      margin: 0 auto;
      width: 24px;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  </style>
</head>
<body>
<div class="titlebar-drag-region" data-testid="bb-local-view-window-drag-region" aria-hidden="true"></div>
${body}
</body>
</html>`;
}

export function createLocalViewUrl(args: CreateLocalViewUrlArgs): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    renderLocalView(args.viewModel),
  )}`;
}
