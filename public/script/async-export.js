// ============================================================================
// public/script/async-export.js
//
// Load this before any other script that calls fetch().
//
// Adds `X-Async-Export: 1` to same-origin fetches. When the server answers an
// export with `202` + `X-Export-Job`, this polls /async-jobs/:id and resolves
// the ORIGINAL fetch() promise with the finished file's Response, so callers
// that do `response.ok` / `response.blob()` / `response.json()` work unchanged.
// ============================================================================
(function () {
  if (window.__asyncExportInstalled) return;
  window.__asyncExportInstalled = true;

  var nativeFetch = window.fetch.bind(window);
  var POLL_MS = 2000;
  var MAX_WAIT_MS = 35 * 60 * 1000; // a little over the server's job ceiling

  function isSameOrigin(input) {
    try {
      var url = new URL(String(input), window.location.href);
      return url.origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function errorResponse(status, text) {
    return new Response(JSON.stringify({ error: text }), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {}
  }

  var CHUNK_BYTES = 4 * 1024 * 1024;

  // One byte range, retried on network errors
  async function getChunk(url, headers, start, end) {
    var lastError = null;
    for (var attempt = 1; attempt <= 4; attempt++) {
      try {
        var h = Object.assign({}, headers, {
          Range: "bytes=" + start + "-" + end,
        });
        var r = await nativeFetch(url, { headers: h, cache: "no-store" });
        // 404 / 409 / 5xx JSON from the job endpoint → hand back as-is
        if (r.status !== 206 && r.status !== 200) return { response: r };
        var buf = await r.arrayBuffer();
        return { response: r, buf: buf };
      } catch (e) {
        lastError = e;
        console.warn(
          "[async-export] chunk " + start + "-" + end + " attempt " + attempt + " failed:",
          e && e.message ? e.message : e,
        );
        await sleep(1000 * attempt);
      }
    }
    throw lastError || new Error("download failed");
  }

  // Pull the finished file in byte ranges and rebuild the original Response
  // (status, Content-Type, Content-Disposition) in memory, so the caller's
  // response.ok / .blob() / .json() behave exactly as with a direct download.
  async function downloadResult(resultUrl, headers, jobId, sourceUrl) {
    try {
      var first = await getChunk(resultUrl, headers, 0, CHUNK_BYTES - 1);
      if (!first.buf) return first.response;

      var r = first.response;
      var total =
        parseInt(r.headers.get("X-Export-Size") || "0", 10) || first.buf.byteLength;
      var status = parseInt(r.headers.get("X-Export-Status") || "200", 10) || 200;
      var type = r.headers.get("X-Export-Content-Type") || "application/octet-stream";
      var disposition = r.headers.get("X-Export-Content-Disposition");

      var parts = [first.buf];
      var received = first.buf.byteLength;

      while (received < total) {
        var next = await getChunk(
          resultUrl,
          headers,
          received,
          Math.min(received + CHUNK_BYTES, total) - 1,
        );
        if (!next.buf) return next.response;
        if (next.buf.byteLength === 0) throw new Error("server sent an empty chunk");
        parts.push(next.buf);
        received += next.buf.byteLength;
        emit("async-export:download", {
          jobId: jobId,
          url: sourceUrl,
          received: received,
          total: total,
        });
      }

      if (received !== total) {
        throw new Error("incomplete download (" + received + " of " + total + " bytes)");
      }

      var outHeaders = new Headers({
        "Content-Type": type,
        "Content-Length": String(total),
      });
      if (disposition) outHeaders.set("Content-Disposition", disposition);

      return new Response(new Blob(parts, { type: type }), {
        status: status,
        headers: outHeaders,
      });
    } catch (e) {
      return errorResponse(
        502,
        "The report was generated but could not be downloaded" +
          (e && e.message ? " (" + e.message + ")" : "") +
          ". Please try again.",
      );
    }
  }

  async function waitForJob(jobId, authHeader, sourceUrl) {
    var headers = {};
    if (authHeader) headers.Authorization = authHeader;

    var statusUrl = "/async-jobs/" + encodeURIComponent(jobId);
    var started = Date.now();
    var networkFailures = 0;

    emit("async-export:pending", { jobId: jobId, url: sourceUrl });

    while (Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);

      var status;
      try {
        var r = await nativeFetch(statusUrl, {
          headers: headers,
          cache: "no-store",
        });
        if (r.status === 404) {
          emit("async-export:failed", { jobId: jobId, url: sourceUrl });
          return errorResponse(
            410,
            "The report expired before it could be downloaded. Please generate it again.",
          );
        }
        status = await r.json();
        networkFailures = 0;
      } catch (e) {
        // Short network blip (Wi-Fi, tunnel reconnect) — keep waiting
        if (++networkFailures > 30) {
          return errorResponse(503, "Lost connection while waiting for the report.");
        }
        continue;
      }

      emit("async-export:progress", {
        jobId: jobId,
        url: sourceUrl,
        status: status.status,
        queuePosition: status.queuePosition,
        elapsedMs: status.elapsedMs,
      });

      if (status.status === "done") {
        var result = await downloadResult(statusUrl + "/result", headers, jobId, sourceUrl);
        emit("async-export:done", { jobId: jobId, url: sourceUrl });
        return result;
      }

      if (status.status === "failed") {
        emit("async-export:failed", { jobId: jobId, url: sourceUrl });
        return errorResponse(502, status.error || "Report generation failed.");
      }
    }

    emit("async-export:failed", { jobId: jobId, url: sourceUrl });
    return errorResponse(
      504,
      "The report is taking too long. Try a smaller range or try again later.",
    );
  }

  window.fetch = async function (input, init) {
    // Request objects and cross-origin calls pass straight through
    if (typeof Request !== "undefined" && input instanceof Request) {
      return nativeFetch(input, init);
    }
    if (!isSameOrigin(input)) return nativeFetch(input, init);

    var opts = Object.assign({}, init || {});
    var headers = new Headers(opts.headers || {});
    headers.set("X-Async-Export", "1");
    opts.headers = headers;

    var response = await nativeFetch(input, opts);

    var jobId =
      response.status === 202 ? response.headers.get("X-Export-Job") : null;
    if (!jobId) return response;

    return waitForJob(jobId, headers.get("Authorization"), String(input));
  };
})();
