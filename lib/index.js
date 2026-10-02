/**
 * OpenCode Go usage monitor — host half.
 *
 * Serves the OpenCode Go plan quota over a small JSON route on the web server
 * so the browser half can render it. The API key never leaves this process:
 * it is resolved per refresh through `ctx.credentials` (falling back to the
 * process environment), used as the upstream Bearer credential, and dropped.
 *
 * Upstream contract: `GET {endpoint}` with `Authorization: Bearer <key>`
 * answering `{ usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }`.
 */

/** Default credential reference holding the OpenCode Go API key. */
const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY';
/** Default quota endpoint (the official OpenCode Zen "Go" usage route). */
const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
/** Default cache lifetime in milliseconds: how long a sample is served before refetching. */
const DEFAULT_REFRESH_MS = 60_000;
/** Default per-request upstream timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Default web-server path the browser half reads the snapshot from. */
const DEFAULT_ROUTE = '/opencode-go-usage/snapshot';
/** Path suffix the host answers with build and wiring facts, for diagnostics. */
const PROBE_SUFFIX = '/probe';
/** Version marker, echoed by the probe route so a running host can be identified. */
const VERSION = '0.1.0';
/** Quota windows reported by the upstream endpoint, in display order. */
const WINDOWS = ['rolling', 'weekly', 'monthly'];

/**
 * Read a positive integer option, falling back to its default.
 * @param value - the configured value.
 * @param fallback - the default to use when the value is absent or unusable.
 * @returns the effective positive integer.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Read a non-empty string option, falling back to its default.
 * @param value - the configured value.
 * @param fallback - the default to use when the value is absent or empty.
 * @returns the effective non-empty string.
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Project one upstream quota window onto the wire shape the browser renders.
 * @param raw - the upstream window record, when present.
 * @returns the normalized window, or `null` when the upstream omitted it.
 */
function windowOf(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : null;
  const status = typeof raw.status === 'string' ? raw.status : 'unknown';
  const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt : null;
  if (percent === null && resetsAt === null) return null;
  return { status, percent, resetsAt };
}

/** One host-side quota monitor: cached sample, in-flight refresh, and HTTP route. */
class UsageMonitor {
  /** @param ctx - the plugin context providing `credentials` and `webServer`. */
  constructor(ctx) {
    this.ctx = ctx;
    this.sample = null;
    this.inflight = null;
    this.lastError = null;
  }

