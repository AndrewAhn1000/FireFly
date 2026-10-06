// End-to-end Windows Graphics Capture + native detector + real ONNX model.
// Only the lab window is captured; no keyboard/mouse events are synthesized.
const {app,BrowserWindow,nativeImage}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','runtime-preview-profile'));
let lab,runtime,next=1,buffer=Buffer.alloc(0),events=[];
const pending=new Map();
function invoke(op,args={}) {
 return new Promise((resolve,reject)=>{
  const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timed out: '+op));},30000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  runtime.stdin.write(JSON.stringify({v:1,id,op,...args})+'\n');
 });
}
function output(chunk) {
 buffer=Buffer.concat([buffer,chunk]);
 while(buffer.length>=5){
  const size=buffer.readUInt32LE(0);if(buffer.length<size+4)return;
  const kind=buffer[4],payload=buffer.subarray(5,size+4);buffer=buffer.subarray(size+4);
  if(kind===1){const m=JSON.parse(payload);if(m.event){events.push(m);continue;}const p=pending.get(m.id);pending.delete(m.id);if(p)m.ok?p.resolve(m):p.reject(Error(m.error.message));}
  if(kind===2){const id=payload.readUInt32LE(0),p=pending.get(id);pending.delete(id);p?.resolve({width:payload.readUInt32LE(4),height:payload.readUInt32LE(8),timestamp:payload.readDoubleLE(12),pixels:payload.subarray(20)});}
 }
}
const node=(id,op,inputs=[],params={})=>({id,op,inputs,params});
const model=path.join(root,'runs/unet/best.onnx');
const graph=(revision,provider='cpu',device=0)=>({version:1,id:'integration',revision,nodes:[node('frame','frame'),node('mask','segment',['frame'],{model,provider,device,threshold:.5}),node('coverage','coverage',['mask']),node('out','publish',['coverage'],{name:'coverage'}),node('display','draw_contours',['frame','mask'],{r:0,g:255,b:0,thickness:2}),node('image','publish',['display'],{name:'annotated'})]});
async function pollFor(ms,processed=false){
 const end=Date.now()+ms,frames=[],rtts=[];
 while(Date.now()<end){const t=performance.now(),r=await invoke('frame',{processed});rtts.push(performance.now()-t);if(r.timestamp)frames.push(r);await wait(16);}
 return {frames,rtts};
}
async function observations(revision,timeout=25000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const e=events.find(e=>e.event==='observations'&&e.result.schema.version===revision);if(e){assert.equal(e.result.nodes.mask.valid,true,e.result.nodes.mask.reason);return e.result;}await wait(25);}
 throw Error('No observations for revision '+revision);
}
const watchdog=setTimeout(()=>{console.error('Runtime preview test timed out');runtime?.kill();app.exit(1);},90000);
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
app.whenReady().then(async()=>{
 try {
  assert.ok(fs.existsSync(model),'Existing runs/unet/best.onnx required');
  lab=new BrowserWindow({width:480,height:340,x:40,y:40,show:false,title:'FireFly Capture Lab',webPreferences:{backgroundThrottling:false}});
  await lab.loadURL('data:text/html,'+encodeURIComponent(`<title>FireFly Capture Lab</title><style>body{margin:0;background:#123;color:white}canvas{display:block}</style><canvas width="460" height="290"></canvas><script>let n=0,c=document.querySelector('canvas').getContext('2d');function tick(){c.fillStyle='#123';c.fillRect(0,0,460,290);c.fillStyle='#fea';c.fillRect((n*3)%380,100,60,30);c.fillStyle='white';c.font='20px Arial';c.fillText('FireFly capture test '+n++,12,35);requestAnimationFrame(tick)}tick()</script>`));
  lab.showInactive();await wait(300);
  runtime=spawn(path.join(root,'build/native/Release/firefly-runtime.exe'),[],{stdio:['pipe','pipe','pipe']});
  runtime.stdout.on('data',output);let stderr='';runtime.stderr.on('data',d=>{stderr+=d;});
  runtime.on('exit',code=>{for(const p of pending.values())p.reject(Error('Runtime exited '+code+' '+stderr));pending.clear();});
  const devices=(await invoke('inference.devices')).devices;console.log('Devices:',JSON.stringify(devices));
  await invoke('storage.init',{directory:path.join(root,'build','runtime-preview-data')});
  await invoke('graph.apply',{graph:graph(1)});
  await invoke('start',{windowId:lab.getNativeWindowHandle().readBigUInt64LE().toString()});
  const raw=await pollFor(2500);const cpu=await observations(1);
  assert.ok(new Set(raw.frames.map(f=>f.timestamp)).size>=10,'Live capture did not keep advancing during CPU inference');
  const processed=await pollFor(400,true);assert.ok(processed.frames.length>0,'Processed frame missing');
  const detectedStamps=new Set(events.filter(e=>e.event==='observations').map(e=>e.result.timestamp));
  assert.ok(processed.frames.every(f=>detectedStamps.has(f.timestamp)),'Processed preview used a different source timestamp');
  // Template matching has its own worker, and matches every region in the same frame: each event
  // carries every region's result, in order of frames, apart from observations.
  const pattern=raw.frames.at(-1),bitmap=nativeImage.createFromBitmap(pattern.pixels,{width:pattern.width,height:pattern.height});
  const crop=rect=>bitmap.crop(rect).toPNG().toString('base64');
  await invoke('template.set',{region:'first',context:'integration-first',multiMatch:true,threshold:.99,templates:[{key:'sample',data:crop({x:30,y:25,width:24,height:24})}]});
  await invoke('template.set',{region:'second',context:'integration-second',templates:[{key:'text',data:crop({x:100,y:15,width:40,height:24})}]});
  const since=events.length;await pollFor(800);
  const matches=events.slice(since).filter(e=>e.event==='template.match');assert.ok(matches.length>0);
  const byRegion=(e,id)=>e.result.regions.find(r=>r.region===id);
  assert.ok(matches.every(e=>e.result.regions.length===2&&e.result.durationMs>=0),'Not every region was matched in each frame');
  assert.ok(matches.every(e=>byRegion(e,'first')?.context==='integration-first'&&byRegion(e,'first').found===true),'First region lost');
  assert.ok(matches.every(e=>byRegion(e,'second')?.context==='integration-second'&&byRegion(e,'second').found===true&&byRegion(e,'second').confidence>.99),'Second region lost');
  assert.ok(matches.every((e,i)=>i===0||e.result.timestamp>=matches[i-1].result.timestamp),'Template results went back in time');
  const matchSpan=(matches.at(-1).result.timestamp-matches[0].result.timestamp)/1000,templateHz=matchSpan>0?(matches.length-1)/matchSpan:null,templateMs=median(matches.map(e=>e.result.durationMs));
  // Removing one region leaves the other followed
  await invoke('template.remove',{region:'second'});const afterRemove=events.length;await pollFor(300);
  const remaining=events.slice(afterRemove).filter(e=>e.event==='template.match').slice(1);
  assert.ok(remaining.length>0&&remaining.every(e=>e.result.regions.length===1&&e.result.regions[0].region==='first'),'Removing one region affected the other');
  // Actual async recording rows keep the analyzed frame's timestamp/schema.
  const id='async-'+Date.now();await invoke('record.start',{recordingId:id,name:'Async capture regression',hz:15,buttons:[{id:'left',vk:37}]});
  const recordedPreview=await pollFor(1800);assert.ok(recordedPreview.frames.length>=10);
  await invoke('record.stop');const rows=(await invoke('dataset.read',{recordingId:id,offset:0,limit:100})).recording.rows;
  assert.ok(rows.length>0,'No async recording samples');
  const timestamps=new Set(events.filter(e=>e.event==='observations').map(e=>e.result.timestamp));
  assert.ok(rows.every(r=>timestamps.has(r.timestamp)),'Recording used preview time instead of detection time');
  // What a recording holds is chosen: an observation left out isn't in its samples or schema, and
  // recordings can be deleted, though not while they're being made
  const observed=(await invoke('observe.fields')).fields.map(f=>f.name);
  assert.deepEqual(observed.sort(),['annotated','coverage']);
  const whole=(await invoke('session.schemas',{buttons:[{id:'left',vk:37}]})).observationSchema;
  await invoke('observe.recorded',{exclude:['annotated']});
  const part=(await invoke('session.schemas',{buttons:[{id:'left',vk:37}]})).observationSchema;
  assert.deepEqual(part.fields.map(f=>f.name),['coverage']);assert.notEqual(part.identity,whole.identity);
  const partId='part-'+Date.now();await invoke('record.start',{recordingId:partId,name:'Without annotated',hz:15,buttons:[{id:'left',vk:37}]});
  await assert.rejects(invoke('observe.recorded',{exclude:[]}),/Stop recording/);
  await assert.rejects(invoke('dataset.delete',{recordingId:partId}),/Stop this recording/);
  await pollFor(1200);await invoke('record.stop');
  const partRows=(await invoke('dataset.read',{recordingId:partId,offset:0,limit:100})).recording.rows;
  assert.ok(partRows.length>0&&partRows.every(r=>r.observations.map(o=>o.name).join()==='coverage'&&r.observationSchema===part.identity),'Left-out observation was recorded');
  await invoke('observe.recorded',{exclude:[]});
  // Memory and Lua States are read by the runtime as each frame is sent, recorded under their names,
  // conformed to their type; one that can't be read is invalid, and so are its samples unless left out
  await invoke('observe.tracked',{observations:[{name:'answer',value:'script',script:'return 42',type:'number'},
    {name:'place',value:'script',script:'return {x=3,y=4}',type:'vector'},{name:'unreadable',value:'memory',address:'0x10',byteType:'u32'}]});
  assert.deepEqual((await invoke('observe.fields')).fields.map(f=>f.name).slice(-3),['answer','place','unreadable']);
  await invoke('observe.recorded',{exclude:['annotated']});
  const probeId='probes-'+Date.now();await invoke('record.start',{recordingId:probeId,name:'Probes',hz:15,buttons:[{id:'left',vk:37}]});
  await pollFor(1000);await invoke('record.stop');
  const probeRows=(await invoke('dataset.read',{recordingId:probeId,offset:0,limit:100})).recording.rows;
  const value=(row,name)=>row.observations.find(o=>o.name===name);
  assert.ok(probeRows.length>0&&probeRows.every(r=>value(r,'answer').valid&&value(r,'answer').value===42&&JSON.stringify(value(r,'place').value)==='[3,4]'),'Lua States not recorded: '+JSON.stringify(probeRows[0]?.observations));
  assert.ok(probeRows.every(r=>!value(r,'unreadable').valid&&/ReadProcessMemory|Pointer/.test(value(r,'unreadable').reason)&&!r.valid),'Unreadable memory should be invalid, and so its samples');
  assert.ok(events.some(e=>e.event==='observations'&&typeof e.result.probeMs?.answer==='number'),'How long each State took was not reported');
  await invoke('observe.recorded',{exclude:['annotated','unreadable']});
  const keptId='probes-kept-'+Date.now();await invoke('record.start',{recordingId:keptId,name:'Probes kept',hz:15,buttons:[{id:'left',vk:37}]});
  await pollFor(800);await invoke('record.stop');
  const keptRows=(await invoke('dataset.read',{recordingId:keptId,offset:0,limit:100})).recording.rows;
  assert.ok(keptRows.length>0&&keptRows.every(r=>!value(r,'unreadable')&&value(r,'answer').valid),'Leaving the unreadable State out did not keep it out');
  await invoke('observe.tracked',{observations:[]});await invoke('observe.recorded',{exclude:[]});
  for(const id of [probeId,keptId])await invoke('dataset.delete',{recordingId:id});
  await invoke('dataset.delete',{recordingId:partId});
  assert.ok(!(await invoke('dataset.list')).recordings.some(r=>r.id===partId),'Deleted recording still listed');
  assert.ok(!fs.existsSync(path.join(root,'build','runtime-preview-data','recordings',partId)),'Deleted recording files remain');
  await invoke('template.clear');
  const gpu=devices.find(d=>d.provider==='directml');let gpuResult=null;
  if(gpu){
   await invoke('graph.apply',{graph:graph(2,'directml',gpu.device)});
   await pollFor(1200);await observations(2);
   await pollFor(1500);gpuResult=events.filter(e=>e.event==='observations'&&e.result.schema.version===2).at(-1).result;
   assert.equal(gpuResult.nodes.mask.valid,true,gpuResult.nodes.mask.reason);
   // Invalid GPU selection reports a model error while raw preview still runs.
   await invoke('graph.apply',{graph:graph(3,'directml',128)});await pollFor(500);
   assert.ok(events.some(e=>e.event==='observations'&&e.result.schema.version===3&&!e.result.nodes.mask.valid),'GPU failure not exposed');
  }
  await invoke('stop');const count=events.length;await wait(250);
  assert.equal(events.slice(count).filter(e=>e.event==='observations').length,0,'Late detection escaped after stopping');
  const warm=revision=>events.filter(e=>e.event==='observations'&&e.result.schema.version===revision&&e.result.nodes.mask.valid).slice(1).map(e=>e.result.latencyMs);
  const report={previewFrames:new Set(raw.frames.map(f=>f.timestamp)).size,cpuFirstMs:cpu.latencyMs,cpuWarmMedianMs:median(warm(1)),gpu:gpu?.label,gpuWarmMedianMs:median(warm(2)),gpuWarmMs:gpuResult?.latencyMs,recordedSamples:rows.length,templateHz,templateMs,maxPreviewReplyMs:Math.max(...raw.rtts)};
  fs.writeFileSync(path.join(root,'build/runtime-preview-result.json'),JSON.stringify(report,null,2));
  console.log('PASS:',JSON.stringify(report));await invoke('shutdown');clearTimeout(watchdog);lab.destroy();app.exit(0);
 }catch(e){console.error(e);runtime?.kill();clearTimeout(watchdog);lab?.destroy();app.exit(1);}
});
