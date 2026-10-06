// Real renderer/preload; isolated settings, deterministic devices and delayed observations.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','inference-ui-profile'));
let win,graph,failApply=false,frames=[],recording=false;
const watchdog=setTimeout(()=>{console.error('Inference UI timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 try {
  const image=nativeImage.createFromBitmap(Buffer.alloc(320*200*4,120),{width:320,height:200}).toDataURL();
  const model={id:'test',name:'Test model',path:'test.onnx',missing:false,size:1024,createdAt:'2026-09-25',source:{kind:'imported',path:'test.onnx'},input:{width:64,height:64},training:null,threshold:.5,flow:{version:1,outputs:[]}};
  ipcMain.handle('runtime:available',()=>true);ipcMain.handle('runtime:status',()=>({ready:true,error:null}));
  ipcMain.handle('windows:thumbnails',()=>({}));ipcMain.handle('models:list',()=>[model]);ipcMain.handle('models:probe',()=>null);
  ipcMain.handle('training:check-checkpoint',()=>({found:false}));ipcMain.handle('training:gpu-check',()=>({available:false}));
  const event=(event,result)=>win.webContents.send('runtime:event',{event,result});
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='inference.devices')return {devices:[{id:'cpu',provider:'cpu',device:0,label:'CPU'},{id:'directml:0',provider:'directml',device:0,label:'GPU · Test adapter (DirectML)'}]};
   if(op==='windows')return {windows:[{id:'123',title:'Inference fixture',pid:1}]};
   if(op==='graph.apply'){if(failApply)throw Error('Apply rejected');graph=args.graph;}
   if(op==='frame'){await wait(20);frames.push(args.processed);return {dataUrl:image,timestamp:Date.now(),width:320,height:200};}
   if(op==='record.start'){recording=true;event('recording',{active:true,id:args.recordingId,samples:0});}
   if(op==='record.stop'){recording=false;event('recording',{active:false,samples:0});}
   if(op==='dataset.list')return {recordings:[]};
   return {ok:true};
  });
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error'&&!d.message.includes('Apply rejected'))errors.push(d.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('UI condition failed: '+code);};
  const select=async(label,value)=>{await js(`(()=>{const e=document.querySelector('[aria-label="${label}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(150);};
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.removeItem('firefly-inference-device')`);await win.reload();await until(`!!document.querySelector('.win-item')`);
  await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Start Session').click()`);
  await until(`!!document.querySelector('[aria-label="Preview source"]')`);
  await js(`[...document.querySelectorAll('.bottom-center-panel .panel-tab')].find(b=>b.textContent.includes('Trained Models')).click()`);
  await until(`!!document.querySelector('.model-row')`);await js(`document.querySelector('.model-row').click()`);
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Run on live capture'))`);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run on live capture')).click()`);
  await wait(200);assert.equal(graph.nodes.find(n=>n.op==='segment').params.provider,'cpu');
  assert.equal(frames.at(-1),false,'Default preview should use raw capture');
  await select('Model inference device','directml:0');
  assert.equal(graph.nodes.find(n=>n.op==='segment').params.provider,'directml');
  assert.equal(await js(`localStorage.getItem('firefly-inference-device')`),'directml:0');
  event('detection-status',{timestamp:Date.now()-250,durationMs:240});await until(`document.querySelector('.viewport-fps').textContent.includes('ms behind')`);
  const before=frames.length;await wait(350);assert.ok(frames.length>before+3,'Preview stopped waiting for detection');
  await select('Preview source','processed');await wait(100);assert.equal(frames.at(-1),true);
  await select('Preview source','live');await wait(100);assert.equal(frames.at(-1),false);
  failApply=true;await select('Model inference device','cpu');await until(`document.querySelector('.inference-error')?.textContent.includes('Apply rejected')`);
  assert.equal(await js(`document.querySelector('[aria-label="Model inference device"]').value`),'directml:0');
  failApply=false;await select('Model inference device','cpu');assert.equal(graph.nodes.find(n=>n.op==='segment').params.provider,'cpu');
  event('recording',{active:true,id:'test-recording',samples:0});await until(`document.querySelector('[aria-label="Model inference device"]').disabled`);
  event('recording',{active:false,samples:0});await until(`!document.querySelector('[aria-label="Model inference device"]').disabled`);
  await select('Model inference device','directml:0');
  win.webContents.invalidate();await wait(100);fs.writeFileSync(path.join(root,'build/inference-ui.png'),(await win.webContents.capturePage()).toPNG());
  await win.reload();await until(`document.querySelector('[aria-label="Model inference device"]')?.value==='directml:0'`);
  assert.deepEqual(errors,[]);assert.equal(recording,false);
  console.log('PASS: independent preview, processed view, GPU graph parameters, persistence, recording lock, apply failure recovery.');
  clearTimeout(watchdog);win.destroy();app.exit(0);
 }catch(e){console.error(e);clearTimeout(watchdog);if(win&&!win.isDestroyed())fs.writeFileSync(path.join(root,'build/inference-ui-failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}
});
