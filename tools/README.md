# tools/

Local verification harnesses. They were written against DSH `0.2.0-rc.2` on Windows, and they are
**not required to run the plugin** — they exist so a change can be checked before restarting DSH.

## Contract checks (portable, Node only)

```sh
node tools/check-client.mjs <plugin-dir>   # defaults to ./dsh-opencode-go-usage
node tools/check-host.mjs   <plugin-dir>
```

`check-client.mjs` materializes the browser bundle with a minimal React stand-in and asserts the
contracts the DSH shell depends on: the registration `id` equals the package name, the bundle
registers exactly once, every `require()` is baseline or declared, the compact form is three
threshold rings carrying no text, the hover panel renders one bar + description per window (both
locales), and a throwing slot registry is contained instead of failing the boot.

`check-host.mjs` evaluates the host half against a stub context: credential resolution from
`ctx.credentials`, the cached snapshot, the `unconfigured` path, and an `unauthorized` upstream answer.
It reads the real `~/.dsh/.credentials.yaml` for the live-check part, so run it on a machine that has
an OpenCode Go key configured if you want that path exercised.

## Acceptance run (Windows)

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/accept-opencode-usage.ps1 `
  -PluginDir "$env:USERPROFILE\.dsh\plugins\dsh-opencode-go-usage"
```

It creates a throwaway DSH home **inside the current directory** (your real profile is never booted or
modified), copies your real desktop profile patch into it, starts a host on port 19410, and asserts:
the contract checks pass, the patch mounts the row through an `insert` list, the snapshot route
returns live data, and the client bundle is in the browser boot graph. Add `-Deep` to also download
the batch script the browser loads and confirm this plugin's factory is inside it.

Defaults assume the Windows desktop install; override `$desktopPatch`, `$credentials`, `$exe` and
`$cli` at the top of the file for another layout.

## Independence check (Windows)

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/check-desktop-independence.ps1
```

Copies the real desktop profile into a throwaway home, **renames the workspace copy of the plugin
away**, boots, and asserts the rings still come up — i.e. that the deployed copy is self-sufficient.
It restores the renamed directory in a `finally` block. Note that DSH refuses `--profile desktop`
from the CLI, so the script boots the copied profile under a different name.

## Note on this environment

`git` on this machine needs the OpenSSL TLS backend (`git config http.sslBackend openssl`); the
schannel backend fails with `SEC_E_NO_CREDENTIALS` in the sandbox.
