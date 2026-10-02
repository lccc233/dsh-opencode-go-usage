# dsh-opencode-go-usage

OpenCode Go plan quota monitor for **DeepSeek Harness (DSH)** — a Web GUI plugin that puts three
threshold-coloured rings right beside the composer's context meter, and expands them into a
progress-bar panel on hover.

```
… [◔ 45%]  [◕ ◕ ◑]
   context   5h-rolling / weekly / monthly
   meter      OpenCode Go quota (this plugin)
```

| Compact (always visible) | Detail (hover / focus / click) |
| --- | --- |
| Three 14px rings, **no text**, one per quota window, each filled and coloured by its own used percentage. | One 6px progress bar per window with its own description: remaining percentage, reset countdown, sample age and a manual refresh. |

- **No model-facing surface**: the plugin registers no tool, no system-prompt section and no session
  event, so it adds **zero prompt tokens** and does not invalidate the KV cache.
- **The API key never reaches the browser**: the host half resolves it through `ctx.credentials`,
  calls the upstream endpoint itself, and exposes only the quota numbers on a loopback route.

Data comes from the official quota endpoint
`GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`, which answers:

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 3,  "resetsAt": "2026-10-02T16:18:57.800Z" },
    "weekly":  { "status": "ok", "percent": 1,  "resetsAt": "2026-10-05T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 59, "resetsAt": "2026-10-11T12:22:02.000Z" } } }
```

`percent` is **used** percentage; remaining is `100 − percent`.

---

## Requirements

- DSH **0.2.0-rc.2** (the release this plugin was developed and verified against) with the
  Web GUI profile (`@deepseek-ai/dsh-web-app`) and the `conversation.composer.dock` slot, which ships in
  `@deepseek-ai/dsh-client-ui-conversation`.
- An **OpenCode Go** subscription and its API key, stored where DSH can resolve it — by default under
  the credential reference `OPENCODE_GO_API_KEY` (the same reference the `llm-pi-ai` provider uses).
  Configure it in **Settings → Models**, or put it in `~/.dsh/.credentials.yaml`, or export it as an
  environment variable of the same name.
- Windows, macOS or Linux. Node 22+ for the development checks.

In the compact form each ring is 14px with a 2px stroke and the colour thresholds are
`<60%` green, `≥60%` amber, `≥85%` red; no data shows grey rings, and an upstream failure shows all
three red. The rings carry no visible text: the information is exposed through each ring's `title`
(for example `5h rolling · 3% used (97 left · resets in 3h25m)`), the row's `aria-label`, and the
detail panel.

---

## Deployment

Everything below assumes the DSH home is `~/.dsh` (`%USERPROFILE%\.dsh` on Windows). A DSH profile
lives in `~/.dsh/profiles/<name>/`; the **desktop** profile is the one the Electron application owns,
and it is the profile used in the examples.

Installing this plugin is always the same three ingredients:

1. **the package must be resolvable from the profile** — `~/.dsh/profiles/<name>/node_modules/dsh-opencode-go-usage`
   must exist (a junction/symlink to a checkout, or a real copy);
2. **the profile manifest should record it** — a `dependencies` entry in
   `~/.dsh/profiles/<name>/package.json`;
3. **the Loader needs a row** — an `insert` entry in `~/.dsh/profiles/<name>/cordis.patch.yml`.

Then **restart DSH**. Config hot-reload only covers rows that are already loaded; a brand-new package
enters the Loader graph at boot.

### Route A — clone into the plugin directory (recommended)

```sh
# 1. get the code where the profile can resolve it
git clone https://github.com/<you>/dsh-opencode-go-usage.git ~/.dsh/plugins/dsh-opencode-go-usage

# 2. link it into the profile (Windows: create a junction; POSIX: symlink)
#    Windows (PowerShell, cmd):
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-opencode-go-usage" "%USERPROFILE%\.dsh\plugins\dsh-opencode-go-usage"
#    POSIX:
ln -s ~/.dsh/plugins/dsh-opencode-go-usage ~/.dsh/profiles/desktop/node_modules/dsh-opencode-go-usage
```

Record the dependency in `~/.dsh/profiles/desktop/package.json` (the path is relative to the profile
directory, so `../../plugins/...` is `~/.dsh/plugins/...`):

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-opencode-go-usage": "file:../../plugins/dsh-opencode-go-usage"
  }
}
```

Add the Loader row to `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: opencode-go-usage
      name: "dsh-opencode-go-usage"
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
        endpoint: https://opencode.ai/zen/go/v1/usage
        refreshMs: 60000
        timeoutMs: 10000
        route: /opencode-go-usage/snapshot
```

> **Write these two files as UTF-8 *without* a BOM.** Windows PowerShell's
> `Set-Content -Encoding UTF8` prepends `EF BB BF`, and DSH parses `package.json` with `JSON.parse` —
> the application then refuses to start with `` Unexpected token '', "{
>   "name"... is not valid JSON ``. Use an editor that writes BOM-free UTF-8, or:
> `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.

### Route B — the profile's own plugin manager

Deployments that ship `@deepseek-ai/dsh-plugin-manager` (and a `dsh` CLI) can install it like any
other plugin:

```sh
dsh plugin --profile <name> add dsh-opencode-go-usage
```

That performs the same three ingredients (pnpm install into the profile, bundle/dependency record,
patch row).

Two caveats:

- the **desktop** profile cannot be managed this way — `dsh plugin --profile desktop` is rejected by
  design, because the Electron application owns that profile. Use Route A there.
- the plugin must be a **bundle** for the install to be recorded as one. This repository therefore
  also ships `cordis.patch.yml` and declares `dsh.bundle.patch` in `package.json`, so selecting it as
  a bundle inserts the same row.

### Route C — install as a profile bundle

If you prefer the bundle list instead of a hand-written row, add the package to the profile's bundle
list (`package.json` → `dsh.profile.bundles`). DSH then applies this repository's own
`cordis.patch.yml` as one patch layer, inserting the row for you:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-opencode-go-usage"] } }
}
```

Both routes insert the same `id: opencode-go-usage`, so a profile-layer row simply overrides the
bundle-layer row's config.

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Credential reference resolved per refresh through `ctx.credentials`; falls back to an environment variable of the same name. |
| `apiKey` | — | Literal key (discouraged: it puts a secret in the patch file). |
| `endpoint` | `https://opencode.ai/zen/go/v1/usage` | Quota endpoint. |
| `refreshMs` | `60000` | Cache lifetime; the browser polls on the same cycle. |
| `timeoutMs` | `10000` | Per-request upstream timeout. |
| `route` | `/opencode-go-usage/snapshot` | Web-server path serving the snapshot. |

### Verify

```sh
curl http://127.0.0.1:<port>/opencode-go-usage/snapshot/probe
# {"plugin":"dsh-opencode-go-usage","version":"0.1.0","route":"/opencode-go-usage/snapshot",
#  "apiKeyEnv":"OPENCODE_GO_API_KEY","endpoint":"https://opencode.ai/zen/go/v1/usage",
#  "refreshMs":60000,"sample":"2026-10-02T16:50:47.860Z","lastError":null}

curl http://127.0.0.1:<port>/opencode-go-usage/snapshot
# {"ok":true,"fetchedAt":"…","windows":{"rolling":{"percent":3,…},"weekly":{…},"monthly":{…}},
#  "stale":false,"error":null}
```

`404` on the probe means the host half is not loaded (bad path, missing row, or an import failure).
The port is printed at startup as part of the `dsh web:` URL. Then open the GUI: the rings appear in
the composer dock, to the right of the context meter.

### Uninstall / rollback

1. remove the `insert` block from `~/.dsh/profiles/<name>/cordis.patch.yml`;
2. remove the dependency (and, if used, the `dsh.profile.bundles` entry) from the profile's `package.json`;
3. delete the junction `~/.dsh/profiles/<name>/node_modules/dsh-opencode-go-usage`
   (on Windows use `cmd /c rmdir "<path>"`, **not** `Remove-Item -Recurse`, which can follow the link
   and delete the target's contents);
4. optionally delete `~/.dsh/plugins/dsh-opencode-go-usage`;
5. restart DSH.

Deleting the checkout while the row stays in place does **not** break DSH: the entry fails to import,
the host logs a warning (`1 entry did not activate` / `failed to import`) and the GUI runs normally —
you simply lose the rings. The same holds for the reverse: a rescuable state is never a crash.

---

## Diagnostics and troubleshooting

### Failure codes on the snapshot route

| Code | Meaning |
| --- | --- |
| `unconfigured` | No credential under `apiKeyEnv`, and no environment variable of that name. |
| `unauthorized` | The endpoint rejected the key (HTTP 401/403). |
| `timeout` | The upstream request exceeded `timeoutMs`. |
| `connect` | `opencode.ai` unreachable. |
| `http` | Any other non-2xx answer. |
| `parse` | The body was not JSON, or carried no `usage` object. |
| `no-data` | The body carried no quota window. |

The browser localizes these codes; the panel shows the previous sample and a
"refresh failed, showing the last sample" note instead of going blank.

### Symptom → cause → fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| DSH refuses to start: `Unexpected token '', … is not valid JSON`, dialog "The application could not start" | The profile `package.json` was written **with a UTF-8 BOM** (typically by `Set-Content -Encoding UTF8`) | Rewrite it BOM-free (see the warning in Route A) |
| DSH crashes with `web boot: 1 entry did not activate` and the renderer console says `duplicate factory registration for "…"` | The client bundle registered under an `id` that is **not** the package name, so the shell thought the row was missing and fetched the bundle a second time | Make `window.__ModuleLoader__.load({ id })` exactly equal `package.json`'s `name` (all first-party bundles do; `node tools/check-client.mjs .` asserts it) |
| The row seems to be ignored; the plugin never loads; no error beyond a Loader warning | A **bare** `- id: <new-id>` patch entry only overrides rows that already exist in the composed tree; a new mount point must be an `insert` list | Use the `insert` form shown in Route A |
| Probe returns 404, but the row is present | The package is not resolvable from the profile directory (`node_modules` link missing/dangling), or the checkout was deleted | Re-create the link, confirm `node -e "require.resolve('dsh-opencode-go-usage')"` from the profile anchor, restart |
| Rings are missing but the app is fine, no probe route | Same as above, or the row was removed by DSH's crash recovery ("Disable third-party plugins, back up profile patch, and restart", which rewrites `cordis.patch.yml` and leaves `cordis.patch.yml.bak-<timestamp>`) | Re-add the `insert` block from the backup or from Route A, restart |
| Rings show but stay grey | No sample yet, or the endpoint answered without a window | Check the probe's `lastError`, then the failure codes above |

---

## Security

- The snapshot route is served by DSH's own loopback web server (`host: 127.0.0.1`) and carries the
  **percentages and reset times only — never the API key**.
- The route has no additional authentication of its own: any local process that can reach the GUI
  port can read the quota numbers. They are not secrets; if that still bothers you, set `route` to a
  path only you know, or restrict the deployment as a whole.
- The API key is resolved per refresh through `ctx.credentials`, which means rotating the key takes
  effect on the next refresh with no restart.

## Limitations

- **Always visible**: the rings do not depend on the active session model; they appear whenever the
  host has data. (The slot receives the session's `provider`, so gating on `opencode-go` is a
  one-line change if you prefer it.)
- **One account per profile**; multi-account dashboards are out of scope.
- **Poll latency**: 60 seconds by default; the panel's `↻` refreshes immediately, and polling is
  skipped while the tab is hidden.
- **Fixed vocabulary**: window names, thresholds and ordering assume the OpenCode Go plan.
- Verified against DSH `0.2.0-rc.2`; the client-module contract it relies on (`dsh.client`,
  `conversation.composer.dock`, the `dsh-client-ui-primitives` style vocabulary) may change between
  DSH releases.

---

## Development

The plugin is plain ESM on the host side and a lazy-CommonJS browser bundle — **there is no build
step**; `lib/index.js` and `lib/client.js` are shipped as-is.

```sh
node tools/check-client.mjs .   # browser half: registration id, externals, rings, panel
node tools/check-host.mjs .     # host half: credential resolution, caching, error codes
```

Contracts the checks enforce, all of which have caused real crashes when violated:

- the bundle's registration `id` **must equal** the package `name` (a mismatch makes the shell
  re-fetch the bundle and the duplicate registration fails the whole web boot);
- every `require()` in the browser bundle must be part of the platform baseline (`react`,
  `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`) or listed in `dsh.client.external`;
- `apply()` on the client must not throw: a client entry that fails to activate takes the web boot
  down, so the registration is wrapped and logged instead;
- the host half declares `inject: ['webServer']`, otherwise it activates before the web server exists
  and its routes are silently dropped.

## License

MIT — see [LICENSE](LICENSE).
