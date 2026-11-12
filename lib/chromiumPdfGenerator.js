// ============================================================================
// lib/chromiumPdfGenerator.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const gate = require("./pdfGate");

// ----------------------------------------------------------------------------
// ENV-CONFIGURABLE CONSTANTS
// Every value below has a fallback matching the original hardcoded value,
// so behavior is unchanged unless the corresponding env var is set.
// ----------------------------------------------------------------------------

// How many pages to render in parallel.
// 2 is safe for 4GB Pentium. Raise to 4-6 on modern hardware.
const TAB_POOL_SIZE = parseInt(process.env.PDF_TAB_POOL_SIZE) || 2;

// How long to wait for fonts after domcontentloaded, in ms.
const FONT_WAIT_MS = parseInt(process.env.PDF_FONT_WAIT_MS) || 500;

// App home directory (replaces hardcoded /home/hicadng)
const APP_HOME = process.env.PDF_APP_HOME || "/home/hicadng";

// Base temp directory for Chromium extraction/user-data.
const CHROMIUM_TEMP_DIR =
  process.env.PDF_CHROMIUM_TEMP_DIR ||
  path.join(APP_HOME, "tmp/.chromium-temp");

// Debug log file location
// On Windows the Linux default (C:\home\hicadng\backend) never exists — use ./logs
const LOG_FILE =
  process.env.PDF_LOG_FILE ||
  (process.platform === "win32"
    ? path.join(__dirname, "..", "logs", "chromium-debug.log")
    : path.join(APP_HOME, "backend/chromium-debug.log"));
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch (_) {}

// System font config path used to override FONTCONFIG_PATH at launch time
const SYSTEM_FONTCONFIG_PATH =
  process.env.PDF_SYSTEM_FONTCONFIG_PATH || "/usr/share/fonts";

// Page/viewport sizing
const VIEWPORT_WIDTH = parseInt(process.env.PDF_VIEWPORT_WIDTH) || 1240;
const VIEWPORT_HEIGHT = parseInt(process.env.PDF_VIEWPORT_HEIGHT) || 1754;
const VIEWPORT_SCALE_FACTOR =
  parseFloat(process.env.PDF_VIEWPORT_SCALE_FACTOR) || 1;

// Default per-page render timeout (ms)
const DEFAULT_TIMEOUT_MS =
  parseInt(process.env.PDF_DEFAULT_TIMEOUT_MS) || 600000;

// Default PDF output format/orientation/margins
const DEFAULT_PDF_FORMAT = process.env.PDF_FORMAT || "A4";
const DEFAULT_PDF_LANDSCAPE = process.env.PDF_LANDSCAPE !== "false"; // default true
const DEFAULT_MARGIN_MM = process.env.PDF_MARGIN_MM || "5mm";

// Keep the shared browser open this long after the last PDF (ms), instead of
// closing it after every request and paying a Chromium launch on the next one.
const BROWSER_IDLE_MS = parseInt(process.env.PDF_BROWSER_IDLE_MS) || 120000;

// Restart the shared browser after this many pages (Chromium slowly grows).
const BROWSER_MAX_PAGES = parseInt(process.env.PDF_BROWSER_MAX_PAGES) || 300;

// Max allowed HTML input size, in MB
const MAX_HTML_MB = parseInt(process.env.PDF_MAX_HTML_MB) || 20;

// Google Fonts import + families used in the fallback font injection
const FONT_IMPORT_URL =
  process.env.PDF_FONT_IMPORT_URL ||
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap";
const FONT_BODY_FAMILY = process.env.PDF_FONT_BODY_FAMILY || "Inter";
const FONT_HEADER_FAMILY =
  process.env.PDF_FONT_HEADER_FAMILY || "Libre Baskerville";

class ChromiumPDFGenerator {
  constructor() {
    this.chromium = null;
    this.puppeteer = null;
    this.launchOptions = null;
    this.initialized = false;
    this.initPromise = null;
    this.browser = null; // ← shared browser instance
    this.launching = null; // one launch at a time (no second, leaked browser)
    this.activePages = 0; // tabs open right now (bounded by lib/pdfGate.js)
    this.pagesSinceLaunch = 0;
    this.idleTimer = null;
    this.isProduction =
      (process.env.NODE_ENV === "production" || process.platform === "linux") &&
      process.env.FORCE_LOCAL !== "true";
    this.logFile = LOG_FILE;
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    // Asynchronous: a synchronous write per log line blocks every request under load.
    fs.appendFile(this.logFile, logMessage, (err) => {
      if (err) console.error("Failed to write to log file:", err.message);
    });
  }

