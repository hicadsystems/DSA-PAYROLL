// ============================================================================
// controllers/Reports/reportsFallbackController.js  (BaseReportController)============================================================================

const jsreport = require("jsreport-core")();
const chromiumPdfGenerator = require("../../lib/chromiumPdfGenerator");
const Handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");

class BaseReportController {
  constructor() {
    this.jsreportReady = false;
    this.fallbackReady = true;

    const forceFallback = process.env.USE_JSREPORT_FALLBACK === "true";

    if (forceFallback) {
      console.log(
        "⚠️  JSReport disabled via USE_JSREPORT_FALLBACK=true - using Chromium fallback",
      );
      this.jsreportReady = false;
    } else {
      this.initJSReport();
    }

    this.registerHandlebarsHelpers();
  }

  async initJSReport() {
    try {
      jsreport.use(require("jsreport-handlebars")());
      jsreport.use(require("jsreport-chrome-pdf")());
      await jsreport.init();
      this.jsreportReady = true;
      console.log("✅ JSReport initialized");
    } catch (error) {
      console.error(
        "⚠️  JSReport initialization failed, will use Chromium fallback:",
        error.message,
      );
      this.jsreportReady = false;
    }
  }

  registerHandlebarsHelpers() {
    const helpersCode = this._getCommonHelpers();

    const helperFunctions = new Function(`
      ${helpersCode}
      return {
        formatCurrency,
        formatCurrencyWithSign,
        isNegative,
        abs,
        formatDate,
        formatTime,
        formatPeriod,
        formatMonth,
        add,
        subtract,
        eq,
        gt,
        gte,
        lt,
        lte,
        sum,
        groupBy,
        sumByType,
        getSeverity,
        getSeverityClass
      };
    `)();

    Object.keys(helperFunctions).forEach((name) => {
      Handlebars.registerHelper(name, helperFunctions[name]);
    });

    console.log("✅ Handlebars helpers registered for fallback");
  }

  _getCommonHelpers() {
    return `
      function formatCurrency(value) {
        const num = parseFloat(value) || 0;
        return num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      function formatCurrencyWithSign(amount) {
        const num = parseFloat(amount || 0);
        const formatted = Math.abs(num).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return num < 0 ? '(' + formatted + ')' : formatted;
      }
      function abs(value) { return Math.abs(parseFloat(value) || 0); }
      function isNegative(amount) { return parseFloat(amount || 0) < 0; }
      function formatDate(date) {
        return new Date(date || new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      }
      function formatTime(date) {
        return new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
      }
      function formatPeriod(period) {
        if (!period || period.length !== 6) return period;
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return (months[parseInt(period.substring(4,6)) - 1] || period.substring(4,6)) + ' ' + period.substring(0,4);
      }
      function formatMonth(monthNumber) {
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return monthNames[monthNumber - 1] || 'Unknown';
      }

      function add(a, b) {
        return (parseFloat(a) || 0) + (parseFloat(b) || 0);
      }
      
      function subtract(a, b) {
        return (parseFloat(a) || 0) - (parseFloat(b) || 0);
      }
      
      function eq(a, b) {
        return a === b;
      }
      
      function gt(a, b) {
        return parseFloat(a) > parseFloat(b);
      }
      
      function gte(a, b) {
        return parseFloat(a) >= parseFloat(b);
      }
      
      function lt(a, b) {
        return parseFloat(a) < parseFloat(b);
      }
      
      function lte(a, b) {
        return parseFloat(a) <= parseFloat(b);
      }
      
      function sum(array, property) {
        if (!array || !Array.isArray(array)) return 0;
        return array.reduce((sum, item) => sum + (parseFloat(item[property]) || 0), 0);
      }
      
      function groupBy(array, property) {
        if (!array || !Array.isArray(array)) return [];
        
        const groups = {};
        array.forEach(item => {
          const key = item[property] || 'Unknown';
          if (!groups[key]) {
            groups[key] = [];
          }
          groups[key].push(item);
        });
        
        return Object.keys(groups).sort().map(key => ({
          key: key,
          values: groups[key]
        }));
      }
      
      function sumByType(earnings, type) {
        let total = 0;
        if (Array.isArray(earnings)) {
          earnings.forEach(item => {
            if (item.type === type) {
              total += parseFloat(item.amount) || 0;
            }
          });
        }
        return total;
      }

      function getSeverity(count) {
        if (count === 2) return 'Low';
        if (count <= 4) return 'Medium';
        return 'High';
      }

      function getSeverityClass(count) {
        if (count === 2) return 'severity-low';
        if (count <= 4) return 'severity-medium';
        return 'severity-high';
      }
    `;
  }

