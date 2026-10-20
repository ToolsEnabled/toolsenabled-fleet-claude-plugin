'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const policy = require('./runtime/engine/src/lib/claude-plugin-policy.json');
const { serveSession } = require('./session-bridge');

test('Claude retains reviewed workers and coordination, with no unreviewed engine tools', () => {
  const { hostAllowlist } = require('./runtime/engine/src/lib/host-surface');
  const full = hostAllowlist({ workers: true });
  assert.equal(full.length, 44);
  for (const name of ['agent.spawn', 'agent.wait', 'agent.resume', 'host.read_file', 'memory.set', 'task.submit'])
    assert.ok(full.includes(name), name);
  assert.ok(full.every(name => policy.allowedTools.includes(name)));
  assert.ok(!hostAllowlist({ workers: false }).includes('agent.spawn'));
  for (const name of ['host.exec', 'agent.set_account', 'settings.set', 'r_ledger.file', 'browser.transfer_firefox_profile'])
    assert.ok(!full.includes(name), name);
});

test('bridge lists and forwards reviewed tools, refusing hidden calls before the engine', { timeout: 5000 }, async () => {
  const input = new PassThrough(), output = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.kill = () => child.emit('close', 0, null);
  const received = [], replies = [];
  child.stdin.on('data', line => {
    const request = JSON.parse(line);
    received.push(request);
    const result = request.method === 'tools/list' ? { tools: [
      {name: 'task.list'}, {name: 'agent.spawn'}, {name: 'future.history.extract'}
    ] } : { content: [{ type: 'text', text: 'fixture response' }] };
    child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  });
  output.on('data', line => replies.push(JSON.parse(line)));
  const serving = serveSession({stateRoot:'/nonexistent-fleet-policy-fixture',engine:path.join(__dirname,'runtime/engine')},
    {input,output,launch:()=>child,readSetup:()=>null,readTrees:()=>[],projectTrees:()=>[]});
  try {
    for (const request of [
      {id:1,method:'tools/list'},
      {id:2,method:'tools/call',params:{name:'task.list',arguments:{}}},
      {id:3,method:'tools/call',params:{name:'agent.spawn',arguments:{}}},
      ...['future.history.extract','host.exec','agent.set_account','settings.set','r_ledger.file'].map((name,i)=>(
        {id:i+4,method:'tools/call',params:{name,arguments:{}}}))
    ]) input.write(JSON.stringify({jsonrpc:'2.0',...request})+'\n');
    assert.deepEqual(replies.find(r=>r.id===1).result.tools.map(t=>t.name),
      ['task.list','agent.spawn','fleet_session_status','fleet_setup','fleet_settings']);
    assert.deepEqual(received.map(r=>r.id),[1,2,3]);
    for (let id=4;id<=8;id++) assert.equal(replies.find(r=>r.id===id).error.code,-32601);
  } finally { child.emit('close',0,null); await serving; }
});

test('engine upgrades cannot widen inherited worker tools before distribution review', () => {
  const source = require.resolve('./runtime/engine/src/lib/openshell-surface');
  const host = require.resolve('./runtime/engine/src/lib/host-surface');
  const original = require(source);
  try {
    require.cache[source].exports = {...original, OPENSHELL_TOOLS:[...original.OPENSHELL_TOOLS,'future.history.extract'],
      OPENSHELL_AGENT_TOOLS:[...original.OPENSHELL_AGENT_TOOLS,'future.credentials.read']};
    delete require.cache[host];
    const names = require(host).hostAllowlist({workers:true});
    assert.ok(!names.some(name=>name.startsWith('future.')));
    assert.ok(names.includes('agent.spawn'));
  } finally { require.cache[source].exports=original; delete require.cache[host]; }
});

test('setup declares replacement and provider-contact side effects', () => {
  const {setupTool}=require('./setup-server');
  assert.equal(setupTool.annotations.destructiveHint,true);
  assert.equal(setupTool.annotations.openWorldHint,true);
  assert.match(setupTool.description,/Replaces the saved project binding/);
});
