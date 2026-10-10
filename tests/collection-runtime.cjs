// Real Windows capture -> observations -> collection worker -> PNG/metadata, without preview polling.
const {app,BrowserWindow,nativeImage}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {createCollection}=require('../electron/collection.cjs');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const output=path.join(root,'build','collection-integration-'+Date.now());
app.setPath('userData',path.join(output,'profile'));
let lab,runtime,python,collector,packet=Buffer.alloc(0),text='',next=1;
const nativeCalls=new Map(),pythonCalls=new Map(),originals=new Map();
function invoke(op,args={}){return new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{nativeCalls.delete(id);reject(Error(`Runtime timed out: ${op} ${args.script??''}`));},10000);nativeCalls.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});runtime.stdin.write(JSON.stringify({v:1,id,op,...args})+'\n');});}
function worker(op,args={}){return new Promise((resolve,reject)=>{const id=next++;pythonCalls.set(id,{resolve,reject});python.stdin.write(JSON.stringify({id,op,...args})+'\n');});}
const watchdog=setTimeout(()=>{console.error('Collection integration timed out');runtime?.kill();python?.kill();app.exit(1);},30000);
app.whenReady().then(async()=>{
 try {
  lab=new BrowserWindow({width:340,height:260,show:false,title:'FireFly Capture Lab',webPreferences:{backgroundThrottling:false}});
  lab.setMenu(null); // Match a game client: no Electron menu inside its client area.
  await lab.loadURL('data:text/html,'+encodeURIComponent('<title>FireFly Capture Lab</title><canvas width="320" height="220"></canvas><script>let n=0,c=document.querySelector("canvas").getContext("2d");function tick(){c.fillStyle=`rgb(${n++%255},70,130)`;c.fillRect(0,0,320,220);requestAnimationFrame(tick)}tick()</script>'));
  lab.showInactive();
  runtime=spawn(path.join(root,'build/native/Release/firefly-runtime.exe'),[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  python=spawn(path.join(root,'.venv/Scripts/python.exe'),['-u',path.join(root,'worker/collection.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  runtime.stderr.on('data',d=>console.error(String(d)));python.stderr.on('data',d=>console.error(String(d)));
  runtime.on('exit',code=>{for(const p of nativeCalls.values())p.reject(Error(`Runtime exited: ${code}`));nativeCalls.clear();});
  python.stdout.on('data',d=>{text+=d;let end;while((end=text.indexOf('\n'))>=0){const m=JSON.parse(text.slice(0,end));text=text.slice(end+1);const p=pythonCalls.get(m.id);pythonCalls.delete(m.id);m.ok?p?.resolve(m.result):p?.reject(Error(m.error));}});
  runtime.stdout.on('data',d=>{
   packet=Buffer.concat([packet,d]);
   while(packet.length>=5){const len=packet.readUInt32LE(0);if(packet.length<len+4)return;const kind=packet[4],payload=packet.subarray(5,len+4);packet=packet.subarray(len+4);
    if(kind===1){const m=JSON.parse(payload);if(m.event){if(m.event==='observations')collector?.onObservations(m.result);continue;}const p=nativeCalls.get(m.id);nativeCalls.delete(m.id);m.ok?p?.resolve(m):p?.reject(Error(m.error.message));}
    else {const id=payload.readUInt32LE(0),timestamp=payload.readDoubleLE(12),pixels=payload.subarray(20);const frame={timestamp,width:payload.readUInt32LE(4),height:payload.readUInt32LE(8),pixels:pixels.toString('base64')};originals.set(timestamp,Buffer.from(pixels));nativeCalls.get(id)?.resolve(frame);nativeCalls.delete(id);}
   }
  });
  collector=createCollection({runtime:invoke,worker:async(op,args)=>{if(op==='evaluate')await wait(100);return worker(op,args);},send:()=>{}});
  await invoke('graph.apply',{graph:{version:1,id:'collection-test',revision:1,nodes:[{id:'v',op:'number',inputs:[],params:{value:3}},{id:'out',op:'publish',inputs:['v'],params:{name:'count'}}]}});
  const windowId=lab.getNativeWindowHandle().readBigUInt64LE().toString();
  const fields=await invoke('observe.tracked',{observations:[
    {name:'Monsters',value:'script',type:'collection',script:'return {{x=10,y=20,w=30,h=40}}'},
    {name:'Empty',value:'script',type:'collection',script:'return {}'},
    {name:'Bad',value:'script',type:'collection',script:'return 42'},
    {name:'Lookup',value:'script',type:'collection',script:'return regions["Renamed minimap"]',scriptWidth:800,scriptHeight:600},
    {name:'From state',value:'script',type:'number',script:'return states.Offset + 1'},
  ]});
  for(const name of ['Monsters','Empty','Bad'])assert.equal(fields.fields.find(f=>f.name===name)?.type,'shapes','Lua collections must be exposed as formula-compatible lists');
  await invoke('start',{windowId});
  await require('./lua-runtime-recovery.cjs')(invoke);
  await require('./monster-script.cjs')(invoke);
  await require('./npc-portal-scripts.cjs')(invoke);
  await require('./lua-region-namespace.cjs')(invoke);
  await require('./lua-memory.cjs')(invoke);
  await require('./lua-state-namespace.cjs')(invoke);
  const g=await invoke('memory.run_script',{script:'return get_window_size()'}),area=g.clientArea;
  const box=(x,y,w,h)=>({x:area.x+x/800*area.w,y:area.y+y/600*area.h,w:w/800*area.w,h:h/600*area.h});
  const references=[{id:'ui',label:'Minimap',valid:true,dynamic:false,boxes:[box(600,0,200,150)]},
    {id:'multiple',label:'Multi matches',valid:true,dynamic:true,timestamp:g.timestamp,boxes:[box(10,20,30,40),box(50,60,70,80)]},
    {id:'lua-array',label:'Lua boxes',valid:true,dynamic:true,timestamp:g.timestamp,boxes:[box(1,2,3,4),box(5,6,7,8)]}];
  const lookup=await invoke('memory.run_script',{script:'local a=get_region_boxes("ui"); a[1].x=999; return {manual=get_region_boxes("Minimap"), multiple=get_region_boxes("multiple"), scripted=get_region_boxes("lua-array")}',regions:references,scriptWidth:800,scriptHeight:600});
  assert.ok(Math.abs(lookup.value.manual[0].x-600)<1e-8);assert.equal(lookup.value.multiple.length,2);assert.equal(lookup.value.scripted.length,2);assert.ok(Math.abs(lookup.value.scripted[1].y-6)<1e-8);
  await assert.rejects(invoke('memory.run_script',{script:'return get_region_boxes("missing")',regions:references}),/not found/);
  await assert.rejects(invoke('memory.run_script',{script:'return get_region_boxes("ui")',regionId:'ui',regions:references}),/own output/);
  await assert.rejects(invoke('memory.run_script',{script:'return get_region_boxes("multiple")',regions:references.map(r=>({...r,timestamp:0}))}),/older than/);
  const empty=await invoke('memory.run_script',{script:'return #get_region_boxes("ui")',regions:[{...references[0],boxes:[]}]});assert.equal(empty.value,0);
  const renamed=await invoke('memory.run_script',{script:'return get_region_boxes("ui")',regions:[{...references[0],label:'Renamed minimap'}],scriptWidth:800,scriptHeight:600});assert.ok(Math.abs(renamed.value[0].x-600)<1e-8);
  const nodes=[['s',{kind:'state',name:'Monsters'}],['f',{kind:'formula',name:'Nearby monsters',inputs:['monsters'],source:'count_within(monsters, vec(0, 0), 100)'}],['c',{kind:'condition',name:'Crowded',operator:'ge',value:'1'}],['t',{kind:'trigger',name:'Crowded',mode:'repeat',initial:true,intervalMs:250,cooldownMs:0,holdMs:0}],['i',{kind:'capture',format:'png',area:'window'}],['o',{kind:'output',directory:output,pattern:'{session}/{sequence}',metadata:'json',fields:['count','Monsters','Empty','Bad'],labels:'{"purpose":"test"}'}]].map(([id,data])=>({id,data}));
  const edges=[{source:'s',target:'f',targetHandle:'monsters'},...([['f','c'],['c','t'],['t','i'],['i','o']].map(([source,target])=>({source,target,targetHandle:'in'})))];
  nodes.find(n=>n.id==='o').data.fields.push('Lookup','From state');
  await collector.start({graphId:'test',name:'Collection test',scope:'test',windowId,doc:{nodes,edges}});
  for(let n=0;n<100&&collector.statuses()[0].saved<3;n++)await wait(50);
  collector.stop('test');await wait(200);
  const status=collector.statuses()[0];assert.ok(status.saved>=3,JSON.stringify(status));
  const lookupMetadata=JSON.parse(fs.readFileSync(status.recent[0].path+'.json'));
  assert.equal(lookupMetadata.states.Lookup.valid,true,'Recorded Lua States must receive Region snapshots');
  assert.ok(Math.abs(lookupMetadata.states.Lookup.value[0].x-600)<1e-8);
  assert.equal(lookupMetadata.states['From state'].value,42,'Recorded Lua States must read States');
  const geometry=await invoke('memory.run_script',{script:'return get_window_size()'});
  assert.equal(geometry.value.w,geometry.windowW);assert.equal(geometry.value.h,geometry.windowH);
  assert.ok(geometry.clientArea.y>0,'A decorated window must place its game/client area below the title bar');
  const sample=nativeImage.createFromPath(status.recent[0].path),size=sample.getSize(),pixels=sample.toBitmap();
  const cx=Math.round(geometry.clientArea.x*size.width),cy=Math.round(geometry.clientArea.y*size.height);
  // A Lua State's positions are client-area pixels; toFrame maps them below the title bar and inside the borders
  const toFrame=lookupMetadata.states.Monsters.toFrame;
  assert.ok(toFrame&&Math.abs(toFrame.x-geometry.clientArea.x*size.width)<1e-6&&Math.abs(toFrame.y-geometry.clientArea.y*size.height)<1e-6,JSON.stringify(toFrame));
  assert.ok(Math.abs(toFrame.sx-1)<1e-6&&Math.abs(toFrame.sy-1)<1e-6,'A client-area script maps one pixel to one');
  const sampleOffset=((cy+10)*size.width+cx+10)*4;
  assert.equal(pixels[sampleOffset],130,'Mapped game coordinates missed the canvas (blue)');
  assert.equal(pixels[sampleOffset+1],70,'Mapped game coordinates missed the canvas (green)');
  for(const capture of status.recent){const meta=JSON.parse(fs.readFileSync(capture.path+'.json'));assert.equal(meta.states.count.value,3);assert.deepEqual(meta.states.Monsters.value,[{x:10,y:20,w:30,h:40}]);assert.equal(meta.states.Monsters.type,'shapes');assert.deepEqual(meta.states.Empty.value,[]);assert.equal(meta.states.Empty.valid,true);assert.equal(meta.states.Bad.valid,false);assert.equal(meta.timestamp,capture.timestamp);const image=nativeImage.createFromPath(capture.path),expected=Buffer.from(originals.get(meta.timestamp));for(let i=3;i<expected.length;i+=4)expected[i]=255;assert.ok(image.toBitmap().equals(expected),'Saved RGB pixels differ from the triggering frame');}
  await assert.rejects(invoke('frame',{timestamp:-1}),/source frame/);
  const saved=status.saved;await wait(300);assert.equal(collector.statuses()[0].saved,saved);
  await invoke('stop');console.log(`PASS: Lua collection → Formula → Trigger, empty/invalid lists, ${saved} exact source frames with matching metadata, delayed evaluation, no preview polling, and stop/expiry handling`);
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);runtime?.kill();python?.kill();lab?.destroy();app.exit(process.exitCode||0);}
});