  async ensureChromiumExists() {
    const chromiumPath = path.join(CHROMIUM_TEMP_DIR, "chromium");

    try {
      // Check if binary exists and is executable
      fs.accessSync(chromiumPath, fs.constants.X_OK);
      this.log("✅ Chromium binary verified");
      return chromiumPath;
    } catch (error) {
      // Binary missing or not executable - re-extract it
      this.log("⚠️ Chromium binary missing, re-extracting...");

      // Clean up the temp directory
      const chromiumExtractDir = path.join(
        CHROMIUM_TEMP_DIR,
        "chromium-extract",
      );

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
    // Coolify / Docker: a system Chromium (apt) is used when its path is set.
    // cPanel: leave PDF_CHROMIUM_EXECUTABLE / PUPPETEER_EXECUTABLE_PATH unset
    // and the @sparticuz/chromium flow below runs exactly as before.
    const systemChromium =
      process.env.PDF_CHROMIUM_EXECUTABLE ||
      process.env.PUPPETEER_EXECUTABLE_PATH;
    if (systemChromium) {
      return this._initializeSystemChromium(systemChromium);
    }

    try {
      this.chromium = require("@sparticuz/chromium");
      this.puppeteer = require("puppeteer-core");
      this.log("✅ Loaded @sparticuz/chromium and puppeteer-core");

      const tempDir = CHROMIUM_TEMP_DIR;
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
      process.env.HOME = APP_HOME;
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

      // --single-process / --no-zygote break @font-face loading, and
      // @sparticuz/chromium's own args may include --headless=shell, which
      // has no font renderer — strip all of these (see launchBrowser.js).
      const filteredChromiumArgs = this.chromium.args.filter(
        (a) =>
          a !== "--single-process" &&
          a !== "--no-zygote" &&
          !a.startsWith("--headless"),
      );

      this.launchOptions = {
        args: [
          ...filteredChromiumArgs,
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          "--no-first-run",
          "--no-sandbox",
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
        defaultViewport: {
          width: VIEWPORT_WIDTH,
          height: VIEWPORT_HEIGHT,
          deviceScaleFactor: VIEWPORT_SCALE_FACTOR,
        },
        executablePath: executablePath,
        headless: "new", // full headless — has a font renderer, unlike "shell" mode
        ignoreHTTPSErrors: true,
        env: { ...process.env, FONTCONFIG_PATH: SYSTEM_FONTCONFIG_PATH },
      };
      this.log("✅ Launch options configured");
    } catch (initError) {
      this.log(`❌ INITIALIZATION ERROR: ${initError.message}`);
      this.log(`Stack: ${initError.stack}`);
      throw initError;
    }
  }

  async _initializeSystemChromium(executablePath) {
    this.puppeteer = require("puppeteer-core");
    this.log(`✅ Using system Chromium: ${executablePath}`);

    if (!fs.existsSync(executablePath)) {
      throw new Error(`System Chromium not found at ${executablePath}`);
    }

    const tempDir = CHROMIUM_TEMP_DIR;
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    } catch (_) {}

    this.launchOptions = {
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-first-run",
        "--no-sandbox",
        "--disable-software-rasterizer",
        "--disable-extensions",
        `--disk-cache-dir=${tempDir}`,
        "--disable-web-security",
        "--enable-font-antialiasing",
        "--force-device-scale-factor=1",
      ],
      userDataDir: tempDir,
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: VIEWPORT_SCALE_FACTOR,
      },
      executablePath,
      headless: "new",
      ignoreHTTPSErrors: true,
      // FONTCONFIG_PATH must be the dir holding fonts.conf (/etc/fonts on Debian)
      env: {
        ...process.env,
        FONTCONFIG_PATH: process.env.PDF_SYSTEM_FONTCONFIG_PATH || "/etc/fonts",
      },
    };
    this.log("✅ Launch options configured (system Chromium)");
  }

  async _initializeDevelopment() {
    this.puppeteer = require("puppeteer");
    this.launchOptions = {
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: VIEWPORT_SCALE_FACTOR,
      },
    };
    this.log("✅ Configured for local development");
  }

  // ==========================================================================
  // SHARED BROWSER — one browser for the whole app, launched once, kept open
  // while PDFs are being made, closed after BROWSER_IDLE_MS idle, restarted
  // after BROWSER_MAX_PAGES pages or if it crashes. How many tabs are open at
  // once is decided by lib/pdfGate.js, not here.
  // ==========================================================================

  async _useBrowser() {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.browser || !this.browser.isConnected()) {
      if (!this.launching) {
        this.launching = (async () => {
          this.log("🚀 Launching shared browser...");
          const b = await this.puppeteer.launch(this.launchOptions);
          b.on("disconnected", () => {
            if (this.browser === b) {
              this.log("⚠️ Shared browser disconnected");
              this.browser = null;
            }
          });
          this.browser = b;
          this.pagesSinceLaunch = 0;
          this.log("✅ Shared browser launched");
          return b;
        })().finally(() => {
          this.launching = null;
        });
      }
      await this.launching;
    }

    this.activePages++;
    return this.browser;
  }

  _doneWithBrowser() {
    this.activePages = Math.max(0, this.activePages - 1);
    this.pagesSinceLaunch++;
    if (this.activePages > 0 || !this.browser) return;

    if (this.pagesSinceLaunch >= BROWSER_MAX_PAGES) {
      this.log(`♻️ Restarting shared browser after ${this.pagesSinceLaunch} pages`);
      this._closeBrowser();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activePages === 0) {
        this.log("🔒 Closing idle shared browser");
        this._closeBrowser();
      }
    }, BROWSER_IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _closeBrowser() {
    const b = this.browser;
    this.browser = null;
    if (b) b.close().catch(() => {});
  }

  _isBrowserCrash(err) {
    return /Target closed|Session closed|Protocol error|browser has disconnected|Connection closed|Navigating frame was detached/i.test(
      String((err && err.message) || ""),
    );
  }

  /**
   * Render one HTML document to PDF through the gate (lib/pdfGate.js).
   * options.priority: "high" for staff payslips (may be refused with
   * BusyError when the server is full), "low" (default) for everything else.
   * A browser crash is retried once on a fresh browser.
   */
  async _render(htmlContent, options = {}) {
    return gate.run(
      async () => {
        for (let attempt = 0; ; attempt++) {
          const browser = await this._useBrowser();
          try {
            return await this._renderOnePage(browser, htmlContent, options);
          } catch (err) {
            if (attempt === 0 && this._isBrowserCrash(err)) {
              this.log(`⚠️ Browser crashed during render, retrying once: ${err.message}`);
              if (this.browser === browser) this._closeBrowser();
              continue;
            }
            throw err;
          } finally {
            this._doneWithBrowser();
          }
        }
      },
      { priority: options.priority || "low" },
    );
  }

  /**
   * For code that drives the page itself (its own waitUntil, delays, page.pdf
   * options): runs fn(page) on a tab of the shared browser, through the same
   * gate as every other PDF. The tab is always closed. A Uint8Array result
   * (page.pdf) comes back as a Buffer, so res.send() sends bytes, not JSON.
   *   options: { priority: "high" | "low" (default), timeout (ms) }
   */
  async withPage(fn, options = {}) {
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    return gate.run(
      async () => {
        for (let attempt = 0; ; attempt++) {
          const browser = await this._useBrowser();
          let page = null;
          try {
            page = await browser.newPage();
            page.setDefaultTimeout(timeout);
            page.setDefaultNavigationTimeout(timeout);
            const out = await fn(page);
            return out instanceof Uint8Array && !Buffer.isBuffer(out) ? Buffer.from(out) : out;
          } catch (err) {
            if (attempt === 0 && this._isBrowserCrash(err)) {
              this.log(`⚠️ Browser crashed during render, retrying once: ${err.message}`);
              if (this.browser === browser) this._closeBrowser();
              continue;
            }
            throw err;
          } finally {
            if (page) await page.close().catch(() => {});
            this._doneWithBrowser();
          }
        }
      },
      { priority: options.priority || "low" },
    );
  }

  // ==========================================================================
  // RENDER ONE PAGE — reuses an existing browser, opens/closes only the tab
  // ==========================================================================

  async _renderOnePage(browser, htmlContent, options = {}) {
    const page = await browser.newPage();

    try {
      const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      // deviceScaleFactor: halves GPU work vs a factor of 2
      await page.setViewport({
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: VIEWPORT_SCALE_FACTOR,
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
        format: options.format || DEFAULT_PDF_FORMAT,
        landscape:
          options.landscape !== undefined
            ? options.landscape
            : DEFAULT_PDF_LANDSCAPE,
        printBackground: true,
        preferCSSPageSize: true,
        scale: 1.0,
        margin: options.margin || {
          top: DEFAULT_MARGIN_MM,
          right: DEFAULT_MARGIN_MM,
          bottom: DEFAULT_MARGIN_MM,
          left: DEFAULT_MARGIN_MM,
        },
        tagged: true,
      });

      // puppeteer returns a Uint8Array; res.send() needs a Buffer to send bytes
      return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
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
        @import url('${FONT_IMPORT_URL}');
        body, table, th, td, div, span, p {
          font-family: '${FONT_BODY_FAMILY}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif !important;
        }
        .header h1, .header h2 { font-family: '${FONT_HEADER_FAMILY}', serif !important; }
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
    if (htmlSizeInMB > MAX_HTML_MB / 2) {
      throw new Error(
        `HTML too large: ${htmlSizeInMB.toFixed(2)}MB. Maximum is ${MAX_HTML_MB}MB.`,
      );
    }
    this.log(`📏 HTML size: ${htmlSizeInMB.toFixed(2)}MB`);

    htmlContent = this._injectFonts(htmlContent);

    return this._render(htmlContent, options);
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

    {
      // Process htmlPages through a fixed-size tab pool. Each page also passes
      // the app-wide gate (lib/pdfGate.js) at low priority.
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

          const buf = await generator._render(injected, {
            ...options,
            priority: options.priority || "low",
          });
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
    }
  }
}

module.exports = new ChromiumPDFGenerator();
