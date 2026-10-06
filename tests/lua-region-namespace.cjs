const assert=require('node:assert/strict');
module.exports=async function checkRegionNamespace(invoke) {
  const geometry=await invoke('memory.run_script',{script:'return get_window_size()'});
  const area=geometry.clientArea;
  const box=(x,y,w,h)=>({x:area.x+x/800*area.w,y:area.y+y/600*area.h,w:w/800*area.w,h:h/600*area.h});
  const source=[{id:'ui',label:'Minimap',valid:true,dynamic:false,boxes:[box(10,20,30,40)]},
    {id:'multi',label:'Multiple',valid:true,dynamic:true,timestamp:geometry.timestamp,boxes:[box(1,2,3,4),box(5,6,7,8)]},
    {id:'lua',label:'Lua Boxes',valid:true,dynamic:true,timestamp:geometry.timestamp,boxes:[box(9,10,11,12),box(13,14,15,16)]}];
  const run=(script,regions=source,extra={})=>invoke('memory.run_script',{script,regions,scriptWidth:800,scriptHeight:600,...extra});
  const {value}=await run('local a=regions.Minimap; a[1].x=999; return {x=regions.Minimap[1].x, count=#regions.Multiple, last=regions["Lua Boxes"][2].h}');
  assert.ok(Math.abs(value.x-10)<1e-8);assert.equal(value.count,2);assert.ok(Math.abs(value.last-16)<1e-8);
  await assert.rejects(run('return regions.Missing'),/not found/);
  await assert.rejects(run('return regions.Minimap', [...source,{...source[0],id:'duplicate'}]),/ambiguous/);
  await assert.rejects(run('return regions.Minimap',source,{regionId:'ui'}),/own output/);
  await assert.rejects(run('return regions.Multiple',source.map(r=>({...r,timestamp:0}))),/older than/);
  await assert.rejects(run('return regions.Minimap', [{...source[0],valid:false}]),/unavailable/);
  await assert.rejects(run('regions.Minimap = {}'),/read-only/);
  assert.equal((await run('return 42',[{...source[0],valid:false}])).value,42,'Unused unavailable Regions must not fail scripts');
  assert.equal((await run('return #regions.Minimap',[{...source[0],boxes:[]}])).value,0);
  const cached='local boxes=regions.Minimap; regions={}; return boxes[1].x';
  assert.ok(Math.abs((await run(cached)).value-10)<1e-8);
  assert.ok(Math.abs((await run(cached,[{...source[0],boxes:[box(99,20,30,40)]}])).value-99)<1e-8,'Cached scripts must receive a fresh namespace and snapshot');
  const renamed=[{...source[0],label:'Mini Map'}];
  await assert.rejects(run('return regions.Minimap',renamed),/not found/);
  assert.equal((await run('return #regions["Mini Map"]',renamed)).value,1);
  assert.ok(Math.abs((await run('return regions.ui[1].x',[...source,{...source[0],id:'other',label:'ui',boxes:[box(77,1,1,1)]}])).value-77)<1e-8,'Name lookup must not prefer a conflicting ID');
  console.log('PASS: automatic regions namespace, names/spaces, multiple boxes, fresh snapshots, copies, read-only access, and lookup errors');
};
