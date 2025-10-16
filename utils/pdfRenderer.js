// utils/pdfRenderer.js (Render-safe)
// Renders HTML -> PDF buffer using Puppeteer.
// Uses hardened flags.

const puppeteer = require('puppeteer');
const { executablePath } = require('puppeteer');

async function htmlToPdf(html, options = {}) {
  let browser;
  const launchCommon = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
  };

  try {
    try {
      browser = await puppeteer.launch(launchCommon);
    } catch (err) {
      console.warn('[pdfRenderer] Launch auto-detect failed, retrying with executablePath():', err?.message);
      browser = await puppeteer.launch({
        ...launchCommon,
        executablePath: executablePath()
      });
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
    if (browser) await browser.close();
  }
}

module.exports = { htmlToPdf };