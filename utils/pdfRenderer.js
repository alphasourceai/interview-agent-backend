/**
 * utils/pdfRenderer.js (Render-safe)
 * Renders HTML -> PDF buffer using Puppeteer with hardened flags.
 * Tries multiple strategies to locate Chrome:
 *  1) PUPPETEER_EXECUTABLE_PATH or CHROME_EXECUTABLE_PATH or GOOGLE_CHROME_BIN (env)
 *  2) puppeteer.executablePath() (uses cache dir if configured)
 *  3) plain auto-detect (no explicit executablePath)
 */

const puppeteer = require('puppeteer');

function resolveExecPath() {
  // Prefer explicit configuration from env (set in Render or elsewhere)
  const envPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_EXECUTABLE_PATH ||
    process.env.GOOGLE_CHROME_BIN ||
    null;

  if (envPath) return envPath;

  // Fall back to Puppeteer's own detection (respects PUPPETEER_CACHE_DIR if set)
  try {
    const { executablePath } = require('puppeteer');
    const p = typeof executablePath === 'function' ? executablePath() : null;
    return p || null;
  } catch {
    return null;
  }
}

async function htmlToPdf(html, options = {}) {
  let browser;
  const launchCommon = {
    headless: true,
    protocolTimeout: 90_000, // be generous on cold starts
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
  };

  const execPath = resolveExecPath();

  try {
    // Try with an explicit executablePath first if we have one
    if (execPath) {
      try {
        browser = await puppeteer.launch({
          ...launchCommon,
          executablePath: execPath,
        });
      } catch (err) {
        console.warn('[pdfRenderer] Launch with resolved executablePath failed, retrying without explicit path:', err?.message);
      }
    }

    // Fallback: let Puppeteer auto-detect a bundled browser (if available)
    if (!browser) {
      browser = await puppeteer.launch(launchCommon);
    }

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