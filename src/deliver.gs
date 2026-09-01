/**
 * POSTs the payload as JSON, retrying transient failures.
 *
 * `deps` exists for testing: it injects the transport and the sleep so every
 * retry branch can be driven without a network. Production callers omit it.
 *
 * 5xx and thrown errors retry with exponential backoff. 4xx does not — a
 * payload the endpoint rejects will be rejected again, and the daily
 * UrlFetch quota is finite.
 */
function deliverPayload(payload, url, deps) {
  deps = deps || {};
  var fetchJson = deps.fetchJson || postJson;
  var sleep = deps.sleep || function (ms) { Utilities.sleep(ms); };
  var maxAttempts = deps.maxAttempts || 3;

  var lastStatus = null;
  var lastError = null;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var status = fetchJson(url, payload);
      if (status >= 200 && status < 300) {
        return { ok: true, attempts: attempt, status: status };
      }
      if (status >= 400 && status < 500) {
        return { ok: false, attempts: attempt, status: status, permanent: true };
      }
      lastStatus = status;
    } catch (err) {
      lastError = String(err);
    }

    if (attempt < maxAttempts) {
      sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    status: lastStatus,
    error: lastError,
    permanent: false
  };
}

/**
 * The real transport. `muteHttpExceptions` keeps a non-2xx response as a
 * status code rather than a thrown exception, so deliverPayload can decide
 * whether it is worth retrying.
 */
function postJson(url, payload) {
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return response.getResponseCode();
}
