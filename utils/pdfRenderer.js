/**
 * utils/pdfRenderer.js (Render-safe)
 * Renders HTML -> PDF buffer using Puppeteer with hardened flags.
 * Tries multiple strategies to locate Chrome:
 *  1) PUPPETEER_EXECUTABLE_PATH or CHROME_EXECUTABLE_PATH or GOOGLE_CHROME_BIN (env)
 *  2) puppeteer.executablePath() (uses cache dir if configured)
 *  3) plain auto-detect (no explicit executablePath)
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

function resolveExecPath() {
  try {
    return chromium.executablePath();
  } catch {
    return (
      process.env.CHROME_EXECUTABLE_PATH ||
      process.env.GOOGLE_CHROME_BIN ||
      null
    );
  }
}

async function htmlToPdf(html, options = {}) {
  let browser;
  const launchCommon = {
    executablePath: resolveExecPath(),
    defaultViewport: chromium.defaultViewport,
    args: chromium.args,
    headless: chromium.headless,
    protocolTimeout: 90_000, // be generous on cold starts
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
      preferCSSPageSize: true,
      // Optional tuning:
      // scale: 1,
      // timeout: 60000,
    });

    return pdfBuffer;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { htmlToPdf };