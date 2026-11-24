# Security model

**Threats considered:** a malicious or compromised task/context (prompt injection), a misbehaving model, a
compromised Arcade server, accidental credential disclosure.

| Control | Where |
|---|---|
| Task contexts are validated against a strict shape; only `system`, `user`, ids and hashes are used. Nothing in a context can choose an endpoint, model, parameter, tool or file. | `src/arcade.js` |
| A single inference function builds request bodies from a fixed whitelist. No `tools`, `functions` or `tool_choice` fields are ever sent; tool calls in replies are discarded. | `src/providers.js` |
| No code paths execute, eval, spawn processes, read files named by the server, or follow URLs from tasks. | whole codebase |
| Local providers must be loopback addresses; the Arcade and cloud providers must be HTTPS; redirects are refused; responses are size-capped and time-limited. | `src/util.js`, `src/providers.js` |
| Outbound payloads are scanned for every locally known secret and common key formats; a match aborts the submission. | `src/core.js` |
| The exact payload is shown before submission unless `auto_submit` is explicitly enabled. | `bin/arcade-agent.js` |
| Config and credentials are written with mode 0600 in your user profile. | `src/config.js` |
| Contributor tokens are revocable server-side and grant only the community API. | server |

Server side, submissions are moderated, rate-limited, size-limited, checked for credentials, bound to a context that
was actually issued to the contributor, and never cause any model call or spend by the Arcade.

Report vulnerabilities privately to the Arcade editor (Rondanini Publishing Ltd) rather than opening a public issue.
