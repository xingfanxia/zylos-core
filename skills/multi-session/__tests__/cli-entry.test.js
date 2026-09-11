import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { isCliEntry } from '../cli-entry.js';

const dirs=[];
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zylos-cli-entry-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});

test('CLI entry compares physical identity, including aliases, without running imports',()=>{
  const dir=fixture(),file=path.join(dir,'main.mjs'),alias=path.join(dir,'alias.mjs');
  fs.writeFileSync(file,'');fs.symlinkSync(file,alias);
  const url=pathToFileURL(file).href;
  assert.equal(isCliEntry(url,file),true);
  assert.equal(isCliEntry(url,alias),true);
  for(const other of ['', '-',path.join(dir,'missing'),import.meta.filename])assert.equal(isCliEntry(url,other),false);
});

test('the actual startup orchestrator executes through a farm-directory alias',()=>{
  const dir=fixture(),alias=path.join(dir,'alias');
  const scripts=path.resolve(import.meta.dirname,'../../activity-monitor/scripts');
  fs.symlinkSync(scripts,alias);
  const result=spawnSync(process.execPath,[path.join(alias,'session-start-orchestrator.js'),'--shard','ax268-unknown'],{
    env:{...process.env,HOME:dir,ZYLOS_DIR:dir,ZYLOS_INSTANCE_ID:''},
    input:JSON.stringify({hook_event_name:'SessionStart',session_id:'ax268-cli-entry',source:'startup'}),
    encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/unknown shard "ax268-unknown"/);
  assert.equal(result.stdout,'');
});

test('importing the actual orchestrator from stdin does not execute a CLI or reject dash argv',()=>{
  const dir=fixture();
  const url=pathToFileURL(path.resolve(import.meta.dirname,'../../activity-monitor/scripts/session-start-orchestrator.js')).href;
  const result=spawnSync(process.execPath,['--input-type=module','-'],{
    env:{...process.env,HOME:dir,ZYLOS_DIR:dir,ZYLOS_INSTANCE_ID:''},
    input:`await import(${JSON.stringify(url)}); console.log('IMPORT_ONLY');`,encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'IMPORT_ONLY');
});
