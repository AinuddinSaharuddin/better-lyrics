/**
 * pictureInPicture.ts
 *
 * Implements the Document Picture-in-Picture (PiP) feature for Better Lyrics.
 * Opens a floating window that mirrors the current synced lyrics and keeps
 * the active line highlighted in real-time via MutationObserver.
 *
 * Requirements:
 *   - Chrome 116+ (Document Picture-in-Picture API)
 *   - No extra manifest permission needed for this API
 */

import { LYRICS_CLASS, LYRICS_WRAPPER_ID } from "@constants";
import { log } from "@utils";

const PIP_BUTTON_ID = "blyrics-pip-btn";
const PIP_LOG_PREFIX = "[BetterLyrics PiP]";

/** Tracks the currently open PiP window, if any. */
let pipWindow: Window | null = null;

/** MutationObserver that watches the main lyrics wrapper for active-line changes. */
let syncObserver: MutationObserver | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the Document Picture-in-Picture API is available in this browser.
 */
export function isPiPSupported(): boolean {
  return "documentPictureInPicture" in window;
}

/**
 * Toggles the PiP window: opens it if closed, closes it if open.
 */
export async function togglePiP(): Promise<void> {
  if (pipWindow && !pipWindow.closed) {
    closePiP();
    return;
  }
  await openPiP();
}

/**
 * Closes the PiP window and cleans up observers.
 */
export function closePiP(): void {
  syncObserver?.disconnect();
  syncObserver = null;

  if (pipWindow && !pipWindow.closed) {
    pipWindow.close();
  }
  pipWindow = null;
  updatePiPButtonState(false);
  log(`${PIP_LOG_PREFIX} closed`);
}

/**
 * Call this when the lyrics change (new song / reload) so the PiP window
 * reflects the latest content without the user toggling it manually.
 */
