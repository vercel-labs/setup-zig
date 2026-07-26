# Setup Zig

Installs an exact Zig release and adds it to `PATH`. The default version is
Zig 0.16.0.

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: vercel-labs/setup-zig@v1
    with:
      version: 0.16.0
  - run: zig build
```

The action supports Linux, macOS, and Windows runners on architectures for
which Zig publishes a binary archive. Downloads are selected from Zig's
community mirrors and verified using Zig's minisign public key, including the
signed archive filename. The SHA-256 checksum from Zig's official download
index is checked as an additional integrity measure.

The action has no package dependencies.

### Outputs

| Output | Description |
| --- | --- |
| `version` | The installed Zig version |
| `zig-path` | The absolute path to the Zig executable |
| `cache-hit` | Whether Zig was already present in the runner tool cache |

### Proxy runners

The action honors the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
environment variables. On a runner whose bundled Node 24 predates dynamic proxy
support, set `NODE_USE_ENV_PROXY: "1"` on the action step or update the runner:

```yaml
- uses: vercel-labs/setup-zig@v1
  env:
    HTTPS_PROXY: http://proxy.example.com:8080
    NO_PROXY: localhost,127.0.0.1
    NODE_USE_ENV_PROXY: "1"
```

## Development

Run the dependency-free test suite with:

```sh
node --test main.test.mjs
```
