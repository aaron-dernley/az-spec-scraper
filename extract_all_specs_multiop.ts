// run_full_extraction.ts

import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { join, basename } from "https://deno.land/std@0.224.0/path/mod.ts";

// --- Constants
const TMP_REPO = ".tmp-azure-rest-api-specs";
const TMP_SPECS = ".tmp-specs";
const OUTPUT_DIR = "new-specs";
const DEFAULT_VERSIONS_FILE = "DEFAULT_VERSIONS.txt";
const NEW_VERSIONS_FILE = "NEW_VERSIONS.txt";

// --- Utility: Clean + capitalize group/resource names
function cleanAndCapitalize(s: string) {
  return s
    .split(/[\s\-_.:]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// --- Utility: Parse resource name from ARM URI
function getGroupAndResourceFromPath(path: string): [string, string] | null {
  const match = path.match(/providers\/Microsoft\.([a-zA-Z0-9]+)\/(.+)/);
  if (!match) return null;
  const group = cleanAndCapitalize(match[1]);
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

function resolveRef(ref: string, root: any): any {
  const parts = ref.replace(/^#\//, "").split("/");
  return parts.reduce((acc, key) => acc?.[key], root);
}
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
function paramSummary(params: any[]) {
  return params.filter(Boolean).map((p) => ({
    name: p.name,
    required: !!p.required,
    type: p.type || (p.schema && p.schema.type) || "unknown",
    in: p.in,
    description: p.description || "",
  }));
}

// --- Step 1: Clone the Azure repo (shallow)
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

// --- Step 2: Copy only the latest stable specs for each resource
async function copyLatestStableSpecs() {
  console.log("[*] Collecting latest stable specs...");
  await Deno.mkdir(TMP_SPECS, { recursive: true });
  const seen = new Set<string>();
  for await (const entry of walk(TMP_REPO, { exts: [".json"], includeDirs: false })) {
    if (
      entry.path.includes("/stable/") &&
      entry.path.includes("/resource-manager/") &&
      !entry.path.includes("examples") &&
      !entry.path.includes("quickstart") &&
      !entry.path.includes("Tests") &&
      !entry.path.includes("examples.json")
    ) {
      const resourceName = basename(entry.path, ".json");
      if (!seen.has(resourceName)) {
        await Deno.copyFile(entry.path, join(TMP_SPECS, basename(entry.path)));
        seen.add(resourceName);
      }
    }
  }
  console.log(`[*] Copied ${seen.size} unique resource specs.`);
}

// --- Step 3: Main extraction
async function processAllSpecs(oldVersions: Record<string, string>) {
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });
  const newVersions: Record<string, string> = {};

  for await (const entry of walk(TMP_SPECS, { exts: [".json"], includeDirs: false })) {
    try {
      const raw = await Deno.readTextFile(entry.path);
      const spec = JSON.parse(raw);

      // Try to find API version from info.version (or fallback to path)
      const apiVersion = spec.info?.version || (entry.path.match(/(\d{4}-\d{2}-\d{2})/)?.[1]) || "unknown";

      const resources: Record<string, any[]> = {};

      for (const [path, ops] of Object.entries<any>(spec.paths || {})) {
        const groupAndResource = getGroupAndResourceFromPath(path);
        if (!groupAndResource) continue;
        const [group, resourceName] = groupAndResource;
        const key = `${group}::${resourceName}`;
        for (const method of Object.keys(ops)) {
          const op = ops[method];
          if (!op) continue;

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

      // Only keep resources with all three: PUT, GET, DELETE
      for (const [key, ops] of Object.entries(resources)) {
        const methodSet = new Set(ops.map((o) => o.method));
        if (!["PUT", "GET", "DELETE"].every((m) => methodSet.has(m))) continue;
        const [group, resourceName] = key.split("::");
        const obj: any = {
          resource: `Azure::${group}::${resourceName}`,
          version: apiVersion,
          operations: ops,
        };
        const fileName = `Azure::${group}::${resourceName}.json`;
        await Deno.writeTextFile(join(OUTPUT_DIR, fileName), JSON.stringify(obj, null, 2));
        newVersions[`Azure::${group}::${resourceName}`] = apiVersion;
        console.log("Wrote:", fileName);
      }
    } catch (err) {
      console.warn("Failed to parse spec:", entry.path, err.message);
    }
  }
  return newVersions;
}

// --- Utility: Write JSON key-value (pretty, sorted)
async function writeJsonFile(file: string, obj: Record<string, string>) {
  const sorted = Object.fromEntries(Object.entries(obj).sort());
  await Deno.writeTextFile(file, JSON.stringify(sorted, null, 2));
}

// --- Utility: Write diff of new/updated versions only
async function writeNewVersionsDiff(oldObj: Record<string, string>, newObj: Record<string, string>, file: string) {
  const diff: Record<string, string> = {};
  for (const [k, v] of Object.entries(newObj)) {
    if (!oldObj[k] || oldObj[k] !== v) diff[k] = v;
  }
  await writeJsonFile(file, diff);
}

// --- Cleanup tmp dirs
async function cleanup() {
  try { await Deno.remove(TMP_REPO, { recursive: true }); } catch {}
  try { await Deno.remove(TMP_SPECS, { recursive: true }); } catch {}
}

// --- MAIN ORCHESTRATOR
async function main() {
  await cleanup();
  // Read previous DEFAULT_VERSIONS.txt if exists
  let oldVersions: Record<string, string> = {};
  try {
    oldVersions = JSON.parse(await Deno.readTextFile(DEFAULT_VERSIONS_FILE));
  } catch {}

  await cloneRepo();
  await copyLatestStableSpecs();
  const newVersions = await processAllSpecs(oldVersions);
  await writeJsonFile(DEFAULT_VERSIONS_FILE, newVersions);
  await writeNewVersionsDiff(oldVersions, newVersions, NEW_VERSIONS_FILE);
  await cleanup();
  console.log("[*] Done!");
}

await main();
