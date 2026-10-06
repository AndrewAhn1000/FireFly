// Real renderer/preload, isolated profile, independently controlled frames and Lua readings.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','rewind-values-ui-profile'));
let win,frame=0,seenFrame=0,hp=11,fail=false,tracking;
let regionOverride,regionArea={x:0,y:0,w:1,h:1};
let boxes=[{x:40,y:50,w:60,h:70},{x:140,y:150,w:30,h:40}];
const watchdog=setTimeout(()=>{console.error('Rewind UI timed out');app.exit(1);},45000);
app.whenReady().then(async()=>{
 try {
  const images=[1,2,3,4].map(n=>nativeImage.createFromBitmap(Buffer.alloc(400*300*4,n*45),{width:400,height:300}));
  for(const [channel,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(channel,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'Rewind fixture',pid:1}]};
   if(op==='observe.fields')return {fields:[]};
   if(op==='dataset.list')return {recordings:[]};
   if(op==='template.set'){tracking=args;return {};}
   if(op==='frame'){
    await wait(40);if(!frame)return {pending:true};seenFrame=frame;
    const image=images[(frame-1)%images.length];return {dataUrl:image.toDataURL(),timestamp:frame*1000,width:400,height:300,jpeg:image.toJPEG(80)};
   }
   if(op==='memory.run_script'){
    if(fail)throw Error('Temporary read failure');
    return {value:args.regionId ? regionOverride ?? boxes : boxes,windowW:400,windowH:300,clientArea:args.regionId ? regionArea : {x:0,y:0,w:1,h:1}};
   }
   if(op==='memory.read')return {value:hp};
   return {};
  });
  win=new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);await wait(60);};
  const title=async text=>{await js(`document.querySelector('button[title=${JSON.stringify(text)}]').click()`);await wait(100);};
  const row=name=>`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name')?.textContent===${JSON.stringify(name)})`;
  const chip=name=>`${row(name)}?.querySelector('.state-val-chip')?.textContent`;
  const coords=`[...document.querySelectorAll('.region-sub-coords')].map(e=>e.textContent)`;
  const snapshot=()=>js(`({hp:${chip('HP')},count:${chip('Monsters')},values:${row('Monsters')}?.parentElement.querySelector('.state-val-panel')?.textContent,coords:${coords},bounds:document.querySelector('.rtp-coords')?.textContent,status:${row('Monsters')}?.querySelector('.state-read-status')?.textContent,image:document.querySelector('.rtp-live-preview img')?.src,raw:document.querySelector('.rtp-lua-reading')?.textContent})`);
  const publish=async n=>{frame=n;for(let i=0;i<50&&seenFrame!==n;i++)await wait(20);assert.equal(seenFrame,n);await wait(160);};
  const matches=async(n,x,confidence)=>{
   assert.ok(tracking,'Tracking must be active');
   const found=Array.from({length:n},(_,i)=>({x:x+i*.1,y:.2,w:.1,h:.1,confidence,templateId:'t'}));
   win.webContents.send('runtime:event',{event:'template.match',result:{timestamp:(frame+1)*1000,regions:[{region:'tracked',context:tracking.context,matches:found,position:[x*400,60],velocity:[0,0]}]}});
   await wait(180);
  };
  const seek=async value=>{await js(`(()=>{const i=document.querySelector('.tp-scrub');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${value});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(140);};
  await win.loadFile(path.join(root,'dist/index.html'));
  const states=[{id:'mobs',name:'Monsters',type:'collection',source:'script',script:'return {}'}, {id:'hp',name:'HP',type:'number',source:'memory',address:'0x1000',byteType:'i32'}, {id:'matches',name:'Matches',type:'collection',source:'region',regionId:'tracked',output:'@matches'}];
  const regions=[{id:'boxes',label:'Monsters',source:'script',script:'return {}',templates:[],visible:true,x:0,y:0,w:0,h:0}, {id:'tracked',label:'Tracked',source:'manual',templates:[{id:'t',cropUrl:images[0].toDataURL()}],match:true,multiMatch:true,matchThreshold:.5,x:.1,y:.2,w:.1,h:.1}];
  await js(`localStorage.clear();localStorage.setItem('firefly-states-Rewind%20fixture',${JSON.stringify(JSON.stringify(states))});localStorage.setItem('firefly-regions-Rewind%20fixture',${JSON.stringify(JSON.stringify(regions))})`);
  win.reload();await wait(500);await until(`document.querySelector('.win-item')`);
  await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await click('Start Session');
  await until(`${chip('Monsters')}==='2 items'`);
  await js(`${row('Monsters')}.click();document.querySelector('.region-expand-btn').click()`);
  await publish(1);await until(`document.querySelectorAll('.region-sub-coords').length===2`);
  await js(`document.querySelector('.region-sub-item').click()`);await until(`document.querySelector('.rtp-coords')?.textContent.includes('40px')`);
  const first=await snapshot();assert.equal(first.hp,'11');assert.deepEqual(first.coords,['40,50 · 60×70px','140,150 · 30×40px']);
  boxes=[{x:200,y:100,w:90,h:80}];hp=22;
  await matches(1,.5,.65);
  await until(`${chip('Matches')}==='1 items'`);
  await until(`${chip('HP')}==='22' && ${coords}[0]==='200,100 · 90×80px'`);
  fail=true;await until(`${row('Monsters')}?.querySelector('.state-read-status')`);
  await publish(2);const second=await snapshot();assert.equal(second.status,'Last value');
  fail=false;boxes=[];hp=0;
  await matches(0,0,0);
  await until(`${chip('HP')}==='0' && ${chip('Monsters')}==='0 items' && document.querySelector('.rtp-empty-bounds')`);
  await publish(3);
  await title('Pause (Space)');
  const empty=await snapshot();assert.equal(empty.count,'0 items');assert.equal(empty.hp,'0');assert.deepEqual(empty.coords,[]);
  // Live polling keeps running, but every inspector and overlay stays on the paused frame.
  boxes=[{x:10,y:20,w:35,h:45}];hp=44;await matches(3,.1,.9);await publish(4);await wait(250);
  assert.deepEqual(await snapshot(),empty,'Live readings changed the paused frame');
  await title('Back one frame (←)');const rewound=await snapshot();
  assert.equal(await js(chip('Matches')),'1 items','Multi-match State must rewind');
  await js(`document.querySelector('input[value="Tracked"]').closest('.region-row').click()`);
  await until(`document.querySelector('.rtp-conf-val')?.textContent==='65%'`);
  assert.match(await js(`document.querySelector('.rtp-coords').textContent`),/X 200px/,'Tracked geometry must rewind');
  await js(`document.querySelector('.region-sub-item').click()`);await wait(50);
  for(const k of ['hp','count','values','coords','bounds','status','raw'])assert.deepEqual(rewound[k],second[k],`Frame 2 ${k}`);
  assert.ok(rewound.image.startsWith('data:image/jpeg'),'Rewind must use the buffered image');
  await seek(0);const oldest=await snapshot();
  for(const k of ['hp','count','values','coords','bounds','status','raw'])assert.deepEqual(oldest[k],first[k],`Frame 1 ${k}`);
  await wait(200);assert.deepEqual(await snapshot(),oldest,'Historical values drifted while paused');
  await title('Forward one frame (→)');assert.equal((await snapshot()).hp,'22');
  await title('Forward one frame (→)');assert.equal((await snapshot()).count,'0 items');
  assert.equal(await js(chip('Matches')),'0 items');
  await title('Jump to the live view (End)');
  await until(`${chip('HP')}==='44' && ${coords}[0]==='10,20 · 35×45px'`);
  assert.equal(await js(`document.querySelector('.tp-time').textContent`),'LIVE');
  assert.equal(await js(chip('Matches')),'3 items');
  await js(`document.querySelector('input[value="Tracked"]').closest('.region-row').click()`);
  await until(`document.querySelector('.rtp-conf-val')?.textContent==='90%'`);
  assert.match(await js(`document.querySelector('.rtp-coords').textContent`),/X 40px/,'Tracked geometry must keep updating behind pause');
  await js(`document.querySelector('.region-sub-item').click()`);await wait(50);
  // A late seek callback cannot replace the live view after Go Live.
  await js(`(()=>{const i=document.querySelector('.tp-scrub');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,0);i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.tp-live').click();})()`);
  await wait(200);assert.equal((await snapshot()).hp,'44');assert.equal(await js(`document.querySelector('.tp-time').textContent`),'LIVE');
  // Identical scripts can return different values on their separate invocations.
  // Record the Region's own raw value, not the matching State or a later rerun.
  boxes=[{id:9009,x:257,y:9,w:35,h:34}];
  await until(`${coords}[0]==='257,9 · 35×34px'`);await publish(5);
  regionOverride=[{id:9009,x:-241,y:-214,w:35,h:34}];
  await until(`${coords}[0]==='-241,-214 · 35×34px'`);await publish(6);
  const rawJump=await snapshot();assert.match(rawJump.values,/x:257/);assert.match(rawJump.raw,/x:-241/);
  assert.match(rawJump.raw,/Offset X 0px · Y 0px/);
  // The same displayed jump can also be caused by conversion metadata alone.
  regionOverride=undefined;regionArea={x:-498/400,y:-223/300,w:1,h:1};
  await until(`document.querySelector('.rtp-lua-reading')?.textContent.includes('Offset X -498px')`);await publish(7);
  const offsetJump=await snapshot();assert.match(offsetJump.values,/x:257/);assert.match(offsetJump.raw,/x:257/);
  assert.deepEqual(offsetJump.coords,rawJump.coords);assert.match(offsetJump.raw,/Offset X -498px · Y -223px/);
  await title('Pause (Space)');await title('Back one frame (←)');
  assert.equal((await snapshot()).raw,rawJump.raw,'Rewind must restore the exact Region invocation and geometry');
  await title('Back one frame (←)');assert.equal((await snapshot()).coords[0],'257,9 · 35×34px');
  await title('Forward one frame (→)');await title('Forward one frame (→)');
  assert.equal((await snapshot()).raw,offsetJump.raw);
  await js(`document.querySelector('.rtp-lua-reading').open=true`);await wait(80);
  fs.writeFileSync(path.join(root,'build','rewind-values-ui.png'),(await win.webContents.capturePage()).toPNG());
  console.log('PASS: historical State/Region values, exact raw Region readings versus separate State runs, conversion offsets, empty arrays, tracking, Go Live and seek cancellation');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();app.exit(process.exitCode||0);}
});
