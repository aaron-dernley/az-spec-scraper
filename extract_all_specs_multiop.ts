// run_full_extraction.ts

import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { join, basename } from "https://deno.land/std@0.224.0/path/mod.ts";

// --- Directory constants for the temporary clone, extracted specs, and final output
const TMP_REPO = ".tmp-azure-rest-api-specs";
const TMP_SPECS = ".tmp-specs";
const OUTPUT_DIR = "new-specs";

// --- Utility: Cleans a name (removes spacing, symbols), capitalizes all words (for SI-style filenames)
function cleanAndCapitalize(s: string) {
  return s
    .split(/[\s\-_.:]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// --- Utility: Finds the resource group and resource type (subresource) from a path
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

// --- Utility: Recursively resolve a JSON $ref path in OpenAPI
function resolveRef(ref: string, root: any): any {
  const parts = ref.replace(/^#\//, "").split("/");
  return parts.reduce((acc, key) => acc?.[key], root);
}

// --- Utility: Recursively extract required and optional property names from a schema
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

// --- Utility: Flattens parameter objects for easy writing in output JSON
function paramSummary(params: any[]) {
  return params.filter(Boolean).map((p) => ({
    name: p.name,
    required: !!p.required,
    type: p.type || (p.schema && p.schema.type) || "unknown",
    in: p.in,
    description: p.description || "",
  }));
}

// --- Step 1: Clone the Azure API spec repo (shallow)
async function cloneRepo() {
  console.log("[*] Cloning only 'specification' folder from Azure REST API specs repo...");
  const gitClone = Deno.run({
    cmd: [
      "git",
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--sparse",
      "https://github.com/Azure/azure-rest-api-specs.git",
      TMP_REPO,
    ],
    stdout: "null",
    stderr: "inherit",
  });
  let code = (await gitClone.status()).code;
  if (code !== 0) throw new Error("Git sparse clone failed.");
  const sparse = Deno.run({
    cmd: [
      "git",
      "-C",
      TMP_REPO,
      "sparse-checkout",
      "set",
      "specification"
    ],
    stdout: "null",
    stderr: "inherit",
  });
  code = (await sparse.status()).code;
  if (code !== 0) throw new Error("Sparse-checkout failed.");
  console.log("[*] Sparse clone complete.");
}

// --- Step 2: Copy only the latest stable specs for each resource into TMP_SPECS
async function copyLatestStableSpecs() {
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
      const resourceName = basename(entry.path, ".json");
      if (!seen.has(resourceName)) {
        await Deno.copyFile(entry.path, join(TMP_SPECS, basename(entry.path)));
        seen.add(resourceName);
      }
    }
  }
  console.log(`[*] Copied ${seen.size} unique resource specs.`);
}

// --- Step 3: Main extraction logic
async function processAllSpecs() {
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
        const obj: any = {
          resource: `Azure::${group}::${resourceName}`,
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

// --- Orchestrator: full flow (clone, extract, cleanup)
async function main() {
  await cleanup();
  await cloneRepo();
  await copyLatestStableSpecs();
  await processAllSpecs();
  await cleanup();
  console.log("[*] Done!");
}

await main();
