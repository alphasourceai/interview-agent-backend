// utils/pdfRenderer.js (Render-safe)
// Renders HTML -> PDF buffer using Puppeteer.
// Uses PUPPETEER_EXECUTABLE_PATH if provided (Render), and hardened flags.

const puppeteer = require('puppeteer');
const fs = require('fs');

// Prefer Puppeteer's bundled Chromium; fall back to env-provided paths if present.
function resolveExecutablePath() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.CHROME_PATH,
  ].filter(Boolean);

  for (const p of envCandidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

  try {
    const p = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;
    if (p && fs.existsSync(p)) return p;
  } catch {}

  return null; // let Puppeteer choose
}

// Safe flags for containerized Chrome
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

function getLaunchOptions(forceNoExecPath = false) {
  const opts = {
    args: CHROME_ARGS,
    headless: 'new',
  };

  if (!forceNoExecPath) {
    const execPath = resolveExecutablePath();
    if (execPath) {
      opts.executablePath = execPath;
    }
  }

  return opts;
}

/**
 * Render HTML string to a PDF Buffer.
 * @param {string} html - Full HTML document string.
 * @param {object} [options]
 * @param {string} [options.format="A4"]
 * @param {boolean} [options.printBackground=true]
 * @param {object} [options.margin] - { top,right,bottom,left }
 * @returns {Promise<Buffer>}
 */
async function htmlToPdf(html, options = {}) {
  let browser;
  try {
    // Try with resolved executablePath first
    try {
      browser = await puppeteer.launch(getLaunchOptions(false));
    } catch (e1) {
      console.warn('[pdfRenderer] Launch with resolved executablePath failed, retrying without explicit path:', e1?.message);
      browser = await puppeteer.launch(getLaunchOptions(true));
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });

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
    });

    return pdfBuffer;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { htmlToPdf };