export function refreshPiPIfOpen(): void {
  if (pipWindow && !pipWindow.closed) {
    renderLyricsIntoPiP();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function openPiP(): Promise<void> {
  if (!isPiPSupported()) {
    log(`${PIP_LOG_PREFIX} Document PiP API not supported in this browser.`);
    return;
  }

  try {
    // @ts-ignore — documentPictureInPicture is not yet in TS lib types
    const pip = window.documentPictureInPicture as {
      requestWindow: (opts: { width: number; height: number }) => Promise<Window>;
    };

    pipWindow = await pip.requestWindow({ width: 380, height: 520 });

    pipWindow.addEventListener("pagehide", () => {
      syncObserver?.disconnect();
      syncObserver = null;
      pipWindow = null;
      updatePiPButtonState(false);
      log(`${PIP_LOG_PREFIX} window closed by user`);
    });

    buildPiPDocument(pipWindow);
    renderLyricsIntoPiP();
    startSyncObserver();
    updatePiPButtonState(true);

    log(`${PIP_LOG_PREFIX} opened`);
  } catch (err) {
    log(`${PIP_LOG_PREFIX} failed to open:`, err);
  }
}

/** Injects base styles into the PiP document so lyrics render correctly. */
function buildPiPDocument(win: Window): void {
  const doc = win.document;

  // Copy all <style> and extension <link rel="stylesheet"> tags from the host page
  const styleEls = document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
    'style, link[rel="stylesheet"]'
  );
  for (const el of styleEls) {
    try {
      doc.head.appendChild(el.cloneNode(true));
    } catch (_) {
      // Some stylesheets may be cross-origin — silently skip
    }
  }

  // Extra PiP-specific layout styles
  const style = doc.createElement("style");
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
    }

    #blyrics-pip-root {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 16px 12px 32px;
      scrollbar-width: thin;
      /* Inherit background from the extension's CSS variables if available */
      background: var(--blyrics-bg, rgba(0,0,0,0.85));
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    /* Clone of lyrics wrapper — allow the existing CSS to take over */
    #blyrics-pip-root #${LYRICS_WRAPPER_ID} {
      position: static !important;
      overflow: visible !important;
    }

    /* Scroll the active line to centre */
    .blyrics--active {
      scroll-margin-block: 40%;
    }
  `;
  doc.head.appendChild(style);

  const root = doc.createElement("div");
  root.id = "blyrics-pip-root";
  doc.body.appendChild(root);
}

/** Deep-clones the current lyrics DOM into the PiP window. */
function renderLyricsIntoPiP(): void {
  if (!pipWindow || pipWindow.closed) return;

  const root = pipWindow.document.getElementById("blyrics-pip-root");
  if (!root) return;

  const sourceWrapper = document.getElementById(LYRICS_WRAPPER_ID);
  if (!sourceWrapper) {
    root.textContent = "";
    log(`${PIP_LOG_PREFIX} lyrics wrapper not found`);
    return;
  }

  // Replace content with a fresh deep clone
  root.replaceChildren(sourceWrapper.cloneNode(true));

  // Scroll the active line into view inside the PiP window
  scrollActiveLine(root);
}

/**
 * Scrolls the currently active lyric line into view within a given container.
 */
function scrollActiveLine(container: HTMLElement): void {
  const activeLine = container.querySelector<HTMLElement>(".blyrics--active");
  activeLine?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Starts a MutationObserver on the main lyrics wrapper so that whenever the
 * active class moves to a different lyric line, the PiP window is updated.
 */
function startSyncObserver(): void {
  syncObserver?.disconnect();

  const sourceWrapper = document.getElementById(LYRICS_WRAPPER_ID);
  if (!sourceWrapper) return;

  syncObserver = new MutationObserver(() => {
    if (!pipWindow || pipWindow.closed) {
      syncObserver?.disconnect();
      return;
    }
    renderLyricsIntoPiP();
  });

  // Watch for class changes on any descendant (active line switching)
  syncObserver.observe(sourceWrapper, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
    characterData: true,
    childList: true,
  });
}

// ---------------------------------------------------------------------------
// PiP toggle button helpers
// ---------------------------------------------------------------------------

/**
 * Creates and returns the PiP toggle button element.
 * Caller is responsible for inserting it into the DOM.
 */
export function createPiPButton(): HTMLElement {
  const existing = document.getElementById(PIP_BUTTON_ID);
  if (existing) return existing;

  const btn = document.createElement("button");
  btn.id = PIP_BUTTON_ID;
  btn.type = "button";
  btn.title = "Picture-in-Picture lyrics";
  btn.setAttribute("aria-label", "Toggle Picture-in-Picture lyrics");

  // Inherit styles from existing footer buttons
  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
    opacity: 0.75;
    transition: opacity 180ms ease;
  `;

  btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
  btn.addEventListener("mouseleave", () => { btn.style.opacity = pipWindow && !pipWindow.closed ? "1" : "0.75"; });

  btn.innerHTML = getPiPIcon(false);

  btn.addEventListener("click", () => {
    togglePiP();
  });

  return btn;
}

/** Updates the PiP button icon and opacity based on active state. */
function updatePiPButtonState(active: boolean): void {
  const btn = document.getElementById(PIP_BUTTON_ID);
  if (!btn) return;
  btn.innerHTML = getPiPIcon(active);
  btn.style.opacity = active ? "1" : "0.75";
  btn.title = active ? "Close Picture-in-Picture" : "Picture-in-Picture lyrics";
}

/**
 * Returns an SVG icon for the PiP button.
 * Uses a filled variant when PiP is active.
 */
function getPiPIcon(active: boolean): string {
  const fillOpacity = active ? "1" : "0.16";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <g fill="none">
      <rect x="2" y="4" width="20" height="14" rx="2"
        fill="currentColor" fill-opacity="${fillOpacity}"
        stroke="currentColor" stroke-width="1.5"/>
      <rect x="12" y="10" width="9" height="6" rx="1"
        fill="currentColor" fill-opacity="${active ? '0.6' : '0'}"
        stroke="currentColor" stroke-width="1.2"/>
    </g>
  </svg>`;
}
