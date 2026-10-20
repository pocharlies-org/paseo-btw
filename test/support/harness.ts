import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../../index.server.ts";

const made: string[] = [];

/** A temporary PASEO_HOME (0700) with no config.json: the plugin is pointed at it. */
export function paseoHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-plugin-"));
  chmodSync(dir, 0o700);
  process.env.PASEO_HOME = dir;
  made.push(dir);
  return dir;
}

export function removeDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * The plugin loaded into a stand-in for the daemon: it hands out ONLY what the plugin is meant to use, so any other registration
 * (settings, providers, hooks) throws. `rpc` does what the host does around a handler: it parses the input with the contract, calls the
 * handler, and parses its output with the contract.
 */
export function install() {
  const handlers = new Map<string, { contract: any; handler: (input: unknown, context: unknown) => unknown }>();
  const allowed = {
    handle: (contract: any, handler: (input: unknown, context: unknown) => unknown) => void handlers.set(contract.name, { contract, handler }),
  };
  const ctx = new Proxy(allowed, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => {
        throw new Error(`the plugin registered something it must not: ${String(key)}`);
      };
    },
  }) as unknown as PluginServerContext;
  const cleanup = contribute(ctx);
  const rpc = async (name: string, input: unknown, context: unknown = { paseo: {} }) => {
    const found = handlers.get(name);
    if (!found) throw new Error(`no such RPC: ${name}`);
    return found.contract.output.parse(await found.handler(found.contract.input.parse(input), context));
  };
  return { handlers, rpc, cleanup };
}

// Until a test points the plugin somewhere else it looks at an empty throwaway directory, never at the real Paseo config of the host.
paseoHome();
