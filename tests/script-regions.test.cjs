const {test}=require('node:test');
const assert=require('node:assert/strict');
test('script boxes scale from source resolution into the client area, including title bar offset',async()=>{
 const {scriptRegionBoxes:boxes}=await import('../src/scriptRegions.ts');
 const geometry={windowW:400,windowH:300,clientArea:{x:0,y:30/330,w:1,h:300/330}};
 const [b]=boxes([{x:80,y:60,w:160,h:120}],geometry,800,600);
 assert.equal(b.x*400,40);assert.ok(Math.abs(b.y*330-60)<1e-9);
 assert.equal(b.w*400,80);assert.ok(Math.abs(b.h*330-60)<1e-9);
 const [legacy]=boxes({x:80,y:60,w:160,h:120},geometry);
 assert.equal(legacy.x*400,80);assert.ok(Math.abs(legacy.y*330-90)<1e-9);
 assert.deepEqual(boxes({x1:160,y1:120,x2:80,y2:60},{windowW:800,windowH:600}),[{x:.1,y:.1,w:.1,h:.1}]);
 assert.equal(boxes({x:0,y:-16,w:64,h:78},{windowW:800,windowH:600})[0].y,-16/600);
 for(const empty of [[],{},null])assert.deepEqual(boxes(empty,geometry),[]);
 assert.throws(()=>boxes({x:NaN,y:0,w:1,h:1},geometry),/finite/);
 assert.throws(()=>boxes({x:0,y:0,w:1,h:-1},geometry),/non-negative/);
});
test('Region references preserve every dynamic box and distinguish unavailable from empty results',async()=>{
 const {luaRegionSnapshot}=await import('../src/scriptRegions.ts');
 const a={x:.1,y:.2,w:.3,h:.4},b={x:.5,y:.6,w:.1,h:.2};
 const definitions=[{...a,id:'manual',label:'UI'},{...a,id:'matched',label:'Matches',match:true},{...a,id:'scripted',label:'Lua',source:'script'}];
 const result=luaRegionSnapshot(definitions,{matched:{boxes:[a,b],timestamp:100},scripted:{boxes:[b,a],timestamp:200}});
 assert.deepEqual(result.map(r=>r.boxes),[[a],[a,b],[b,a]]);
 assert.equal(result[0].dynamic,false);assert.equal(result[1].timestamp,100);
 assert.equal(luaRegionSnapshot(definitions,{})[1].valid,false);
 const empty=luaRegionSnapshot(definitions,{matched:{boxes:[],timestamp:300}})[1];
 assert.equal(empty.valid,true);assert.deepEqual(empty.boxes,[]);
});