  // ==========================================================================
  // SINGLE-DOCUMENT PDF  (reports, not payslips)
  // Unchanged from original — used by all non-batched report routes.
  // ==========================================================================

  async generatePDFWithFallback(templatePath, templateData, pdfOptions = {}) {
    if (!fs.existsSync(templatePath)) {
      throw new Error(`PDF template file not found: ${templatePath}`);
    }

    const templateContent = fs.readFileSync(templatePath, "utf8");

    if (this.jsreportReady) {
      try {
        console.log("🔄 Attempting PDF generation with JSReport...");
        const result = await jsreport.render({
          template: {
            content: templateContent,
            engine: "handlebars",
            recipe: "chrome-pdf",
            chrome: {
              displayHeaderFooter: pdfOptions.displayHeaderFooter || false,
              printBackground: pdfOptions.printBackground !== false,
              format: pdfOptions.format || "A4",
              landscape: pdfOptions.landscape !== false,
              marginTop: pdfOptions.marginTop || "5mm",
              marginBottom: pdfOptions.marginBottom || "5mm",
              marginLeft: pdfOptions.marginLeft || "5mm",
              marginRight: pdfOptions.marginRight || "5mm",
              timeout: pdfOptions.timeout || 120000,
            },
            helpers: pdfOptions.helpers || this._getCommonHelpers(),
          },
          data: templateData,
          options: pdfOptions.options || {},
        });
        console.log("✅ PDF generated successfully with JSReport");
        return result.content;
      } catch (jsreportError) {
        console.error(
          "⚠️  JSReport failed, switching to Chromium fallback:",
          jsreportError.message,
        );
        this.jsreportReady = false;
      }
    }

    console.log("🔄 Using Chromium fallback for PDF generation...");
    const template = Handlebars.compile(templateContent);
    const html = template(templateData);

    const pdfBuffer = await chromiumPdfGenerator.generateFromHTML(html, {
      format: pdfOptions.format || "A4",
      landscape: pdfOptions.landscape !== false,
      margin: {
        top: pdfOptions.marginTop || "5mm",
        right: pdfOptions.marginRight || "5mm",
        bottom: pdfOptions.marginBottom || "5mm",
        left: pdfOptions.marginLeft || "5mm",
      },
    });

    console.log("✅ PDF generated successfully with Chromium fallback");
    return pdfBuffer;
  }

  // ==========================================================================
  // BATCHED PDF  (payslips — large employee sets)
  //
  // Strategy:
  //   1. Compile the Handlebars template ONCE (was re-compiled per batch)
  //   2. Render all batches to HTML strings in memory (CPU only, fast)
  //   3. Pass all HTML strings to chromiumPdfGenerator.generateManyFromHTML
  //      which launches ONE browser and renders through a tab pool
  //   4. Merge PDFs incrementally as each batch finishes (streaming)
  //      so we never hold the full 40k pages in RAM at once
  //
  // For jsreport mode the original serial approach is kept because jsreport
  // manages its own process pool differently.
  // ==========================================================================

