import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const url =
  "https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/network/resource-manager/Microsoft.Network/stable/2024-07-01/virtualNetwork.json";
const outputDir = "new-specs";

function getResourceNameFromPath(path: string): string | null {
  const match = path.match(/providers\/Microsoft\.Network\/(.+)/);
  if (!match) return null;
  const parts = match[1].split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].startsWith("{")) return capitalize(parts[i]);
  }
  return null;
}
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

async function main() {
  console.log("Fetching spec...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
  const spec = await res.json();

  await Deno.mkdir(outputDir, { recursive: true });

  const resources: Record<string, any[]> = {};

  for (const [path, ops] of Object.entries<any>(spec.paths)) {
    const resourceName = getResourceNameFromPath(path);
    if (!resourceName) continue;
    for (const method of Object.keys(ops)) {
      const op = ops[method];
      if (!op) continue;

      const params = (op.parameters || []).map((p: any) =>
        p?.$ref ? resolveRef(p.$ref, spec) : p
      );
      // Add any path-level parameters
      if (spec.paths[path]?.parameters) {
        for (const p of spec.paths[path].parameters) {
          const real = p?.$ref ? resolveRef(p.$ref, spec) : p;
          if (!params.some((pp: any) => pp && pp.name === real.name && pp.in === real.in))
            params.push(real);
        }
      }
      // Add parameters from path template if not present (including subscriptionId)
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

            // PATCH: if there are no required/optional but there *are* properties, list all keys as optional
            if (
              method === "patch" &&
              Object.keys(schema.properties || {}).length > 0 &&
              out.required.size === 0 &&
              out.optional.size === 0
            ) {
              for (const key of Object.keys(schema.properties)) {
                out.optional.add(key);
              }
            }
            requiredProps = Array.from(out.required).sort();
            optionalProps = Array.from(out.optional).sort();
          }
        }
      }

      if (!resources[resourceName]) resources[resourceName] = [];
      resources[resourceName].push({
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
  for (const [resourceName, ops] of Object.entries(resources)) {
    const methodSet = new Set(ops.map((o) => o.method));
    if (!["PUT", "GET", "DELETE"].every((m) => methodSet.has(m))) continue;

    const obj: any = {
      resource: `Azure::Network::${resourceName}`,
      operations: ops,
    };

    const fileName = `Azure::Network::${resourceName}.json`;
    await Deno.writeTextFile(join(outputDir, fileName), JSON.stringify(obj, null, 2));
    console.log("Wrote:", fileName);
  }
}

await main();
