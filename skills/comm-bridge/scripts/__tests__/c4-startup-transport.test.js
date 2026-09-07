import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-shard-transport-'));
const personaTmp = path.join(serviceRoot, 'persona-private');
fs.mkdirSync(personaTmp, { mode: 0o700 });
const stateDir = path.join(personaTmp, 'state');
fs.mkdirSync(stateDir);
fs.mkdirSync(path.join(serviceRoot, 'activity-monitor'));
process.env.ZYLOS_DIR = serviceRoot;
process.env.C4_BROKER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.writeFileSync(path.join(serviceRoot, 'instances.json'), JSON.stringify({ instances: {
  group: { type: 'group', os_user: os.userInfo().username, state_dir: stateDir },
  peer: { type: 'dedicated', state_dir: path.join(serviceRoot, 'peer-state') },
} }));

const broker = await import('../c4-broker.js');
const db = await import('../c4-db.js');
const { DEFAULT_SHARD_BUDGET, withinBudget } = await import('../../../activity-monitor/scripts/shard-registry.js');
const summary = 'GROUP_CHECKPOINT_BEGIN\n' + 'checkpoint context '.repeat(1200) + '\nGROUP_CHECKPOINT_END';
await broker.handleRequest({ op: 'checkpoint', params: { endId: 0, summary } }, 'group');
await broker.handleRequest({ op: 'checkpoint', params: { endId: 0, summary: 'PEER_PRIVATE_CHECKPOINT' } }, 'peer');
const markers = [];
for (let chat = 0; chat < 4; chat++) {
  for (let item = 0; item < 6; item++) {
    const marker = `GROUP_${chat}_MESSAGE_${item}`;
    markers.push(marker);
    db.insertConversation('in', 'feishu', `oc_${chat}|type:group|msg:${item}`,
      `${marker} ${'message body '.repeat(55)}`, 'delivered', 3, false, null, 'group');
  }
}
db.insertConversation('in', 'feishu', 'oc_peer|type:group', 'PEER_PRIVATE_MESSAGE', 'delivered', 3, false, null, 'peer');

after(() => {
  broker.removeSocket('group');
  db.close();
  fs.rmSync(serviceRoot, { recursive: true, force: true });
});

