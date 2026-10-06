const assert=require('node:assert/strict');
module.exports=async function checkStateNamespace(invoke) {
  const geometry=await invoke('memory.run_script',{script:'return get_window_size()'});
  const area=geometry.clientArea;
  const regions=[{id:'ui',label:'Minimap',valid:true,dynamic:false,boxes:[{x:area.x,y:area.y,w:area.w/10,h:area.h/10}]}];
  const lua=(id,name,script)=>({id,name,kind:'script',script});
  const states=[
    lua('cam','Camera','return {x=-540, y=-527}'),
    lua('count','Counter','StateRuns = (StateRuns or 0) + 1; return StateRuns'),
    lua('boxes','Boxes','return {{x=1,y=2,w=3,h=4},{x=5,y=6,w=7,h=8}}'),
    lua('none','Nothing','return nil'),
    lua('spaced','Camera Copy','local c = states.Camera; return {x=c.x, y=c.y}'),
    lua('a','A','return states.B'), lua('b','B','return states.A'),
    lua('self','Self','return states.Self'),
    lua('map','Map','return regions.Minimap'),
    {id:'mem',name:'Bad memory',kind:'memory',address:'0x10',offsets:[],byteType:'u32'},
  ];
  const run=(script,extra={})=>invoke('memory.run_script',{script,states,regions,...extra});
  assert.deepEqual((await run('local c = states.Camera; return {x = 351 - c.x, y = -122 - c.y}')).value,{x:891,y:405});
  assert.deepEqual((await run('return states["Camera Copy"]')).value,{x:-540,y:-527},'States read States, by names with spaces');
  const twice=(await run('return {states.Counter, states.Counter}')).value;
  assert.equal(twice[0],twice[1],'A State is read once per evaluation');
  assert.equal((await run('return states.Counter')).value,twice[0]+1,'and again in the next');
  assert.equal((await run('return #states.Boxes + states.Boxes[2].w')).value,9);
  assert.equal((await run('return states.Nothing == nil')).value,true);
  await assert.rejects(run('local a = states.A; return a'),/loop: A → B → A/);
  await assert.rejects(run('return states.Self'),/loop/);
  await assert.rejects(run('return states.Camera',{stateId:'cam'}),/cannot read itself/);
  await assert.rejects(run('return states["Bad memory"]'),/State "Bad memory"/);
  await assert.rejects(run('return states.Missing'),/State not found: Missing/);
  await assert.rejects(run('return states.Camera',{states:[...states,lua('dupe','Camera','return 1')]}),/ambiguous/);
  await assert.rejects(run('states.Camera = 1'),/read-only/);
  assert.equal((await run('return 7',{states:[lua('x','Broken','return read_u32(16)')]})).value,7,'An unread failing State must not fail scripts');
  assert.deepEqual((await run('return #states.Map')).regionsRead,['ui'],'Regions a State reads count as read');
  await assert.rejects(run('return states.Map',{regionId:'ui'}),/own output/);
  // A State turned off in the app isn't run when read: the script reading it is told it's off
  const ran=(await run('return states.Counter')).value;
  await assert.rejects(run('return states.Counter',{states:states.map(d=>d.id==='count'?{...d,off:true}:d)}),/State "Counter" is turned off/);
  assert.equal((await run('return states.Counter')).value,ran+1,'A State turned off was run anyway');
  // A hidden Lua Region's script doesn't run, and a script reading it is told so
  await assert.rejects(run('return regions.Hidden',{regions:[...regions,{id:'h',label:'Hidden',valid:false,dynamic:true,off:true,boxes:[]}]}),/Region "Hidden" is hidden/);
  // The States stay for recorded Lua States (probes), as the Regions do
  assert.equal((await invoke('memory.run_script',{script:'return states.Offset + 1',states:[lua('o','Offset','return 41')]})).value,42);
  assert.equal((await invoke('memory.run_script',{script:'return states.Offset + 1'})).value,42,'A request without States keeps the last ones');
  console.log('PASS: states namespace: Lua and memory States by name, read once per evaluation, nested, loops, self, errors, read-only, Region dependencies, States turned off, hidden Regions');
};
