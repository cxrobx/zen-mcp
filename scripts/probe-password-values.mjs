#!/usr/bin/env node
// Tests the actual injected bundles in a disposable browser, never a logged-in profile.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const temp = mkdtempSync(join(tmpdir(), 'zen-password-'));
const bundle = name => readFileSync(resolve('extension/dist', name, 'inject.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const fixture = `<!doctype html><body><h1>Password regression</h1>
<label>Password<input id="password" type="password" value="fixture-password-8294"></label>
<label>Revealed<input id="revealed" type="password" value="fixture-revealed-7382"></label>
<label>Notes<textarea>fixture-notes-6281</textarea></label>
<script>document.querySelector('#revealed').type='text';</script>
<script>${bundle('snapshot')}</script><script>${bundle('evaluate')}</script><script>${bundle('readability')}</script>
<script>
const failures=[];
const check=(name,fn)=>{try { if(!fn()) failures.push(name); }catch(e){failures.push(name+': '+e.name);}};
const secrets=['fixture-password-8294','fixture-revealed-7382','fixture-notes-6281'];
const safe=value=>secrets.every(secret=>!JSON.stringify(value).includes(secret));
check('snapshot default',()=>safe(window.__zenExtMcpCreateSnapshot(1)));
check('snapshot includeAll',()=>safe(window.__zenExtMcpCreateSnapshot(2,{includeAll:true})));
check('eval nested values',()=>safe(window.__zenExtMcpEvaluate('return {nested:[document.querySelector("#password").value,document.querySelector("#revealed").value]}')));
check('eval error',()=>{try {window.__zenExtMcpEvaluate('throw new Error(document.querySelector("#password").value)');return false;}catch(e){return safe(e.message);}});
check('readability',()=>safe(window.__zenReadability()));
check('DOM preserved',()=>document.querySelector('#password').value===secrets[0]);
const out=document.createElement('pre');out.id='probe-result';out.textContent=failures.length?JSON.stringify(failures):'PASS';document.body.append(out);
</script>`;
try {
  const path=join(temp,'fixture.html');writeFileSync(path,fixture);
  const result=spawnSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless','--no-first-run',`--user-data-dir=${join(temp,'profile')}`,'--dump-dom',`file://${path}`],{encoding:'utf8',timeout:30000,maxBuffer:20*1024*1024});
  const verdict=result.stdout?.match(/<pre id="probe-result">([^<]*)<\/pre>/)?.[1];
  console.log(verdict ?? 'FAIL: no browser result');
  if (!verdict) console.error(result.error?.message ?? result.stderr.slice(-1500));
  process.exitCode=verdict==='PASS'?0:1;
} finally {rmSync(temp,{recursive:true,force:true});}
