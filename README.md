# prox

prox is a personal fork of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
and its [management panel](https://github.com/router-for-me/Cli-Proxy-API-Management-Center).
It adds shared quota polling and history, quota forecasts, prioritised routing bursts,
persistent usage summaries, and a redesigned management interface.

## Layout

- `proxy/`: the Go proxy server, with its full original Git history.
- `panel/`: the Vite/React management panel, with its full original Git history.

## Build

The proxy requires **Go 1.26.10**, as pinned by `proxy/go.mod`.
The panel requires **Bun** (`panel/package.json` pins Bun 1.3.14).

Build the proxy from the repository root:

```sh
cd proxy && go build -o cli-proxy-api ./cmd/server
```

Build the panel from the repository root:

```sh
cd panel && bun install && bun run build
```

The panel produces a single self-contained `panel/dist/index.html`, served by the
proxy as `management.html`.

## Credits and license

prox builds on the work of the upstream CLIProxyAPI and management-panel contributors:

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)

Both upstream projects are MIT-licensed. Their original license text and copyright
notices remain intact in [proxy/LICENSE](proxy/LICENSE) and
[panel/LICENSE](panel/LICENSE).
