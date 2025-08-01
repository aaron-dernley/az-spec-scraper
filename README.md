This script automates the extraction of Azure resource and subresource definitions, with all relevant operations and parameters, from the official Azure REST API OpenAPI specs.

---

## It:

- **Clones** the Azure REST API specs repo
- **Extracts all latest stable versions of resource types/subresources** with all relevant operations
  (requiring a min of GET, PUT, and DELETE)
- **Outputs** JSON files per resource (e.g., `Azure::Network::VirtualNetworks.json`)
- Includes **all required/optional body properties, URI path parameters, and query parameters** for each operation
- **Outputs** the versions of the extracted resources, on re-runs compares the versions to detect new
- **Cleans up** all temporary/cloned files when done

---

## Prerequisites

- [Deno](https://deno.com/manual/getting_started/installation) installed

---

## Usage

- **Run for all Azure OpenAPI specs:**
  ```bash
  deno task run-all
  ```
- **Run for one Azure OpenAPI spec (update the url in script manually for the spec you want):**
  ```bash
  deno task run-one
  ```

## Specs

- **Stored in /new-specs folder**
