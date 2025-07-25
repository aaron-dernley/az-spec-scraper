// run_full_extraction.ts

import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { join, basename } from "https://deno.land/std@0.224.0/path/mod.ts";

const TMP_REPO = ".tmp-azure-rest-api-specs";
const TMP_SPECS = ".tmp-specs";
const OUTPUT_DIR = "new-specs";
const DEFAULT_VERSIONS_FILE = "DEFAULT_VERSIONS.txt";
const NEW_VERSIONS_FILE = "NEW_VERSIONS.txt";

// --- Clean and capitalize for SI-style filenames (no spaces/symbols, each word capitalized)
function cleanAndCapitalize(s: string) {
  return s
    .split(/[\s\-_.:]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// --- Detects the deepest resource in the path for sub-resources.
function getGroupAndResourceFromPath(path: string): [string, string] | null {
  const match = path.match(/providers\/Microsoft\.([a-zA-Z0-9]+)\/(.+)/);
  if (!match) return null;
  const group = cleanAndCapitalize(match[1]);
  // Pick the last non-template path segment as the resource
  const segments = match[2].split("/");
  let resource = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].startsWith("{") && segments[i] !== "") {
      resource = cleanAndCapitalize(segments[i]);
      break;
    }
  }
  if (!resource) return null;
  return [group, resource];
}

// --- Recursively resolve a JSON $ref path in OpenAPI
function resolveRef(ref: string, root: any): any {
  const parts = ref.replace(/^#\//, "").split("/");
  return parts.reduce((acc, key) => acc?.[key], root);
}

// --- Recursively extract required and optional property names from a schema
function extractProps(schema: any, root: any, out: { required: Set<string>; optional: Set<string> }, prefix = "") {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    if (resolved) extractProps(resolved, root, out, prefix);
    return;
  }
  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) extractProps(sub, root, out, prefix);
  }
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const [key, val] of Object.entries<any>(props)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (required.has(key)) out.required.add(full);
    else out.optional.add(full);
    if (val.type === "object" || val.properties || val.$ref || val.allOf) {
      extractProps(val, root, out, full);
    }
  }
}

// --- Flattens parameter objects for easy writing in output JSON
function paramSummary(params: any[]) {
  return params.filter(Boolean).map((p) => ({
    name: p.name,
    required: !!p.required,
    type: p.type || (p.schema && p.schema.type) || "unknown",
    in: p.in,
    description: p.description || "",
  }));
}

// --- Load DEFAULT_VERSIONS.txt as a map
async function loadVersionMap(file: string) {
  try {
    const raw = await Deno.readTextFile(file);
    const entries = raw
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^"|"$/g, '').split(' : '))
      .filter(parts => parts.length === 2);
    return Object.fromEntries(entries.map(([k, v]) => [
      k.trim().replace(/^"|"$/g, ''),
      v.trim().replace(/^"|"$/g, ''),
    ]));
  } catch {
    return {};
  }
}

// --- Write only changed/new versions to NEW_VERSIONS.txt
async function writeNewVersionsDiff(prevFile: string, currFile: string, outFile: string) {
  const prev = await loadVersionMap(prevFile);
  const curr = await loadVersionMap(currFile);
  const changed = [];
  for (const k of Object.keys(curr)) {
    if (!prev[k] || prev[k] !== curr[k]) {
      changed.push([k, curr[k]]);
    }
  }
  if (changed.length > 0) {
    const lines = changed.map(([k, v]) => `"${k}" : "${v}"`);
    await Deno.writeTextFile(outFile, lines.join("\n"));
    console.log(`[*] Found ${changed.length} updated/new resource versions. Wrote ${outFile}.`);
  } else {
    try { await Deno.remove(outFile); } catch {}
    console.log("[*] No new versions detected.");
  }
}

// --- Step 1: Clone the Azure API spec repo (shallow)
async function cloneRepo() {
  console.log("[*] Cloning Azure REST API specs repo...");
  const p = Deno.run({
    cmd: [
      "git",
      "clone",
      "--depth=1",
      "https://github.com/Azure/azure-rest-api-specs.git",
      TMP_REPO,
    ],
    stdout: "null",
    stderr: "inherit",
  });
  const { code } = await p.status();
  if (code !== 0) throw new Error("Git clone failed.");
  console.log("[*] Clone complete.");
}

