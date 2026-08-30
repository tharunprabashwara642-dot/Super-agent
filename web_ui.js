const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Super Agent</title>
<style>
  :root {
    --bg: #f7f7f5;
    --panel: #ffffff;
    --line: #e6e6e2;
    --text: #1a1a1a;
    --muted: #6b6b66;
    --accent: #1a1a1a;
    --user-bg: #efefec;
    --soft: #f0f0ed;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    overflow: hidden;
  }
  .app { height: 100%; display: grid; grid-template-columns: 240px 1fr; }
  .side {
    background: var(--panel);
    border-right: 1px solid var(--line);
    padding: 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .brand { font-weight: 650; letter-spacing: -0.02em; display: flex; gap: 10px; align-items: center; }
  .orb {
    width: 22px; height: 22px; border-radius: 6px;
    background: var(--accent);
  }
  .new {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--soft);
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .new:hover { background: #e8e8e4; }
  .hint { margin-top: auto; color: var(--muted); font-size: 12px; line-height: 1.4; }
  .main { min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
  .top {
    height: 54px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    background: var(--panel);
  }
  .status { font-size: 12px; color: var(--muted); }
  .dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: #22c55e; margin-right: 7px;
  }
  .chat {
    flex: 1; overflow: auto;
    padding: 28px max(20px, calc((100vw - 860px) / 2));
  }
  .welcome { max-width: 720px; margin: 12vh auto; }
  .welcome h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.03em; font-weight: 650; }
  .welcome p { color: var(--muted); margin: 0; }
  .msg { max-width: 720px; margin: 0 auto 20px; display: flex; gap: 12px; }
  .avatar {
    width: 28px; height: 28px; flex: 0 0 28px; border-radius: 8px;
    background: var(--soft); display: grid; place-items: center; font-size: 12px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .user .avatar { background: var(--text); color: #fff; border-color: var(--text); }
  .bubble { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user .bubble {
    background: var(--user-bg);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 13px;
  }
  .thinking { color: var(--muted); font-style: italic; }
  .confirm {
    margin-top: 10px; padding: 12px;
    border: 1px solid var(--line); background: var(--panel); border-radius: 12px;
  }
  .confirm button {
    border: 0; border-radius: 8px; padding: 8px 12px; margin-right: 6px; cursor: pointer; font: inherit;
  }
  .yes { background: var(--text); color: #fff; }
  .no { background: var(--soft); color: var(--text); border: 1px solid var(--line) !important; }
  .composer {
    border-top: 1px solid var(--line);
    padding: 14px max(20px, calc((100vw - 860px) / 2));
    background: var(--panel);
  }
  .box {
    display: flex; gap: 8px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 8px;
  }
  .box:focus-within { border-color: #bdbdb6; box-shadow: 0 0 0 3px rgba(0,0,0,0.03); }
  .box textarea {
    flex: 1; resize: none; max-height: 160px;
    background: transparent; border: 0; outline: none;
    color: var(--text); font: inherit; padding: 8px 6px;
  }
  .send {
    border: 0; border-radius: 10px; padding: 0 14px;
    background: var(--text); color: #fff; cursor: pointer; font: inherit; font-weight: 600;
  }
  .send:disabled { opacity: 0.45; cursor: default; }
  @media (max-width: 820px) {
    .app { grid-template-columns: 1fr; }
    .side { display: none; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><span class="orb"></span> Super Agent</div>
    <button class="new" id="newChat">+ New chat</button>
    <div class="hint">Clean classic UI · same agent as Telegram · confirmations for sensitive tools.</div>
  </aside>
  <main class="main">
    <div class="top">
      <div class="status"><span class="dot"></span><span id="statusText">Ready</span></div>
      <div class="status" id="modelLabel">Agent</div>
    </div>
    <div class="chat" id="chat">
      <div class="welcome" id="welcome">
        <h1>Super Agent</h1>
        <p>Type a request. Tools, memory, and documents run through the same agent as Telegram.</p>
      </div>
    </div>
    <div class="composer">
      <div class="box">
        <textarea id="input" rows="1" placeholder="Message Super Agent…"></textarea>
        <button class="send" id="send">Send</button>
      </div>
    </div>
  </main>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || localStorage.getItem('webUiToken') || '';
if (token) localStorage.setItem('webUiToken', token);
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusText = document.getElementById('statusText');
const welcome = document.getElementById('welcome');

function autogrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autogrow);

function addMsg(role, text, extra) {
  if (welcome) welcome.remove();
  const row = document.createElement('div');
  row.className = 'msg ' + role;
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = role === 'user' ? 'You' : 'SA';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  if (extra) bubble.appendChild(extra);
  row.appendChild(av);
  row.appendChild(bubble);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

async function api(path, body) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-web-ui-token': token },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function confirmationUI(conf) {
  if (!conf || !conf.id) return null;
  const box = document.createElement('div');
  box.className = 'confirm';
  box.innerHTML = '<div style="margin-bottom:8px;color:var(--muted)">Needs confirmation</div>';
  const desc = document.createElement('div');
  desc.textContent = conf.description || conf.kind || 'Action';
  box.appendChild(desc);
  const yes = document.createElement('button');
  yes.className = 'yes';
  yes.textContent = 'Confirm';
  const no = document.createElement('button');
  no.className = 'no';
  no.textContent = 'Cancel';
  yes.onclick = async () => {
    yes.disabled = no.disabled = true;
    statusText.textContent = 'Working…';
    try {
      const data = await api('/api/confirm', { id: conf.id, confirm: true });
      addMsg('agent', data.reply || 'Done.');
    } catch (e) {
      addMsg('agent', '⚠️ ' + e.message);
    } finally {
      statusText.textContent = 'Ready';
    }
  };
  no.onclick = async () => {
    yes.disabled = no.disabled = true;
    try {
      const data = await api('/api/confirm', { id: conf.id, confirm: false });
      addMsg('agent', data.reply || 'Cancelled.');
    } catch (e) {
      addMsg('agent', '⚠️ ' + e.message);
    }
  };
  box.appendChild(yes);
  box.appendChild(no);
  return box;
}

async function send() {
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  autogrow();
  addMsg('user', message);
  sendBtn.disabled = true;
  statusText.textContent = 'Working…';
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.textContent = 'Thinking…';
  const bubble = addMsg('agent', '');
  bubble.appendChild(thinking);
  try {
    const data = await api('/api/chat', { message });
    bubble.textContent = data.reply || '';
    const conf = confirmationUI(data.confirmation);
    if (conf) bubble.appendChild(conf);
  } catch (e) {
    bubble.textContent = '⚠️ ' + e.message;
  } finally {
    sendBtn.disabled = false;
    statusText.textContent = 'Ready';
    chat.scrollTop = chat.scrollHeight;
  }
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById('newChat').onclick = () => location.reload();

(async () => {
  try {
    const h = await api('/api/health');
    if (h.model) document.getElementById('modelLabel').textContent = h.model;
  } catch (_) {}
})();
</script>
</body>
</html>`;

function auth(req){const expected=process.env.WEB_UI_TOKEN||process.env.VOICE_RELAY_SECRET||"";return !!expected&&String(req.headers["x-web-ui-token"]||"")===expected}
function json(res,status,data){if(res.headersSent)return;res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"});res.end(JSON.stringify(data))}
function body(req){return new Promise((ok,bad)=>{let s="";req.on("data",c=>{s+=c;if(s.length>1000000)req.destroy()});req.on("end",()=>{try{ok(JSON.parse(s||"{}"))}catch(e){bad(e)}});req.on("error",bad)})}
function view(p){return p?{id:p.id,description:p.description,kind:p.kind||"action"}:null}
async function handleWebRequest(req,res,d){const u=new URL(req.url,"http://night-agent");if(req.method==='GET'&&u.pathname==='/'){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(HTML);return true}if(req.method==='OPTIONS'&&u.pathname.startsWith('/api/')){res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,x-web-ui-token","Access-Control-Allow-Methods":"GET,POST,OPTIONS"});res.end();return true}if(!u.pathname.startsWith('/api/'))return false;if(!auth(req)){json(res,401,{error:'Unauthorized — set WEB_UI_TOKEN in Railway Variables.'});return true}try{if(u.pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,model:process.env.ANTHROPIC_TEXT_MODEL||'claude-opus-5'}),true;if(u.pathname==='/api/history'&&req.method==='GET')return json(res,200,{messages:await d.fetchRecentConversation(80)}),true;if(u.pathname==='/api/chat'&&req.method==='POST'){const x=await body(req),message=String(x.message||'').trim();if(!message)return json(res,400,{error:'message is required'}),true;await d.logBotMessage('user',message,'web');const reply=await d.handleChatMessage(message);await d.logBotMessage('agent',reply,'web');const p=d.pendingConfirmations[d.pendingConfirmations.length-1];return json(res,200,{reply,confirmation:view(p)}),true}if(u.pathname==='/api/confirm'&&req.method==='POST'){const x=await body(req),idx=d.pendingConfirmations.findIndex(p=>String(p.id)===String(x.id));if(idx<0)return json(res,404,{error:'Confirmation expired or not found'}),true;const p=d.pendingConfirmations.splice(idx,1)[0];if(!x.confirm){const r='❌ Cancelled: '+p.description;await d.logBotMessage('agent',r,'web');return json(res,200,{reply:r}),true}let result;if(p.kind==='credential')result=await d.applyDetectedCredentials(p.payload||{});else result=await d.runToolDirectly(p.toolName,p.args||{});let reply;if(typeof result==='string')reply=result;else if(result?.error)reply='⚠️ Failed: '+(result.message||result.error);else{const link=result?.url||result?.link;reply=link?'✅ Done.\n🔗 '+link:'✅ Done.'}await d.logBotMessage('agent',reply,'web');return json(res,200,{reply}),true}return json(res,404,{error:'Not found'}),true}catch(e){console.error('Web UI API error:',e);json(res,500,{error:e.message||'Internal server error'});return true}}
module.exports={handleWebRequest};
