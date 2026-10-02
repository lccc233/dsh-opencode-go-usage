// Unit-check the host half's pure helpers by evaluating the module source.
// Argv[2] optionally names the plugin directory, so a relocated install (for
// example ~/.dsh/plugins/...) is verified the same way.
import fs from 'node:fs';
import path from 'node:path';

const pluginDir = process.argv[2] ?? 'dsh-opencode-go-usage';
const source = fs.readFileSync(path.join(pluginDir, 'lib/index.js'), 'utf8');
const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const module = await import(url);
console.log('exports', Object.keys(module));

const key = fs.readFileSync('C:/Users/Administrator/.dsh/.credentials.yaml', 'utf8').match(/OPENCODE_GO_API_KEY:\s*(\S+?)[,\s}]/)[1];
process.env.OPENCODE_GO_API_KEY = key;

// A stub context: what the host half reads from its service container.
const registered = [];
const ctx = {
  get(name) {
    if (name === 'credentials') {
      return {
        async resolve(ref) {
          return process.env[ref] === undefined ? undefined : { value: process.env[ref], source: 'environment' };
        },
      };
    }
    if (name === 'webServer') {
      return {
        register(route) {
          registered.push(route);
          return () => {
            registered.pop();
          };
        },
      };
    }
    return undefined;
  },
  effect(fn) {
    fn();
  },
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
};

module.apply(ctx, { apiKeyEnv: 'OPENCODE_GO_API_KEY', refreshMs: 50, timeoutMs: 10_000 });
console.log('registered routes', registered.map((r) => `${r.kind}:${r.path}`));

// Drive the route handler with fake req/res objects.
const call = () =>
  new Promise((resolve) => {
    const chunks = [];
    const response = {
      status: null,
      headers: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        if (body !== undefined) chunks.push(body);
        resolve({ status: this.status, headers: this.headers, body: chunks.join('') });
      },
    };
    void registered[0].handler({ method: 'GET', url: '/opencode-go-usage/snapshot' }, response);
  });

const first = await call();
console.log('first call status', first.status, 'content-type', first.headers['content-type']);
console.log('first body', first.body);
const second = await call();
console.log('second body (cached)', second.body);

const parsed = JSON.parse(first.body);
if (!parsed.ok) throw new Error('expected a successful snapshot');
for (const name of ['rolling', 'weekly', 'monthly']) {
  const window = parsed.windows[name];
  if (window === undefined || typeof window.percent !== 'number') throw new Error(`window ${name} missing a percent`);
}
console.log('windows ok:', JSON.stringify(parsed.windows));

// Unconfigured-credential path: no env, no credential.
delete process.env.OPENCODE_GO_API_KEY;
const registered2 = [];
const emptyCtx = {
  ...ctx,
  get(name) {
    if (name === 'credentials') return { async resolve() { return undefined; } };
    if (name === 'webServer') return { register(route) { registered2.push(route); return () => {}; } };
    return undefined;
  },
};
module.apply(emptyCtx, { apiKeyEnv: 'OPENCODE_GO_API_KEY' });
const unconfigured = await new Promise((resolve) => {
  void registered2[0].handler(
    { method: 'GET' },
    {
      writeHead() {},
      end(body) {
        resolve(JSON.parse(body));
      },
    },
  );
});
console.log('unconfigured payload', JSON.stringify(unconfigured));
if (unconfigured.ok !== false || unconfigured.error.code !== 'unconfigured') throw new Error('expected the unconfigured code');

// Upstream failure with a bad key must report `unauthorized`. The value is
// deliberately not key-shaped, so no scan mistakes this file for a leak.
process.env.OPENCODE_GO_API_KEY = 'invalid-key-for-testing';
const registered3 = [];
const badCtx = {
  ...ctx,
  get(name) {
    if (name === 'credentials') return { async resolve() { return { value: process.env.OPENCODE_GO_API_KEY }; } };
    if (name === 'webServer') return { register(route) { registered3.push(route); return () => {}; } };
    return undefined;
  },
};
module.apply(badCtx, { apiKeyEnv: 'OPENCODE_GO_API_KEY' });
const rejected = await new Promise((resolve) => {
  void registered3[0].handler(
    { method: 'GET' },
    {
      writeHead() {},
      end(body) {
        resolve(JSON.parse(body));
      },
    },
  );
});
console.log('rejected payload', JSON.stringify(rejected));
if (rejected.ok !== false || rejected.error.code !== 'unauthorized') throw new Error('expected the unauthorized code');
console.log('ALL HOST CHECKS PASSED');
