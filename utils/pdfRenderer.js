// utils/pdfRenderer.js (Render-safe)
// Renders HTML -> PDF buffer using Puppeteer.
// Uses PUPPETEER_EXECUTABLE_PATH if provided (Render), and hardened flags.

const puppeteer = require('puppeteer');

// Safe flags for containerized Chrome
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

function getLaunchOptions() {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const opts = {
    args: CHROME_ARGS,
    headless: 'new', // modern headless mode
  };
  if (execPath && execPath.trim()) {
    opts.executablePath = execPath.trim();
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
  const browser = await puppeteer.launch(getLaunchOptions());
  try {
    const page = await browser.newPage();

    // Deterministic rendering environment
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

    await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });

    // Ensure webfonts have loaded before printing
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
    await browser.close();
  }
}

module.exports = { htmlToPdf };