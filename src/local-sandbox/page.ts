export const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luma · Local sandbox</title>
<style>
:root{font-family:system-ui,sans-serif;color:#0B1020;background:#EEF2F8;line-height:1.5}*{box-sizing:border-box}body{margin:0}header,main{max-width:1180px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;padding-bottom:8px}h1{margin:0;font-size:30px;letter-spacing:-1px}h2{font-size:19px;margin-top:0}h3{font-size:16px}.badge{border-radius:24px;padding:7px 14px;background:#e0e9ff;color:#214dbb;font-size:13px}.intro{margin:0 0 20px;color:#46526b}.grid{display:grid;grid-template-columns:1fr 1.25fr;gap:20px}.card{background:white;border:1px solid #dde3ef;border-radius:16px;padding:22px;margin-bottom:20px}label{display:block;font-size:14px;font-weight:600;margin:12px 0 6px}select,input,button{font:inherit;max-width:100%}select,input{width:100%;padding:10px;border:1px solid #bdc7d9;border-radius:8px;background:#fff;color:inherit}button{padding:9px 14px;border:1px solid #c8d1e1;border-radius:8px;background:#fff;cursor:pointer;margin:8px 6px 0 0;color:inherit}button.primary{background:#2563FF;border-color:#2563FF;color:white}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #aabfff;outline-offset:2px}.muted,small{color:#65708A}small{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f4f6fa;padding:12px;border-radius:8px;max-height:450px;overflow:auto}blockquote{margin:12px 0;border-left:3px solid #5B4DFF;padding:3px 12px}#status{min-height:30px;padding:0 0 12px;font-weight:600}.item{border-top:1px solid #e3e7ef;padding:12px 0}.item p{margin:4px 0}.tag{font-size:12px;color:#53617c}details{margin-top:10px}summary{cursor:pointer;font-weight:600}.answer{white-space:pre-wrap}.pass{color:#176443}.fail{color:#a52b33}.checks{margin-top:20px}.checks details{padding:12px 0;border-top:1px solid #e3e7ef}.check{padding:10px 0;border-bottom:1px solid #eee}#report-heading{margin-bottom:6px}ol{padding-left:20px}@media(max-width:780px){.grid{grid-template-columns:1fr}header,main{padding:16px}header{align-items:flex-start;gap:10px}.badge{max-width:180px}h1{font-size:26px}}
</style></head><body>
<header><h1>Luma <span class="muted">/ Local sandbox</span></h1><span class="badge">Offline · $0 AI usage</span></header>
<main><p class="intro">Try Luma's meeting engine before deploying. AI proposals and external sources are simulated; the stored state, corrections, queries and checks run through real Luma code.</p>
<div id="status" role="status" aria-live="polite">Starting…</div>
<div class="grid"><section>
<div class="card"><h2>1. Choose a sample meeting</h2><label for="scenario">Scenario</label><select id="scenario"></select><button id="load" class="primary">Load fresh sample</button>
<p class="muted">Start with “Jakob owns Luma” and run its steps: a scripted human confirmation is followed by a conflicting AI proposal. The human-confirmed owner should survive.</p>
<div id="evidence"></div><small id="reference"></small>
<details><summary>Scenario steps</summary><ol id="steps"></ol></details>
<button id="next">Run next step</button><button id="replay">Replay last event</button><small>Replay should report duplicates without duplicating work. Loading a fresh sample starts another isolated meeting.</small></div>
<div class="card"><h2>2. Make a human correction</h2><small>Acts as Jakob in this synthetic meeting. Confirming an item here cannot create external work.</small>
<label for="item">Action or decision</label><select id="item"></select>
<button id="confirm">Confirm</button><button id="reject">Reject</button><button id="supersede">Mark superseded</button>
<label for="owner">Action owner</label><select id="owner"><option value="person_jakob">Jakob</option><option value="person_fabius">Fabius</option><option value="person_philipp">Philipp</option><option value="person_julius">Julius</option></select><button id="change-owner">Change owner</button></div>
<div class="card"><h2>What this test proves</h2><p>Human judgment, retained evidence, scoped answers and event replay use Luma's real engine and an isolated in-memory database.</p><p>It does not test real AI understanding, Discord delivery, live source permissions, paid usage accounting, external writes, or recovery after a process restart. No credentials or hosting are needed.</p><p class="muted">Sample proposals are prerecorded synthetic data. This is not an open-ended AI chat. Stop the terminal with Ctrl+C to clear all sandbox meetings.</p></div>
</section><section>
<div class="card"><h2>3. Ask about this meeting</h2><label for="question">Question</label><input id="question" maxlength="2000" value="What did we decide?">
<button id="ask" class="primary">Ask Luma</button><button id="personal">My action items</button><button id="history">Decision history</button><button id="conclude">Conclude meeting</button>
<p class="muted">Questions use Luma's bounded meeting-query interpreter. Unsupported questions should explain the limitation.</p><div id="answer" class="answer"></div>
<details><summary>Last operation receipt</summary><pre id="result">No operation yet.</pre></details></div>
<div class="card"><h2>Current meeting state</h2><div id="items" aria-live="polite">Load a sample to begin.</div><details><summary>Full state and evidence</summary><pre id="state">No meeting loaded.</pre></details></div>
</section></div>
<section class="card"><h2>4. Run the broader offline checks</h2><p>Test the versioned corpus, including current versus historical knowledge, revoked access, source outages, imported meeting recall and provider parsing. Inspect the observed results beside each expectation.</p><button id="checks" class="primary">Run offline checks</button><button id="download" disabled>Download report</button><small>Runs on this Mac with synthetic model and provider responses. Checks are deterministic regressions, not a live AI quality score.</small><div id="report" class="checks"></div></section>
</main><script>
const el = id => document.getElementById(id);
let current = null, report = null, busy = false;
const names = {'jakob-owns-luma-human-judgment':'Jakob owns Luma · human correction','retained-current-and-historical-decisions':'Current versus historical decisions','uncertain-proposal':'A tentative proposal','german-relative-deadline':'German relative deadline','mixed-github-issue':'Mixed German / English action','english-code-identifier':'Uncertain code diagnosis','bounded-scoped-answer-with-omissions':'Long answer and visible omissions'};
const pretty = value => JSON.stringify(value, null, 2);
const node = (tag, text, className) => {const n = document.createElement(tag); n.textContent = text; if(className) n.className = className; return n;};
function lock(value) {busy = value; document.querySelectorAll('button').forEach(b => b.disabled = value); if(!value) {el('download').disabled = !report; el('next').disabled = !current?.scenario || current.position >= current.scenarios.find(s => s.id === current.scenario).steps.length;}}
async function api(path, body = {}) { const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data = await response.json(); if(!response.ok) throw new Error(data.error || 'Request failed'); return data; }
async function run(work, message) {if(busy) return; lock(true); el('status').textContent = message; try {await work(); el('status').textContent = 'Ready · no paid requests or external writes';} catch(error) {el('status').textContent = error.message;} finally {lock(false);}}
function render(data) {
 current=data;
 const scenario=data.scenarios.find(s=>s.id===data.scenario);
 if(!el('scenario').options.length) {data.scenarios.forEach(s=> {const o=node('option',names[s.id]||s.id);o.value=s.id;el('scenario').append(o)});el('scenario').value='jakob-owns-luma-human-judgment';}
 el('evidence').replaceChildren();el('steps').replaceChildren();
 if(scenario) {
   el('scenario').value=scenario.id;
   const observed=new Set(scenario.steps.slice(0,data.position).flatMap(s=>s.type==='observe'?s.utterances:[]));
   scenario.utterances.forEach((u,i)=>{if(observed.has(i)){const q=node('blockquote',u.text);q.prepend(node('small',u.speakerId.replace('person_','')));el('evidence').append(q)}});
   scenario.steps.forEach((s,i)=>el('steps').append(node('li',(i<data.position?'Done: ':i===data.position?'Next: ':'')+s.type+' · '+s.id)));
 }
 el('reference').textContent='Fixture reference: '+data.referenceAt+' · '+data.timezone+' (not today)';
 el('state').textContent=pretty(data.state);el('result').textContent=pretty(data.result);
 el('answer').textContent=data.result?.answer?.text || (data.result?.errors?.length ? 'The core reported an error. Inspect the receipt below.' : 'Inspect the current state or ask a question.');
 el('items').replaceChildren(); const oldItem=el('item').value;el('item').replaceChildren();
 const items=[...(data.state?.actionItems||[]),...(data.state?.decisions||[])];
 if(!items.length)el('items').append(node('p','No actions or decisions yet.'));
 items.forEach(item=>{const title=item.description||item.statement; const card=node('div','','item');card.append(node('p',title),node('div',item.status+(item.ownerId?' · '+item.ownerId.replace('person_',''):''),'tag')); const evidence=item.provenance?.evidence||[];evidence.forEach(e=>{if(e.excerpt)card.append(node('small','Evidence: '+e.excerpt))});el('items').append(card);const o=node('option',title);o.value=item.id;el('item').append(o)});
 if(items.some(i=>i.id===oldItem))el('item').value=oldItem;
}
function command(body){return run(async()=>render(await api('/api/command',body)),'Running Luma locally…');}
el('load').onclick=()=>command({type:'load',scenario:el('scenario').value});
el('next').onclick=()=>command({type:'next'});el('replay').onclick=()=>command({type:'replay'});el('conclude').onclick=()=>command({type:'conclude'});
el('ask').onclick=()=>command({type:'ask',text:el('question').value});
el('question').onkeydown=e=>{if(e.key==='Enter')el('ask').click()};
el('personal').onclick=()=>{el('question').value='What are my action items?';el('ask').click()};
el('history').onclick=()=>{el('question').value='Show decision history about Luma';el('ask').click()};
['confirm','reject','supersede'].forEach(action=>el(action).onclick=()=>command({type:'judge',itemId:el('item').value,action}));
el('change-owner').onclick=()=>command({type:'judge',itemId:el('item').value,action:'owner',owner:el('owner').value});
el('checks').onclick=()=>run(async()=>{report=await api('/api/checks');const target=el('report');target.replaceChildren();const s=report.summary;target.append(node('h3',s.passed+' passed · '+s.failed+' failed · '+s.missing+' missing',s.failed||s.missing?'fail':'pass'));target.append(node('p','Live AI quality remains unmeasured. Corpus '+report.corpusVersion+' · '+report.mode));report.fixtures.forEach(f=>{const d=document.createElement('details');const failed=f.checks.filter(c=>c.status!=='passed').length;d.append(node('summary',f.id+' · '+(failed?failed+' problems':'passed')));f.checks.forEach(c=>{const row=node('div','','check');row.append(node('strong',c.status.toUpperCase()+' · '+c.id,c.status==='passed'?'pass':'fail'),node('pre','Expected: '+pretty(c.expected)+'\nObserved: '+pretty(c.actual)+(c.note?'\n'+c.note:'')));d.append(row)});const raw=document.createElement('details');raw.append(node('summary','Full observed outputs'),node('pre',pretty(f.outputs)));d.append(raw);target.append(d)})},'Running offline corpus… this may take a minute.');
el('download').onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([pretty(report)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='luma-offline-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
run(async()=>render(await api('/api/state')),'Loading local sandbox…');
</script></body></html>`;