test('full group/checkpoint data cross bounded transport and spill under the persona render budget', async () => {
  const expected = {};
  for (const section of ['checkpoint', 'conversations']) {
    const result = await broker.handleRequest({ op: 'session-init', params: {
      section, budget: { maxChars: 100000000, maxTokens: 100000000 }, instanceId: 'peer',
    } }, 'group');
    assert.equal(result.ok, true, result.error);
    expected[section] = result.data.context;
    assert.ok(!withinBudget(result.data.context, DEFAULT_SHARD_BUDGET));
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 1000000);
    assert.ok(!result.data.context.includes('PEER_PRIVATE'));
  }
  assert.ok(expected.checkpoint.includes(summary));
  for (const marker of markers) assert.ok(expected.conversations.includes(marker), `${marker} must survive transport`);
  for (let chat = 0; chat < 4; chat++) assert.ok(expected.conversations.includes(`=== GROUP oc_${chat} ===`));

  broker.ensureSocket('group');
  const emitter = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
  const orchestrator = fileURLToPath(new URL('../../../activity-monitor/scripts/session-start-orchestrator.js', import.meta.url));
  const registry = fileURLToPath(new URL('../../../activity-monitor/scripts/shard-registry.js', import.meta.url));
  const script = `
    import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
    const {emitC4Checkpoint,emitC4Conversations}=await import(${JSON.stringify(emitter)});
    const {runSessionStartShard,shardSpillPath}=await import(${JSON.stringify(orchestrator)});
    const {DEFAULT_SHARD_BUDGET,withinBudget}=await import(${JSON.stringify(registry)});
    const chain=[
      {name:'c4-checkpoint',chainIndex:0,budget:DEFAULT_SHARD_BUDGET,emit:()=>emitC4Checkpoint(null,{instanceId:'peer'})},
      {name:'c4-conversations',chainIndex:1,budget:DEFAULT_SHARD_BUDGET,emit:()=>emitC4Conversations(null,DEFAULT_SHARD_BUDGET,{instanceId:'peer'})}
    ];
    const results=[];const tmpdir=${JSON.stringify(personaTmp)},session='transport-persona-session';
    for(const shard of chain){
      const inline=path.join(tmpdir,shard.name+'.inline');const fd=fs.openSync(inline,'w');
      try{await runSessionStartShard(shard.name,{session_id:session,source:'startup'},{tmpdir,stdout:{fd},
        resolveShardImpl:()=>({kind:'content',shard,chain,warnings:[]})});}finally{fs.closeSync(fd);}
      const spill=shardSpillPath(session,shard.name,{tmpdir});
      fs.accessSync(spill,fs.constants.R_OK);const full=fs.readFileSync(spill,'utf8');
      const rendered=fs.readFileSync(inline,'utf8');
      results.push({name:shard.name,spill,uid:fs.statSync(spill).uid,callerUid:process.getuid(),
        inlineFits:withinBudget(rendered,DEFAULT_SHARD_BUDGET),hasSpillPointer:rendered.includes(spill),
        fullHash:createHash('sha256').update(full).digest('hex'),chars:full.length,peerLeak:full.includes('PEER_PRIVATE')});
    }
    console.log(JSON.stringify(results));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZYLOS_DIR: serviceRoot, ZYLOS_INSTANCE_ID: 'group', TMPDIR: personaTmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  const results = JSON.parse(stdout);
  assert.equal(results.length, 2);
  for (const row of results) {
    const section = row.name === 'c4-checkpoint' ? 'checkpoint' : 'conversations';
    assert.equal(row.inlineFits, true);
    assert.equal(row.hasSpillPointer, true);
    assert.equal(row.uid, row.callerUid);
    assert.ok(row.spill.startsWith(personaTmp + path.sep));
    assert.equal(row.fullHash, createHash('sha256').update(expected[section].trim()).digest('hex'));
    assert.equal(row.peerLeak, false);
  }

  // The pre-existing combined endpoint remains backward compatible even for
  // contexts larger than the new section-only transport ceiling.
  const legacySummary = 'LEGACY_LARGE_BEGIN' + '大'.repeat(400000) + 'LEGACY_LARGE_END';
  await broker.handleRequest({ op: 'checkpoint', params: { endId: 0, summary: legacySummary } }, 'group');
  const clientPath = fileURLToPath(new URL('../c4-client.js', import.meta.url));
  const compatibility = spawn(process.execPath, ['--input-type=module', '-e', `
    const {brokerCall}=await import(${JSON.stringify(clientPath)});
    const legacy=await brokerCall('session-init');let sectionError=null;
    try{await brokerCall('session-init',{section:'checkpoint'});}catch(error){sectionError=error.message;}
    console.log(JSON.stringify({legacyBytes:Buffer.byteLength(legacy.context,'utf8'),
      legacyFull:legacy.context.includes(${JSON.stringify('LEGACY_LARGE_BEGIN')})&&legacy.context.includes('LEGACY_LARGE_END'),sectionError}));
  `], {
    env: { ...process.env, ZYLOS_DIR: serviceRoot, ZYLOS_INSTANCE_ID: 'group', TMPDIR: personaTmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let compatibilityOut = '', compatibilityErr = '';
  compatibility.stdout.on('data', (chunk) => { compatibilityOut += chunk; });
  compatibility.stderr.on('data', (chunk) => { compatibilityErr += chunk; });
  assert.equal(await new Promise((resolve) => compatibility.on('close', resolve)), 0, compatibilityErr);
  const compatibilityResult = JSON.parse(compatibilityOut);
  assert.ok(compatibilityResult.legacyBytes > 1000000);
  assert.equal(compatibilityResult.legacyFull, true);
  assert.match(compatibilityResult.sectionError, /session_init_transport_limit/);
});