  async generateBatchedPDF(
    templatePath,
    allData,
    batchSize,
    pdfOptions,
    extraTemplateData = {},
  ) {
    console.log(
      `📦 Starting batched PDF: ${allData.length} employees, batch ${batchSize}, pool ${require("../../lib/chromiumPdfGenerator").constructor.name || "ChromiumPDFGenerator"}`,
    );

    // ── Split data into batches ───────────────────────────────────────────────
    const batches = [];
    for (let i = 0; i < allData.length; i += batchSize) {
      batches.push(allData.slice(i, i + batchSize));
    }
    console.log(`📦 ${batches.length} batches created`);

    // ── JSReport path (unchanged, serial) ────────────────────────────────────
    if (this.jsreportReady) {
      return this._generateBatchedPDFJSReport(
        templatePath,
        batches,
        pdfOptions,
        extraTemplateData,
      );
    }

    // ── Chromium path (optimised) ─────────────────────────────────────────────
    console.log("🔄 Using optimised Chromium batched path");

    if (!fs.existsSync(templatePath)) {
      throw new Error(`PDF template file not found: ${templatePath}`);
    }

    // Step 1: compile template once
    const templateContent = fs.readFileSync(templatePath, "utf8");
    const compiledTemplate = Handlebars.compile(templateContent);

    // Step 2: render all HTML strings (pure JS, no browser needed)
    console.log("📝 Pre-rendering HTML for all batches...");
    const htmlPages = batches.map((batch, i) => {
      const templateData = { ...extraTemplateData, employees: batch };
      return compiledTemplate(templateData);
    });
    console.log(`✅ All ${htmlPages.length} HTML pages rendered`);

    // Step 3 + 4: generate PDFs through tab pool, merge incrementally
    // pdf-merger-js supports add(Buffer) so we can merge as each batch arrives
    const PDFMerger = require("pdf-merger-js").default;
    const merger = new PDFMerger();
    let completed = 0;

    const chromiumOptions = {
      format: pdfOptions.format || "A5",
      landscape: pdfOptions.landscape !== false ? pdfOptions.landscape : false,
      margin: {
        top: "5mm",
        right: "5mm",
        bottom: "5mm",
        left: "5mm",
      },
      timeout: pdfOptions.timeout || 600000,
    };

    await chromiumPdfGenerator.generateManyFromHTML(
      htmlPages,
      chromiumOptions,
      async (buffer, index) => {
        // Called as each batch finishes — merge immediately to avoid
        // accumulating all buffers in RAM
        await merger.add(buffer);
        completed++;
        console.log(`📄 Merged batch ${completed}/${batches.length}`);
      },
    );

    console.log("📄 Finalising merged PDF...");
    const mergedPdf = await merger.saveAsBuffer();
    console.log(
      `✅ Final PDF: ${(mergedPdf.length / 1024 / 1024).toFixed(1)}MB`,
    );
    return mergedPdf;
  }

  // ==========================================================================
  // JSReport batched path (serial, unchanged behaviour)
  // ==========================================================================

  async _generateBatchedPDFJSReport(
    templatePath,
    batches,
    pdfOptions,
    extraTemplateData,
  ) {
    const templateContent = fs.readFileSync(templatePath, "utf8");
    const pdfBuffers = [];

    for (let i = 0; i < batches.length; i++) {
      console.log(`🔄 JSReport batch ${i + 1}/${batches.length}`);
      const templateData = { ...extraTemplateData, employees: batches[i] };

      try {
        const result = await jsreport.render({
          template: {
            content: templateContent,
            engine: "handlebars",
            recipe: "chrome-pdf",
            chrome: {
              format: pdfOptions.format || "A5",
              landscape:
                pdfOptions.landscape !== false ? pdfOptions.landscape : false,
              printBackground: true,
              timeout: pdfOptions.timeout || 120000,
              marginTop: "5mm",
              marginBottom: "5mm",
              marginLeft: "5mm",
              marginRight: "5mm",
            },
            helpers: pdfOptions.helpers || this._getCommonHelpers(),
          },
          data: templateData,
          options: pdfOptions.options || {},
        });
        pdfBuffers.push(result.content);
        console.log(`✅ JSReport batch ${i + 1}/${batches.length} complete`);
      } catch (err) {
        console.error(
          `⚠️  JSReport batch ${i + 1} failed, switching to Chromium:`,
          err.message,
        );
        this.jsreportReady = false;
        // Re-run remaining batches through Chromium by recursing
        // (rare edge case — jsreport crashed mid-run)
        const remaining = batches.slice(i).flatMap((b) => b);
        const fallback = await this.generateBatchedPDF(
          templatePath,
          remaining,
          batches[0].length,
          pdfOptions,
          extraTemplateData,
        );
        pdfBuffers.push(fallback);
        break;
      }
    }

    console.log("📄 Merging JSReport PDFs...");
    return this.mergePDFs(pdfBuffers);
  }

  // ==========================================================================
  // MERGE MULTIPLE PDF BUFFERS  (kept for external callers)
  // ==========================================================================

  async mergePDFs(pdfBuffers) {
    const PDFMerger = require("pdf-merger-js").default;
    const merger = new PDFMerger();
    for (const buffer of pdfBuffers) await merger.add(buffer);
    return merger.saveAsBuffer();
  }
}

module.exports = BaseReportController;