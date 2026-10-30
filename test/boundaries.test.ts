import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Static rules on the plugin's own sources: what Paseo's compiler enforces between the three runtimes (client, server, shared) and the
// security conditions that are about what the code imports or contains. They read the files; the behaviour is in plugin.test.ts.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function walk(dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const clientFiles = ["index.client.tsx", ...walk("client")];
const serverFiles = ["index.server.ts", ...walk("server")];
const sharedFiles = walk("shared");
const sources = [...clientFiles, ...serverFiles, ...sharedFiles];

// A bare `import "x"` only counts at the start of a line: `["import", id]` (the arguments of `paseo import`) is not one.
const IMPORT = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;
const importsOf = (path: string) => [...read(path).matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);

/** What a file of `group` may import: a relative path inside the folders listed, or one of the packages listed. Nothing else. */
function offences(files: string[], folders: string[], packages: string[]): string[] {
  return files.flatMap((file) =>
    importsOf(file).flatMap((spec) => {
      if (spec.startsWith(".")) {
        const target = relative(root, resolve(root, dirname(file), spec));
        return folders.some((folder) => target === folder || target.startsWith(`${folder}/`)) ? [] : [`${file} imports ${spec}`];
      }
      return packages.includes(spec) ? [] : [`${file} imports ${spec}`];
    }),
  );
}

describe("C2 and P3.5 · the runtimes do not reach into each other", () => {
  it("the client imports only from client/ and shared/, the SDK, React, TanStack Query and zod: never node:*, never server/", () => {
    const nodeInClient = clientFiles.concat(sharedFiles).flatMap((file) => importsOf(file).filter((spec) => spec.startsWith("node:") || builtinModules.includes(spec)).map((spec) => `${file} imports ${spec}`));
    assert.deepEqual(nodeInClient, []);
    assert.deepEqual(
      offences(clientFiles, ["client", "shared"], ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native", "react", "react-native", "@tanstack/react-query", "zod"]),
      [],
    );
  });

  it("shared/ imports only itself, the SDK root and zod", () => {
    assert.deepEqual(offences(sharedFiles, ["shared"], ["@getpaseo/plugin", "zod"]), []);
  });

  it("the server imports server/, shared/, the SDK's server entries, zod and the four Node modules it needs", () => {
    assert.deepEqual(
      offences(serverFiles, ["server", "shared"], ["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/plugin/server/usage", "zod", "node:fs/promises", "node:http", "node:https", "node:os", "node:path"]),
      [],
    );
  });

  it("there is no module in the plugin root but the two entries", () => {
    assert.deepEqual(readdirSync(root).filter((name) => /\.tsx?$/.test(name)).sort(), ["index.client.tsx", "index.server.ts"]);
  });

  it("nothing opens a port or listens", () => {
    for (const file of sources) assert.doesNotMatch(read(file), /createServer|\.listen\(|node:(net|dgram|tls|http2|cluster|worker_threads)|WebSocketServer/, file);
  });

  it("the client receives the state the daemon gives it and never sees the key", () => {
    for (const file of clientFiles.concat(sharedFiles)) assert.doesNotMatch(read(file), /bearer|authorization|service\.json|accessToken|refreshToken/i, file);
  });
});

describe("P3.7 · supply chain", () => {
  const pkg = JSON.parse(read("package.json"));

  it("the only runtime dependencies are @getpaseo/plugin and zod, and nothing runs at install", () => {
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@getpaseo/plugin", "zod"]);
    for (const script of ["preinstall", "install", "postinstall", "prepare", "prepack", "prepublish"]) assert.equal(pkg.scripts?.[script], undefined, script);
  });

  it("the lockfile is in the repository and pins both", () => {
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages["node_modules/@getpaseo/plugin"].version, pkg.dependencies["@getpaseo/plugin"]);
    assert.match(lock.packages["node_modules/zod"].version, /^4\./);
    for (const [path, entry] of Object.entries<{ resolved?: string; integrity?: string }>(lock.packages)) {
      if (path) assert.ok(entry.integrity, `${path} has no integrity hash`);
    }
  });

  it("the CI installs it with npm ci --ignore-scripts and runs both checks", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /run: npm ci --ignore-scripts/);
    assert.match(ci, /run: npm run typecheck/);
    assert.match(ci, /run: npm test/);
  });
});

describe("the manifest", () => {
  it("has an id Paseo accepts, a name and a pinned requirement", () => {
    const manifest = JSON.parse(read("paseo-plugin.json"));
    assert.match(manifest.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(manifest.requirements.paseo, ">=0.11.2");
    assert.ok(manifest.name && manifest.description);
  });
});
