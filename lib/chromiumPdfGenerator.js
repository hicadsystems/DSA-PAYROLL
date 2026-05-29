// ============================================================================
// lib/chromiumPdfGenerator.js============================================================================

const fs = require("fs");
const path = require("path");

// How many pages to render in parallel. Tune via env var.
// 2 is safe for 4GB Pentium. Raise to 4-6 on modern hardware.
const TAB_POOL_SIZE = parseInt(process.env.PDF_TAB_POOL_SIZE);

// How long to wait for fonts after domcontentloaded, in ms.
// Replaces the blanket 1000ms sleep.
const FONT_WAIT_MS = parseInt(process.env.PDF_FONT_WAIT_MS) || 500;

class ChromiumPDFGenerator {
  constructor() {
    this.chromium = null;
    this.puppeteer = null;
    this.launchOptions = null;
    this.initialized = false;
    this.initPromise = null;
    this.browser = null; // ← shared browser instance
    this.browserUses = 0; // reference-count for safe close
    this.isProduction =
      (process.env.NODE_ENV === "production" || process.platform === "linux") &&
      process.env.FORCE_LOCAL !== "true";
    this.logFile = "/home/hicadng/backend/chromium-debug.log";
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, logMessage);
    } catch (err) {
      console.error("Failed to write to log file:", err.message);
    }
  }

  async ensureChromiumExists() {
    const chromiumPath = "/home/hicadng/tmp/.chromium-temp/chromium";

    try {
      // Check if binary exists and is executable
      fs.accessSync(chromiumPath, fs.constants.X_OK);
      this.log("✅ Chromium binary verified");
      return chromiumPath;
    } catch (error) {
      // Binary missing or not executable - re-extract it
      this.log("⚠️ Chromium binary missing, re-extracting...");

      // Clean up the temp directory
      const tempDir = "/home/hicadng/tmp/.chromium-temp";
      const chromiumExtractDir = path.join(tempDir, "chromium-extract");

      try {
        fs.rmSync(chromiumExtractDir, { recursive: true, force: true });
      } catch (e) {}

      fs.mkdirSync(chromiumExtractDir, { recursive: true });

      // Force re-extraction
      const newPath = await this.chromium.executablePath();
      this.log(`✅ Chromium re-extracted to: ${newPath}`);

      // Copy to standard location if needed
      if (newPath !== chromiumPath) {
        fs.copyFileSync(newPath, chromiumPath);
        fs.chmodSync(chromiumPath, 0o755);
        this.log(`✅ Chromium copied to: ${chromiumPath}`);
        return chromiumPath;
      }

      return newPath;
    }
  }

  async initialize() {
    if (this.initialized) return;

    this.log("=== CHROMIUM PDF GENERATOR INITIALIZATION ===");
    this.log(
      `Environment: ${this.isProduction ? "PRODUCTION" : "DEVELOPMENT"}`,
    );
    this.log(`Platform: ${process.platform}`);
    this.log(`Tab pool size: ${TAB_POOL_SIZE}`);

    if (this.isProduction) {
      await this._initializeProduction();
    } else {
      await this._initializeDevelopment();
    }

    this.initialized = true;
    this.log("✅ ChromiumPDFGenerator initialized successfully");
  }

  async _initializeProduction() {
    try {
      this.chromium = require("@sparticuz/chromium");
      this.puppeteer = require("puppeteer-core");
      this.log("✅ Loaded @sparticuz/chromium and puppeteer-core");

      const tempDir = "/home/hicadng/tmp/.chromium-temp";
      const chromiumExtractDir = path.join(tempDir, "chromium-extract");

      this.log(`Temp directory: ${tempDir}`);
      this.log(`Chromium extract directory: ${chromiumExtractDir}`);

      // Create directories
      [tempDir, chromiumExtractDir].forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          this.log(`✅ Created directory: ${dir}`);
        }
      });

      // Set environment variables
      process.env.HOME = "/home/hicadng";
      process.env.TMPDIR = tempDir;
      process.env.TEMP = tempDir;
      process.env.TMP = tempDir;
      process.env.FONTCONFIG_PATH = tempDir;
      process.env.XDG_CACHE_HOME = tempDir;
      this.log("✅ Set environment variables to avoid /tmp");

      // Get executable path
      this.log("📥 Getting Chromium executable path...");
      let executablePath;

      try {
        executablePath = await this.chromium.executablePath();
        this.log(`📍 Chromium executable path: ${executablePath}`);
      } catch (pathError) {
        this.log(`❌ executablePath failed: ${pathError.message}`);
        throw pathError;
      }

      this.log(`📍 Chromium executable path: ${executablePath}`);

      // If still in /tmp, relocate to our directory
      if (executablePath.startsWith("/tmp")) {
        this.log("⚠️ Executable still in /tmp, relocating...");
        const customChromiumPath = path.join(chromiumExtractDir, "chromium");

        if (fs.existsSync(executablePath)) {
          this.log(`Copying from ${executablePath} to ${customChromiumPath}`);
          fs.copyFileSync(executablePath, customChromiumPath);
          fs.chmodSync(customChromiumPath, 0o755);
          executablePath = customChromiumPath;
          this.log(`✅ Relocated Chromium to: ${executablePath}`);
        }
      }

      // Verify binary
      if (fs.existsSync(executablePath)) {
        this.log("✅ Chromium binary exists");

        const stats = fs.statSync(executablePath);
        this.log(`Permissions: ${stats.mode.toString(8)}`);

        try {
          fs.chmodSync(executablePath, 0o755);
          this.log("✅ Set execute permissions");
        } catch (chmodError) {
          this.log(`⚠️ chmod failed: ${chmodError.message}`);
        }

        try {
          fs.accessSync(executablePath, fs.constants.X_OK);
          this.log("✅ Binary is executable");
        } catch (accessError) {
          this.log(`❌ Binary NOT executable: ${accessError.message}`);
        }
      } else {
        this.log(`❌ Binary does not exist at: ${executablePath}`);
      }

      this.launchOptions = {
        args: [
          ...this.chromium.args,
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          "--no-first-run",
          "--no-sandbox",
          "--no-zygote",
          "--single-process",
          `--user-data-dir=${tempDir}`,
          "--disable-software-rasterizer",
          "--disable-extensions",
          `--disk-cache-dir=${tempDir}`,
          "--disable-dev-tools",
          "--disable-web-security",
          "--enable-font-antialiasing",
          // Explicitly disable high-DPI — unnecessary for PDF, burns CPU
          "--force-device-scale-factor=1",
        ],
        defaultViewport: { width: 1240, height: 1754, deviceScaleFactor: 1 },
        executablePath: executablePath,
        headless: true,
        ignoreHTTPSErrors: true,
        env: { ...process.env, FONTCONFIG_PATH: "/usr/share/fonts" },
      };
      this.log("✅ Launch options configured");
    } catch (initError) {
      this.log(`❌ INITIALIZATION ERROR: ${initError.message}`);
      this.log(`Stack: ${initError.stack}`);
      throw initError;
    }
  }

  async _initializeDevelopment() {
    this.puppeteer = require("puppeteer");
    this.launchOptions = {
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1240, height: 1754, deviceScaleFactor: 1 },
    };
    this.log("✅ Configured for local development");
  }

  // ==========================================================================
  // SHARED BROWSER — launch once, reuse, close when done
  // ==========================================================================

  async _getBrowser() {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;

    if (!this.browser || !this.browser.isConnected()) {
      this.log("🚀 Launching shared browser...");
      this.browser = await this.puppeteer.launch(this.launchOptions);
      this.browserUses = 0;
      this.log("✅ Shared browser launched");
    }

    this.browserUses++;
    return this.browser;
  }

  async _releaseBrowser() {
    this.browserUses--;
    if (this.browserUses <= 0 && this.browser) {
      this.log("🔒 Closing shared browser");
      try {
        await this.browser.close();
      } catch (_) {}
      this.browser = null;
      this.browserUses = 0;
    }
  }

  // ==========================================================================
  // RENDER ONE PAGE — reuses an existing browser, opens/closes only the tab
  // ==========================================================================

  async _renderOnePage(browser, htmlContent, options = {}) {
    const page = await browser.newPage();

    try {
      const timeout = options.timeout || 600000;
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      // deviceScaleFactor=1: halves GPU work vs original setting of 2
      await page.setViewport({
        width: 1240,
        height: 1754,
        deviceScaleFactor: 1,
      });

      await page.setContent(htmlContent, {
        waitUntil: "domcontentloaded",
        timeout,
      });

      if (this.isProduction) {
        // Wait for fonts with a real signal instead of a blind sleep
        await Promise.race([
          page.evaluateHandle("document.fonts.ready"),
          new Promise((r) => setTimeout(r, FONT_WAIT_MS)),
        ]);
      }

      const pdfBuffer = await page.pdf({
        format: options.format || "A4",
        landscape: options.landscape !== undefined ? options.landscape : true,
        printBackground: true,
        preferCSSPageSize: true,
        scale: 1.0,
        margin: options.margin || {
          top: "5mm",
          right: "5mm",
          bottom: "5mm",
          left: "5mm",
        },
        tagged: true,
      });

      return pdfBuffer;
    } finally {
      // Always close the tab, even on error
      try {
        await page.close();
      } catch (_) {}
    }
  }

  // ==========================================================================
  // INJECT FONT FALLBACK (production only, unchanged)
  // ==========================================================================

  _injectFonts(htmlContent) {
    if (!this.isProduction) return htmlContent;

    const fontInjection = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap');
        body, table, th, td, div, span, p {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important;
        }
        .header h1, .header h2 { font-family: 'Libre Baskerville', serif !important; }
        .header h1 { font-size: 16px !important; font-weight: 700 !important; letter-spacing: -0.2px; -webkit-text-stroke: 0.2px; margin: 0; }
        .header h2 { font-size: 11px !important; font-weight: 400 !important; letter-spacing: -0.1px; margin: 0; }
        * { -webkit-font-smoothing: antialiased !important; -moz-osx-font-smoothing: grayscale !important; }
      </style>`;

    if (htmlContent.includes("<head>"))
      return htmlContent.replace("<head>", "<head>" + fontInjection);
    if (htmlContent.includes("<html>"))
      return htmlContent.replace(
        "<html>",
        "<html><head>" + fontInjection + "</head>",
      );
    return fontInjection + htmlContent;
  }

  // ==========================================================================
  // PUBLIC: generate from raw HTML (single document — unchanged API)
  // ==========================================================================

  async generateFromHTML(htmlContent, options = {}) {
    this.log("=== GENERATE PDF REQUEST ===");

    const htmlSizeInMB =
      Buffer.byteLength(htmlContent, "utf8") / (1024 * 1024 * 2);
    if (htmlSizeInMB > 10) {
      throw new Error(
        `HTML too large: ${htmlSizeInMB.toFixed(2)}MB. Maximum is 20MB.`,
      );
    }
    this.log(`📏 HTML size: ${htmlSizeInMB.toFixed(2)}MB`);

    htmlContent = this._injectFonts(htmlContent);

    const browser = await this._getBrowser();
    try {
      return await this._renderOnePage(browser, htmlContent, options);
    } finally {
      await this._releaseBrowser();
    }
  }

  // ==========================================================================
  // PUBLIC: generate many HTML pages with a tab pool
  // Called by BaseReportController.generateBatchedPDF instead of
  // generateFromHTML, so the browser is shared across all batches.
  //
  // htmlPages: string[]  — one HTML string per batch
  // options:   same as generateFromHTML
  // onBatch:   optional async callback(buffer, index) for streaming merge
  // ==========================================================================

  async generateManyFromHTML(htmlPages, options = {}, onBatch = null) {
    this.log(
      `=== GENERATE ${htmlPages.length} BATCH PDFs (pool: ${TAB_POOL_SIZE}) ===`,
    );

    const browser = await this._getBrowser();

    try {
      // Process htmlPages through a fixed-size tab pool.
      // On a Pentium this keeps memory bounded while still getting parallelism.
      const results = new Array(htmlPages.length);
      const queue = htmlPages.map((html, i) => ({ html, i }));
      let queuePos = 0;

      async function worker(generator) {
        while (true) {
          // Atomically grab the next item
          const item = queue[queuePos++];
          if (!item) break;

          const injected = generator._injectFonts(item.html);
          generator.log(`🔄 Rendering batch ${item.i + 1}/${htmlPages.length}`);

          const buf = await generator._renderOnePage(
            browser,
            injected,
            options,
          );
          results[item.i] = buf;

          generator.log(
            `✅ Batch ${item.i + 1}/${htmlPages.length} done (${buf.length} bytes)`,
          );

          if (onBatch) await onBatch(buf, item.i);
        }
      }

      // Launch TAB_POOL_SIZE workers concurrently
      const workers = Array.from(
        { length: Math.min(TAB_POOL_SIZE, htmlPages.length) },
        () => worker(this),
      );
      await Promise.all(workers);

      return results;
    } finally {
      await this._releaseBrowser();
    }
  }
}

module.exports = new ChromiumPDFGenerator();