// --- Step 2: Copy only the latest stable specs for each resource into TMP_SPECS
async function copyLatestStableSpecs(defaultVersions: Record<string, string>) {
  console.log("[*] Collecting latest stable specs...");
  await Deno.mkdir(TMP_SPECS, { recursive: true });
  const seen = new Set<string>();
  for await (const entry of walk(TMP_REPO, { exts: [".json"], includeDirs: false })) {
    // Only use stable, resource-manager specs, skip test/examples
    if (
      entry.path.includes("/stable/") &&
      entry.path.includes("/resource-manager/") &&
      !entry.path.includes("examples") &&
      !entry.path.includes("quickstart") &&
      !entry.path.includes("Tests") &&
      !entry.path.includes("examples.json")
    ) {
      const rel = entry.path.split("/specification/")[1]; // e.g., "network/resource-manager/Microsoft.Network/stable/2024-07-01/virtualNetwork.json"
      const versionMatch = rel.match(/stable\/([^\/]+)\//);
      const resourceName = basename(entry.path, ".json");
      if (!seen.has(resourceName)) {
        await Deno.copyFile(entry.path, join(TMP_SPECS, basename(entry.path)));
        seen.add(resourceName);

        // For DEFAULT_VERSIONS.txt
        const [providerMatch, resourceType] = rel.split("/stable/");
        const groupMatch = providerMatch?.split("/")[2] || ""; // Microsoft.Network
        // For filename, we only want group::resource, properly formatted
        const group = cleanAndCapitalize(groupMatch?.replace(/^Microsoft\./, "") || "Unknown");
        const res = cleanAndCapitalize(resourceName.replace(".json", ""));
        const fileKey = `Azure::${group}::${res}`;
        if (versionMatch) {
          defaultVersions[fileKey] = versionMatch[1];
        }
      }
    }
  }
  console.log(`[*] Copied ${seen.size} unique resource specs.`);
}

// --- Step 3: Main extraction logic
async function processAllSpecs(defaultVersions: Record<string, string>) {
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });

  for await (const entry of walk(TMP_SPECS, { exts: [".json"], includeDirs: false })) {
    try {
      const raw = await Deno.readTextFile(entry.path);
      const spec = JSON.parse(raw);

      const resources: Record<string, any[]> = {};

      // --- For every path (endpoint) in the OpenAPI spec
      for (const [path, ops] of Object.entries<any>(spec.paths || {})) {
        const groupAndResource = getGroupAndResourceFromPath(path);
        if (!groupAndResource) continue;
        const [group, resourceName] = groupAndResource;
        const key = `${group}::${resourceName}`;
        for (const method of Object.keys(ops)) {
          const op = ops[method];
          if (!op) continue;

          // --- Collect parameters (resolve $ref and path template params)
          const params = (op.parameters || []).map((p: any) =>
            p?.$ref ? resolveRef(p.$ref, spec) : p
          );
          if (spec.paths[path]?.parameters) {
            for (const p of spec.paths[path].parameters) {
              const real = p?.$ref ? resolveRef(p.$ref, spec) : p;
              if (!params.some((pp: any) => pp && pp.name === real.name && pp.in === real.in))
                params.push(real);
            }
          }
          // --- Patch in URI template params if missing
          const pathParamNames = [...path.matchAll(/{([^}]+)}/g)].map((m) => m[1]);
          for (const paramName of pathParamNames) {
            if (!params.some((p: any) => p && p.name === paramName && p.in === "path")) {
              params.push({
                name: paramName,
                in: "path",
                required: true,
                type: "string",
                description: "(from URI template)",
              });
            }
          }
          const pathParams = paramSummary(params.filter((p: any) => p && p.in === "path"));
          const queryParams = paramSummary(params.filter((p: any) => p && p.in === "query"));

          // --- If this is a PUT, PATCH, or POST, extract schema properties
          let schemaName, requiredProps, optionalProps;
          if (["put", "patch", "post"].includes(method)) {
            let ref;
            const bodyParam = params.find((p: any) => p && (p.in === "body" || p.name === "parameters"));
            ref = bodyParam?.schema?.$ref;
            if (!ref && op.requestBody) {
              ref = op.requestBody.content?.["application/json"]?.schema?.$ref;
            }
            if (ref) {
              schemaName = ref.split("/").pop();
              const schema = resolveRef(ref, spec);
              if (schema) {
                const out = { required: new Set<string>(), optional: new Set<string>() };
                extractProps(schema, spec, out);
                requiredProps = Array.from(out.required).sort();
                optionalProps = Array.from(out.optional).sort();
              }
            }
          }

          // --- Record all operations for this resource key
          if (!resources[key]) resources[key] = [];
          resources[key].push({
            method: method.toUpperCase(),
            path,
            operationId: op.operationId,
            bodySchema: schemaName,
            requiredProperties: requiredProps,
            optionalProperties: optionalProps,
            pathParameters: pathParams,
            queryParameters: queryParams,
          });
        }
      }

      // --- Output only resource files for entities that support GET, PUT, and DELETE
      for (const [key, ops] of Object.entries(resources)) {
        const methodSet = new Set(ops.map((o) => o.method));
        if (!["PUT", "GET", "DELETE"].every((m) => methodSet.has(m))) continue;
        const [group, resourceName] = key.split("::");
        // Add version to each spec file
        const fileKey = `Azure::${group}::${resourceName}`;
        const obj: any = {
          resource: fileKey,
          version: defaultVersions[fileKey] || "unknown",
          operations: ops,
        };
        const fileName = `Azure::${group}::${resourceName}.json`;
        await Deno.writeTextFile(join(OUTPUT_DIR, fileName), JSON.stringify(obj, null, 2));
        console.log("Wrote:", fileName);
      }
    } catch (err) {
      console.warn("Failed to parse spec:", entry.path, err.message);
    }
  }
}

// --- Step 4: Cleanup (remove tmp folders before/after)
async function cleanup() {
  try { await Deno.remove(TMP_REPO, { recursive: true }); } catch {}
  try { await Deno.remove(TMP_SPECS, { recursive: true }); } catch {}
}

// --- Orchestrator: full flow (clone, extract, cleanup, diff)
async function main() {
  await cleanup();

  // Load previous versions (for diff)
  const prevVersions = await loadVersionMap(DEFAULT_VERSIONS_FILE);

  const defaultVersions: Record<string, string> = {};
  await cloneRepo();
  await copyLatestStableSpecs(defaultVersions);

  // Write latest DEFAULT_VERSIONS.txt (after copy)
  const sortedKeys = Object.keys(defaultVersions).sort();
  const versionsContent = sortedKeys.map(k => `"${k}" : "${defaultVersions[k]}"`).join("\n");
  await Deno.writeTextFile(DEFAULT_VERSIONS_FILE, versionsContent);

  await processAllSpecs(defaultVersions);

  // Write NEW_VERSIONS.txt ONLY if there are new/updated resources
  await writeNewVersionsDiff(DEFAULT_VERSIONS_FILE, DEFAULT_VERSIONS_FILE, NEW_VERSIONS_FILE);

  await cleanup();
  console.log("[*] Done!");
}

await main();