  /**
   * Resolve the API key for one refresh: credential reference first, process
   * environment second, so an ambient `OPENCODE_GO_API_KEY` also works.
   * @param config - the effective plugin configuration.
   * @returns the key, or `null` when no source holds one.
   */
  async resolveKey(config) {
    const literal = typeof config.apiKey === 'string' && config.apiKey.trim().length > 0 ? config.apiKey.trim() : null;
    if (literal !== null) return literal;
    const ref = text(config.apiKeyEnv, DEFAULT_API_KEY_ENV);
    const credentials = this.ctx.get('credentials');
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref);
        const value = hit !== null && typeof hit === 'object' ? hit.value : hit;
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      } catch (error) {
        this.ctx.logger?.warn?.(`opencode-go-usage: credential ${ref} lookup failed: ${String(error?.message ?? error)}`);
      }
    }
    const ambient = process.env[ref];
    return typeof ambient === 'string' && ambient.trim().length > 0 ? ambient.trim() : null;
  }

  /**
   * Query the upstream quota endpoint once.
   * @param config - the effective plugin configuration.
   * @returns the normalized snapshot payload.
   * @throws Error carrying a stable machine code when the refresh cannot complete.
   */
  async fetchSample(config) {
    const key = await this.resolveKey(config);
    if (key === null) throw coded('unconfigured', `no credential is configured under ${text(config.apiKeyEnv, DEFAULT_API_KEY_ENV)}`);
    const endpoint = text(config.endpoint, DEFAULT_ENDPOINT);
    const timeoutMs = positive(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) throw coded('timeout', `the quota request exceeded ${String(timeoutMs)}ms`);
      throw coded('connect', String(error?.message ?? error));
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) throw coded('unauthorized', `the endpoint rejected the API key (HTTP ${String(response.status)})`);
    if (!response.ok) throw coded('http', `the endpoint answered HTTP ${String(response.status)}`);
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw coded('parse', `the endpoint did not answer JSON: ${String(error?.message ?? error)}`);
    }
    return normalize(body);
  }

  /**
   * Answer the current snapshot, refreshing it when the cached sample is older
   * than the configured lifetime. Concurrent readers share one refresh.
   * @param config - the effective plugin configuration.
   * @returns the snapshot payload; a failed refresh keeps the previous sample.
   */
  async snapshot(config) {
    const refreshMs = positive(config.refreshMs, DEFAULT_REFRESH_MS);
    const age = this.sample === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(this.sample.fetchedAt);
    if (age < refreshMs) return this.payload();
    if (this.inflight === null) {
      this.inflight = this.fetchSample(config)
        .then((sample) => {
          this.sample = sample;
          this.lastError = null;
          return sample;
        })
        .catch((error) => {
          this.lastError = { code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
          this.ctx.logger?.warn?.(`opencode-go-usage: refresh failed [${this.lastError.code}] ${this.lastError.message}`);
          return null;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    await this.inflight;
    return this.payload();
  }

  /**
   * Project the cached sample plus its health onto the wire payload.
   * @returns the JSON body the route answers with.
   */
  payload() {
    if (this.sample === null) {
      return { ok: false, fetchedAt: null, windows: null, stale: false, error: this.lastError };
    }
    return {
      ok: true,
      fetchedAt: this.sample.fetchedAt,
      windows: this.sample.windows,
      stale: this.lastError !== null,
      error: this.lastError,
    };
  }
}

/**
 * Build an error carrying a stable machine code the browser localizes.
 * @param code - the machine code (`unconfigured`, `timeout`, `connect`, `unauthorized`, `http`, `parse`, `no-data`).
 * @param message - the diagnostic text, logged by the host and shown on hover.
 * @returns the tagged error.
 */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Normalize an upstream usage body onto the wire snapshot.
 * @param body - the decoded upstream JSON.
 * @returns the normalized sample.
 * @throws Error coded `parse` when no quota window is recognizable.
 */
function normalize(body) {
  const usage = body !== null && typeof body === 'object' && body.usage !== null && typeof body.usage === 'object' ? body.usage : null;
  if (usage === null) throw coded('parse', 'the endpoint answered without a usage object');
  const windows = {};
  for (const name of WINDOWS) {
    const window = windowOf(usage[name]);
    if (window !== null) windows[name] = window;
  }
  if (Object.keys(windows).length === 0) throw coded('no-data', 'the endpoint reported no quota window');
  return { fetchedAt: new Date().toISOString(), windows };
}

/**
 * Required host services. The web server must exist before this plugin
 * activates, so `ctx.get('webServer')` resolves on the first apply; a late
 * server keeps the fiber pending instead of silently dropping the route.
 */
const inject = ['webServer'];

/**
 * Mount the monitor: register the read-only snapshot route and keep one cache
 * for the whole host process.
 * @param ctx - the plugin context.
 * @param config - the effective plugin configuration.
 */
function apply(ctx, config) {
  const options = config ?? {};
  const route = text(options.route, DEFAULT_ROUTE);
  const monitor = new UsageMonitor(ctx);
  const server = ctx.get('webServer');
  if (server === undefined || typeof server.register !== 'function') {
    ctx.logger?.warn?.('opencode-go-usage: no web server is composed; the usage bar has no data source');
    return;
  }
  // An entry whose apply throws fails its boot, so a route conflict or an
  // unexpected server shape must cost the routes, never the application.
  try {
    const dispose = server.register({
      path: route,
      kind: 'exact',
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
          response.end(JSON.stringify({ ok: false, error: { code: 'method', message: 'only GET is served' } }));
          return;
        }
        const body = JSON.stringify(await monitor.snapshot(options));
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(body)),
        });
        response.end(request.method === 'HEAD' ? undefined : body);
      },
    });
    if (typeof dispose === 'function') ctx.effect(() => dispose, 'opencode-go-usage: snapshot route');
  } catch (error) {
    ctx.logger?.warn?.(`opencode-go-usage: could not register ${route}: ${String(error?.message ?? error)}`);
    return;
  }
  const probeDispose = server.register({
    path: `${route}${PROBE_SUFFIX}`,
    kind: 'exact',
    handler: (_request, response) => {
      const body = JSON.stringify({
        plugin: 'dsh-opencode-go-usage',
        version: VERSION,
        route,
        apiKeyEnv: text(options.apiKeyEnv, DEFAULT_API_KEY_ENV),
        endpoint: text(options.endpoint, DEFAULT_ENDPOINT),
        refreshMs: positive(options.refreshMs, DEFAULT_REFRESH_MS),
        sample: monitor.sample === null ? null : monitor.sample.fetchedAt,
        lastError: monitor.lastError,
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    },
  });
  if (typeof probeDispose === 'function') ctx.effect(() => probeDispose, 'opencode-go-usage: probe route');
  ctx.logger?.info?.(`opencode-go-usage: serving the OpenCode Go quota snapshot on ${route}`);
}

export { apply, inject };
