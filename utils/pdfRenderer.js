/**
 * utils/pdfRenderer.js (Render-safe)
 * Renders HTML -> PDF buffer using Puppeteer with hardened flags.
 * Chrome resolution order:
 *  1) PUPPETEER_EXECUTABLE_PATH (env) — set by Render when we install system Chromium
 *  2) @sparticuz/chromium.executablePath() — MUST be awaited
 *  3) CHROME_EXECUTABLE_PATH / GOOGLE_CHROME_BIN (env) fallback
 *  4) Final static fallback: /usr/bin/chromium
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

async function resolveExecPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && process.env.PUPPETEER_EXECUTABLE_PATH.trim()) {
    return process.env.PUPPETEER_EXECUTABLE_PATH.trim();
  }
  try {
    // @sparticuz/chromium returns a Promise — we MUST await or we pass [object Promise]
    const p = await chromium.executablePath();
    if (p) return p;
  } catch (_) {
    // ignore and try env fallbacks
  }
  if (process.env.CHROME_EXECUTABLE_PATH && process.env.CHROME_EXECUTABLE_PATH.trim()) {
    return process.env.CHROME_EXECUTABLE_PATH.trim();
  }
  if (process.env.GOOGLE_CHROME_BIN && process.env.GOOGLE_CHROME_BIN.trim()) {
    return process.env.GOOGLE_CHROME_BIN.trim();
  }
  // Final safety net for Debian/Ubuntu based images on Render
  return '/usr/bin/chromium';
}

async function htmlToPdf(html, options = {}) {
  let browser;
  const executablePath = await resolveExecPath(); // <- ensure string, not Promise

  const launchCommon = {
    executablePath,
    defaultViewport: chromium.defaultViewport,
    args: chromium.args,
    headless: chromium.headless,
    protocolTimeout: 90_000
  };

  try {
    browser = await puppeteer.launch(launchCommon);

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

    // Load content and wait for network to settle
    await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });

    // Ensure webfonts are ready (best-effort)
    try {
      await page.evaluate(async () => {
        if (document.fonts && document.fonts.ready) {
          await document.fonts.ready;
        }
      });
    } catch {}

    await page.emulateMediaType('screen');

    const pdfBuffer = await page.pdf({
      format: options.format || 'A4',
      printBackground: options.printBackground !== false,
      margin: options.margin || { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
      preferCSSPageSize: true
    });

    return pdfBuffer;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { htmlToPdf };