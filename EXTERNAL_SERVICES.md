# Independent web, voice, and local remote services

Model providers and external services are configured separately. Free Code reads
`~/.claude/services.json` (or `$CLAUDE_CONFIG_DIR/services.json`) at startup. Set
`FREE_CODE_SERVICES_FILE` or pass `--services-file /path/to/services.json` to use a
different file. This is user configuration, not a project-controlled credential file.
Restart after changing the file or its referenced environment variables. Services
retain their own credential snapshot; switching the language model does not change it.

## Web search

Choose one search service. Both work independently of the language model and return
source titles, URLs, and snippets to that model. Existing `WebSearch` permissions
still apply. Domain filters are checked locally against returned result URLs;
`example.com` also matches `docs.example.com`, never `notexample.com`.

For a self-hosted SearXNG instance:

```json
{
  "webSearch": {
    "provider": "searxng",
    "baseURL": "http://127.0.0.1:8888",
    "maxResults": 10,
    "timeoutMs": 20000
  }
}
```

Enable `json` in the instance's `search.formats` in `settings.yml`. The client calls
`<baseURL>/search?q=...&format=json&categories=general`. A localhost instance does
not require an API key. For remote instances use HTTPS. This integration does not
start or install SearXNG, and does not choose a public instance automatically.
See the [SearXNG search API](https://docs.searxng.org/dev/search_api.html).

For Brave Search:

```json
{
  "webSearch": {
    "provider": "brave",
    "apiKeyEnv": "BRAVE_SEARCH_API_KEY",
    "maxResults": 10
  }
}
```

Export your key before starting Free Code. `apiKeyEnv` names an environment variable;
do not put its value in the JSON file. The default endpoint is
`https://api.search.brave.com`, using its `/res/v1/web/search` API. The endpoint and
result fields follow the [Brave Search documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started).
Brave account access and billing are separate from the language model provider.
Brave queries, including any added domain filters, are limited to 600 characters
and 75 words; shorten the query if the client reports this limit.

Both backends accept at most 20 results per request. Search requests go to the
selected service, and results are returned to the current model; search errors
never fall back to Anthropic.
Without a search configuration, legacy Claude sessions retain their original search
behavior. Custom model profiles need a configured service for `WebSearch`.

## Web page fetch

Custom model profiles default to direct HTTP fetch and local HTML-to-Markdown
extraction, with no Anthropic domain-check request or secondary summarization model.
The current model receives bounded page content and the original extraction prompt.
To also use this mode for legacy model sessions:

```json
{
  "webFetch": { "mode": "direct" }
}
```

Domain permissions still apply. Redirects to another host require a new tool call
and permission evaluation. Direct fetch rejects private/local destinations and
validates public DNS addresses before every connection, pinning each connection to
the validated IP while verifying the original hostname's TLS certificate. HTTP
URLs are upgraded to HTTPS. It does not forward browser cookies, provider API keys
or authenticated sessions; use an authenticated MCP connector when needed.

HTTP(S) proxies configured through `HTTPS_PROXY`/`HTTP_PROXY` and their lowercase
variants are supported, with the existing `NO_PROXY` rules. CONNECT targets use
the validated public IP, so the proxy must permit IP-address CONNECT targets;
proxies that require hostname targets or proxy-only DNS resolution need a
specialized MCP fetch tool. Custom CA certificates are retained. Proxy credentials
are sent only to the proxy, and requests never bypass a configured proxy after an
error. Proxy setup, TLS negotiation and body transfer share cancellation and the
same overall timeout.

Limits are a 2,000-character URL, 5 MiB response body, 10 followed redirects and a
60-second total timeout. Page excerpts contain at most 20,000 characters, reduced
to half the configured model's context-window number for smaller models (for
example, a 16,384-token model receives at most 8,192 page characters). The tool
marks truncated content. HTML, plain text, Markdown, JSON and XML are supported;
binary documents are rejected. The client requests uncompressed content and
rejects servers that return compression anyway. Direct mode has no page cache.
Set `"webFetch": { "mode": "legacy" }` only when intentionally using the original
Anthropic preflight and secondary-model flow.

## Voice

Configure an OpenAI-compatible audio transcription service independently of the
language model. A local Whisper server can run without an API key:

```json
{
  "voice": {
    "api": "openai-transcription",
    "baseURL": "http://127.0.0.1:9000/v1",
    "model": "whisper-local",
    "language": "zh",
    "timeoutMs": 60000,
    "maxRecordingSeconds": 300
  }
}
```

