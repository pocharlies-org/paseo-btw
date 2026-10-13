# paseo-btw

Paseo plugin: `/btw`, a side question answered from the context of the session with no tools, streaming into its own panel.

Install on the x86: `scripts/deploy.sh` from a clone of trunk — it stages the plugin under `~/.local/share/paseo-btw/paseo-plugin/<version>-<sha>` with a `current` link and registers it with `paseo plugin install|reload`.

Develop: `npm install && npm test && npm run typecheck`. The three runtimes (client/server/shared) are checked by `test/boundaries.test.ts`; the plugin logs nothing and leaks nothing (`test/plugin.test.ts`).

See `OVERVIEW.md` for what it does and `CONTRACTS.yaml` for what it promises.
