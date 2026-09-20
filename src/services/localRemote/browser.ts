export const LOCAL_REMOTE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Free Code — Local Remote</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Free Code · Local Remote</h1><p>Connect to your own running CLI. Keep this token private.</p>
<form id="connect"><input id="token" type="password" placeholder="Server access token" autocomplete="off" required><button>Connect</button></form>
<p id="status" role="status">Disconnected</p><pre id="events"></pre><div id="permissions"></div>
<form id="prompt"><textarea id="text" placeholder="Ask the agent…" required></textarea><button>Send</button><button id="cancel" type="button">Stop turn</button></form>
</main><script src="/client.js"></script></body></html>`

export const LOCAL_REMOTE_CSS = `body{font:16px system-ui;background:#16191e;color:#eceff4;margin:0}main{max-width:960px;padding:24px;margin:auto}input,textarea,button{font:inherit;padding:10px;border:1px solid #667085;border-radius:6px;background:#232831;color:inherit}input{min-width:50%}textarea{display:block;box-sizing:border-box;width:100%;min-height:100px;margin:12px 0}button{cursor:pointer;margin:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:30vh;max-height:55vh;overflow:auto;border:1px solid #414955;border-radius:6px;padding:16px}.permission{border:1px solid #e6b467;padding:12px;margin:8px 0}`

// The token stays in memory, never in a URL, cookie, localStorage, or transcript.
export const LOCAL_REMOTE_JS = `
let token = '', reader, lastEvent = 0, connection;
const byId = id => document.getElementById(id);
const status = text => { byId('status').textContent = text; };
async function api(path, body, method = 'POST') {
  const response = await fetch(path, {method, headers: {'Authorization': 'Bearer ' + token, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || response.statusText);
  return result;
}
function permission(message) {
  const id = message.request_id;
  if (document.getElementById(id)) return;
  const box = document.createElement('div'); box.id = id; box.className = 'permission';
  const text = document.createElement('pre'); text.textContent = message.request.tool_name + '\\n' + JSON.stringify(message.request.input, null, 2); box.append(text);
  for (const allow of [true, false]) { const button = document.createElement('button'); button.textContent = allow ? 'Allow once' : 'Deny'; button.onclick = async () => {try {await api('/permission', {requestId:id, allow}); box.remove();} catch(e) {status(e.message);}}; box.append(button); }
  byId('permissions').append(box);
}
function event(message) {
  if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') permission(message);
  if (message.type === 'result' || message.type === 'local_session_closed' || message.type === 'local_permissions_cleared') byId('permissions').replaceChildren();
  if (message.type === 'control_cancel_request' || message.type === 'local_permission_resolved') document.getElementById(message.request_id)?.remove();
  const log = byId('events'); log.textContent = (log.textContent + JSON.stringify(message, null, 2) + '\\n').slice(-250000); log.scrollTop = log.scrollHeight;
  if (message.type === 'result') status('Ready');
  if (message.type === 'local_session_closed') status('Session closed; restart the server to start another session.');
}
async function connect() {
  connection?.abort(); await reader?.cancel(); connection = new AbortController();
  const signal = connection.signal;
  const snapshot = await api('/status', null, 'GET');
  byId('permissions').replaceChildren(); snapshot.permissions.forEach(permission); status(snapshot.state);
  const response = await fetch('/events?after=' + lastEvent, {headers: {'Authorization':'Bearer ' + token}, signal});
  if (!response.ok) throw Error('Connection failed (' + response.status + ')');
  const ownedReader = response.body.getReader(); reader = ownedReader; const decoder = new TextDecoder(); let pending = '';
  try { while (true) { const chunk = await ownedReader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, {stream:true}); let end; while ((end = pending.indexOf('\\n\\n')) >= 0) { const frame = pending.slice(0,end); pending = pending.slice(end+2); const id = frame.match(/^id: (\\d+)$/m), payload = frame.match(/^data: (.*)$/m); if (id && payload) { lastEvent = Number(id[1]); event(JSON.parse(payload[1])); } } } if (!signal.aborted) status('Disconnected. Press Connect to resume the event feed.'); }
  finally { ownedReader.releaseLock(); if (reader === ownedReader) reader = undefined; }
}
byId('connect').onsubmit = e => {e.preventDefault(); token = byId('token').value || token; byId('token').value = ''; connect().catch(e => {if (e.name !== 'AbortError') status(e.message);});};
byId('prompt').onsubmit = async e => {e.preventDefault(); try {await api('/prompt', {prompt:byId('text').value}); byId('text').value = ''; status('Running');} catch(e) {status(e.message);}};
byId('cancel').onclick = async () => {try {await api('/cancel', {}); byId('permissions').replaceChildren(); status('Interrupt requested');} catch(e) {status(e.message);}};
window.addEventListener('pagehide', () => connection?.abort());
`