Use your server's actual model ID. `baseURL` is the API root; Free Code appends
`/audio/transcriptions`. The endpoint must accept a multipart `file` containing
16 kHz, mono, signed 16-bit PCM WAV, `model`, and `response_format=json`, and return
`{"text":"..."}`. This follows the [OpenAI file transcription API](https://developers.openai.com/api/docs/guides/speech-to-text).
A local service must implement that route; this configuration does not install or
start Whisper. For hosted services use HTTPS and add `"apiKeyEnv":"VOICE_API_KEY"`,
then export that variable before starting Free Code. Voice never borrows the current
model's API key or Anthropic OAuth token.

Run `/voice`, then hold the configured push-to-talk key and release it to transcribe.
This backend uploads after release; it does not provide live interim captions.
`language` is an optional two-letter language code; without it the normal dictation
language setting is used. For example, `zh` supports Chinese without the legacy
Anthropic language allowlist. Microphone access and a native recording module or
SoX/arecord are still needed. Focus mode submits when focus is lost or five seconds
of microphone silence are detected. The recording limit bounds memory use and the
request timeout aborts stalled uploads. Audio remains in memory, and cancelled
recordings are discarded. No audio file is saved by this client.

The default recording limit is five minutes (configurable up to ten); the upload
deadline is 60 seconds. Authentication, HTTP, malformed-response, and timeout errors
are reported directly, with no fallback to another service. Without a `voice`
configuration, the existing Anthropic OAuth voice backend remains available.

## Configuration validation

Unknown fields are rejected. Endpoints must use HTTPS, except HTTP loopback for a
local service; URL credentials, query parameters, and fragments are not accepted.
Timeouts and result limits are validated at startup. The absence of the default file
preserves legacy behavior; an explicitly named missing file is an error.

## Local Remote Control

Run a persistent local agent session with a browser interface:

```bash
./cli local-remote --cwd /path/to/project --port 8080 -- \
  --provider local --model local/qwen --providers-file /path/to/providers.json
```

Open the printed URL and enter the generated access token. Alternatively, set
`FREE_CODE_REMOTE_TOKEN` to a secret of at least 32 non-whitespace characters;
`--token-env NAME` selects another variable. Tokens remain in browser memory and
are never included in URLs or cookies. The service binds only `127.0.0.1`. To use
it from another machine, forward that port with SSH:

```bash
ssh -L 8080:127.0.0.1:8080 user@agent-host
```

Then open `http://127.0.0.1:8080` locally. This creates a new headless CLI session
in the selected workspace; it does not attach to an existing terminal REPL or
replace the legacy `/remote-control` cloud session. Subsequent prompts reuse the
same child process and conversation. The browser shows streaming SDK events,
pending tool approvals, and a Stop turn button. Tool approvals remain enabled;
approving a pending request authorizes that exact input once. Closing the browser
disconnects the event feed but leaves the session running. Reconnect with the token
to view its status and recent events. The event replay buffer is bounded, so it is
not a permanent transcript store.

The service needs no Anthropic account or hosted relay. Language-model requests
still use the selected provider, which may itself be hosted. Model credentials
are inherited by the CLI child; the HTTP service does not return its environment,
stderr, or initialization account metadata. The access token grants control of
the session and its tool approvals, so treat it as a credential.

For API clients, send `Authorization: Bearer TOKEN`; POST requests also require
`Content-Type: application/json`:

| Endpoint | Behavior |
| --- | --- |
| `GET /status` | Current state, session ID, and pending permissions |
| `GET /events?after=0` | SSE events with numeric IDs; reconnect from the last ID |
| `POST /prompt` with `{"prompt":"…"}` | Start a turn; concurrent turns are rejected |
| `POST /cancel` with `{}` | Interrupt the current turn, keeping the session |
| `POST /permission` with `{"requestId":"…","allow":true}` | Approve once, or deny with `false` |
| `DELETE /session` | Stop the child; restart the server to create another session |

Cross-origin requests are rejected. HTTP prompt bodies are limited to 256 KiB.
Press Ctrl-C in the server terminal to stop the service; shutdown closes event
feeds, terminates the owned CLI, waits for completion, and escalates termination
if needed. POSIX launches use a separate process group for shutdown.

## Local advanced planning

With a custom model profile, `/ultraplan <request>` enters the ordinary local plan
mode and asks the selected model to investigate the workspace with available
Plan/Explore agents. The plan and its approval remain in this session. The plan
approval dialog also offers local refinement. Existing plan permissions and
Escape cancellation apply; no cloud task, repository upload, or hosted session is
created. This entry is available without the legacy `ULTRAPLAN` build feature.
Without a profile, the legacy feature-gated hosted planning behavior is retained.
