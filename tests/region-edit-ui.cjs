const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','region-edit-ui-profile'));
let win,releasePreview;
let scriptValue=[{x:80,y:60,w:160,h:120}],failLive=false;
const watchdog=setTimeout(()=>{console.error('Region UI timed out');app.exit(1);},45000);
app.whenReady().then(async()=>{
 try {
  const image=nativeImage.createFromBitmap(Buffer.alloc(400*330*4,150),{width:400,height:330});
  for(const [channel,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(channel,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'Region fixture',pid:1}]};
   if(op==='observe.fields')return {fields:[]};
   if(op==='dataset.list')return {recordings:[]};
   if(op==='frame'){await wait(40);return {dataUrl:image.toDataURL(),timestamp:Date.now(),jpeg:image.toJPEG(80)};}
   if(op==='memory.run_script'){
    if(failLive)throw Error('Temporary Region read failure');
    if(args.script==='return {} -- delayed')await new Promise(r=>releasePreview=r);
    return {value:scriptValue,windowW:400,windowH:300,clientArea:{x:0,y:30/330,w:1,h:300/330}};
   }
   return {};
  });
  win=new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(e){throw Error(`${e.message}\n${code}`);}};
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(60);};
  const input=async(label,value)=>{await js(`(()=>{const i=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(50);};
  const key='firefly-regions-Region%20fixture',saved=()=>js(`JSON.parse(localStorage.getItem('${key}'))`);
  const original=[{id:'mobs',label:'Monsters',source:'script',script:'return {{x=80,y=60,w=160,h=120}}',templates:[],visible:true,x:0,y:0,w:0,h:0},
    {id:'ui',label:'Minimap',source:'manual',templates:[],x:.75,y:0,w:.25,h:.25}];
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();localStorage.setItem('${key}',${JSON.stringify(JSON.stringify(original))})`);win.reload();await wait(500);
  await until(`document.querySelector('.win-item')`);await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await click('Start Session');
  await until(`document.querySelector('.region-expand-btn')`);await js(`document.querySelector('.region-expand-btn').click()`);
  await until(`document.querySelector('.region-sub-coords')?.textContent==='80,90 · 160×120px'`);
  await js(`document.querySelector('[aria-label="Edit region Monsters"]').click()`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="Region Lua script"]').value`),original[0].script);
  await js(`(()=>{const i=document.querySelector('[aria-label="Region Lua script"]');i.focus();i.setSelectionRange(0,0);i.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));})()`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="Region Lua script"]').value`),'    '+original[0].script);
  await js(`document.querySelector('[aria-label="Region Lua script"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="Region Lua script"]').value`),original[0].script);
  assert.equal(await js(`document.querySelector('[aria-label="Insert Region reference"]')`),null);
  await input('Region Lua script','local boxes = regions.');
  await until(`document.querySelector('[aria-label="Name suggestions"]')`);
  assert.ok(await js(`![...document.querySelectorAll('[role="option"]')].some(o=>o.textContent.includes('Monsters'))`),'Self reference must not appear in suggestions');
  await js(`document.querySelector('[aria-label="Region Lua script"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="Region Lua script"]').value`),'local boxes = regions.Minimap');
  await input('Region Lua script','return regions.Mi');
  await until(`document.querySelector('[role="option"]')`);
  fs.writeFileSync(path.join(root,'build','lua-region-completion.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('[role="option"]').click()`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="Region Lua script"]').value`),'return regions.Minimap');
  await input('Region Lua script',original[0].script);
  await input('Script coordinate width','800');await input('Script coordinate height','600');
  await click('Run Script');await until(`document.querySelector('.script-test-ok')`);
  assert.match(await js(`document.querySelector('.modal-overlay .state-val-panel').textContent`),/x:40.*y:60.*w:80.*h:60/);
  fs.writeFileSync(path.join(root,'build','region-edit-ui.png'),(await win.webContents.capturePage()).toPNG());
  await click('Save Changes');await until(`document.querySelector('.region-sub-coords')?.textContent==='40,60 · 80×60px'`);
  const changed=await saved();assert.equal(changed.length,2);assert.equal(changed[0].id,'mobs');assert.equal(changed[0].scriptWidth,800);assert.equal(changed[0].scriptHeight,600);assert.equal(changed[0].visible,true);
  await js(`document.querySelector('[aria-label="Edit region Monsters"]').click()`);await input('Region Lua script','return {}');await click('Cancel');assert.deepEqual(await saved(),changed);
  await js(`document.querySelector('[aria-label="Edit region Monsters"]').click()`);await input('Region Lua script','return {} -- delayed');await click('Run Script');
  for(let n=0;n<40&&!releasePreview;n++)await wait(25);assert.ok(releasePreview);
  await input('Script coordinate height','700');releasePreview();await wait(100);
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save Changes').disabled`));
  await click('Cancel');
  // A selected Lua box disappearing must never fall back to the saved Region rectangle.
  await js(`document.querySelector('.region-sub-item').click()`);
  await until(`document.querySelector('.rtp-live-preview')`);
  const visibleBounds=await js(`document.querySelector('.rtp-coords').textContent`);
  failLive=true;await wait(160);
  assert.equal(await js(`document.querySelector('.rtp-coords').textContent`),visibleBounds,'A failed refresh must hold the last Region bounds');
  failLive=false;scriptValue=null;await wait(160);
  assert.equal(await js(`document.querySelector('.rtp-coords').textContent`),visibleBounds,'A nil refresh must hold the last Region bounds');
  for(const empty of [[],{},[],{}]) {
   scriptValue=empty;
   await until(`document.querySelector('.rtp-empty-bounds')?.textContent==='No boxes returned'`);
   assert.equal(await js(`document.querySelectorAll('.rtp-live-preview').length`),0);
   assert.ok(await js(`document.querySelector('.rtp-thumb-add').disabled`));
   assert.ok(await js(`document.querySelector('.region-expand-btn')`));
   assert.equal(await js(`document.querySelector('.region-sub-empty').textContent`),'No boxes returned');
   await wait(120);
   assert.equal(await js(`document.querySelector('.rtp-empty-bounds').textContent`),'No boxes returned');
   scriptValue=[{x:80,y:60,w:160,h:120}];
   await until(`document.querySelector('.rtp-live-preview')`);
   assert.equal(await js(`document.querySelector('.rtp-coords').textContent`),visibleBounds);
  }
  assert.deepEqual(await saved(),changed,'Empty results must not change saved size or visibility');
  win.webContents.send('runtime:event',{event:'recording',result:{active:true,id:'r',samples:0,invalidSamples:0,inputEvents:0}});await wait(60);
  assert.ok(await js(`document.querySelector('[aria-label="Edit region Monsters"]').disabled`));
  console.log('PASS: Lua Region editing, name completion, Tab indentation, scaling, held overlays on failures/nil, valid empty updates, cancel, stale test rejection, recording lock');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();app.exit(process.exitCode||0);}
});
