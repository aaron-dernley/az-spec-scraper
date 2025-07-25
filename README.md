This tool automates the extraction of all Azure ARM resource types (including subresources) and their key API operations (PUT, GET, DELETE, PATCH, POST) and parameters from the Azure REST API OpenAPI specs

It:
	•	Clones the Azure rest API spec repo
	•	Extracts all resource types/subresources with all relevant operations (Minimum of GET/PUT/DELETE)
	•	Outputs JSON files per resource (e.g. Azure::Network::VirtualNetworks.json)
	•	Includes all required/optional body properties, URI path parameters, and query parameters for each operation
	•	Cleans up cloned files once complete


Prerequisites:
	•	Deno installed

Usage:
	•	deno run task run-all (runs for all open api specs)
	•	deno run task run-one (runs for a single open api spec - path to file must be specified in const url at the top of the file)
