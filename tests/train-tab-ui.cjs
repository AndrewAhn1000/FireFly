// The Train tab trains either model: switching to YOLO shows its own settings, checks a YOLO dataset, starts the
// detector's training with them, and shows its scores and best weights; the UNet's settings are kept apart
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','train-tab-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Train tab UI timed out');app.exit(1);},45000);
const calls=[];
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',(_,op)=>op==='windows'?{windows:[]}:op==='dataset.list'?{recordings:[]}:op==='observe.fields'?{fields:[]}:{});
  ipcMain.handle('policy:invoke',(_,op)=>op==='models'?[]:{});
  ipcMain.handle('policy:reveal',(_,file)=>{calls.push(['reveal',file]);});
  ipcMain.handle('training:gpu-check',()=>({available:true,name:'Test GPU'}));
  ipcMain.handle('training:check-checkpoint',(_,dir,kind)=>{calls.push(['checkpoint',dir,kind]);return {found:false};});
  ipcMain.handle('training:pick-folder',()=>'C:\\data\\dataset');
  ipcMain.handle('training:check-dataset',(_,dir,kind)=>{calls.push(['check',dir,kind]);return {ok:true,result:{kind:'yolo',pass:true,pairs:260,sampledCount:0,coverageMean:0,
    splits:{train:{images:208,boxes:907},val:{images:52,boxes:237}},
    classes:[{name:'screen_monsters',boxes:971,color:'#ff4d4d'},{name:'screen_npcs',boxes:75,color:'#3ddc84'}],
    warnings:['Only 75 "screen_npcs" boxes: expect that class to be weak (a few hundred or more helps)']}};});
  ipcMain.handle('training:start',(_,params)=>{calls.push(['start',params]);return {ok:true};});
  ipcMain.handle('training:export-onnx',(_,dir,size,data)=>{calls.push(['export',dir,size,data]);return {ok:true,path:dir+'\best.onnx'};});
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async code=>{for(let i=0;i<80;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(120);};
  const has=text=>js(`document.querySelector('.train-panel').textContent.includes(${JSON.stringify(text)})`);
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();0`);win.reload();await wait(600);
  await click('Train');
  await until(`document.querySelector('.train-kind')`);
  // The UNet's settings by default
  assert.ok(await js(`document.querySelector('[aria-label="Width"]')!==null`));
  assert.equal(await js(`document.querySelector('[aria-label="YOLO model"]')`),null);
  // Switch to YOLO: its own settings, and the UNet-only ones gone
  await click('Object detection (YOLO)');
  assert.ok(await js(`document.querySelector('.train-kind-btn.active').textContent==='Object detection (YOLO)'`));
  assert.equal(await js(`document.querySelector('[aria-label="Width"]')`),null);
  assert.ok(!(await has('Decode the images once')));
  assert.equal(await js(`document.querySelector('[aria-label="YOLO model"]').value`),'yolo11n');
  assert.equal(await js(`document.querySelector('[aria-label="Image size"]').value`),'800');
  assert.equal(await js(`[...document.querySelectorAll('.train-input')][1].value`),'runs/yolo/train','YOLO has its own output folder');
  assert.ok(calls.some(c=>c[0]==='checkpoint'&&c[1]==='runs/yolo/train'&&c[2]==='yolo'),'Resume is looked for in the YOLO output, as YOLO');
  // Its dataset check
  await click('Browse');await click('Check Dataset');
  await until(`document.querySelector('.ds-check-summary')`);
  assert.deepEqual(calls.find(c=>c[0]==='check'),['check','C:\\data\\dataset','yolo']);
  assert.ok(await has('260 images (208 train, 52 val)'));
  assert.ok(await has('screen_monsters 971'));
  assert.ok(await has('Only 75 "screen_npcs" boxes'));
  // Start: the detector's settings
  await js(`(()=>{const s=document.querySelector('[aria-label="YOLO model"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'yolo11s');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(80);
  await js(`[...document.querySelectorAll('.train-panel label')].find(l=>l.textContent.includes('Use GPU')).querySelector('input').click()`);await wait(80);
  await click('▶ Start Training');
  const start=calls.find(c=>c[0]==='start')[1];
  assert.deepEqual({kind:start.kind,dataDir:start.dataDir,outDir:start.outDir,epochs:start.epochs,batch:start.batch,model:start.model,imgsz:start.imgsz,resume:start.resume,device:start.device},
    {kind:'yolo',dataDir:'C:\\data\\dataset',outDir:'runs/yolo/train',epochs:100,batch:16,model:'yolo11s',imgsz:800,resume:false,device:'cuda'});
  assert.ok(await js(`[...document.querySelectorAll('.train-kind-btn')].every(b=>b.disabled)`),'No switching while training');
  // Its scores, then its best weights
  win.webContents.send('training:progress',{kind:'yolo',epoch:12,totalEpochs:100,trainLoss:2.13,valLoss:2.72,precision:0.966,recall:0.857,map50:0.906,map:0.676,lr:0.0002,sec:2.4});
  await until(`document.querySelector('.train-panel').textContent.includes('mAP50-95')`);
  assert.ok(await has('90.6%'));assert.ok(await has('🟢 excellent'));assert.ok(await has('Epoch 12 / 100'));
  assert.ok(!(await has('Train IoU')),'No IoU for a detector');
  win.webContents.send('training:done',{code:0,outDir:'runs/yolo/train',kind:'yolo',best:'C:\\runs\\yolo\\train\\weights\\best.pt'});
  await until(`document.querySelector('.train-panel').textContent.includes('Best weights')`);
  // A detector is exported at the size it trained at and added to Trained Models
  await click('Export ONNX');
  await until(`document.querySelector('.train-panel').textContent.includes('Exported ONNX')`);
  const exported=calls.find(c=>c[0]==='export');assert.deepEqual(exported[2],{kind:'yolo'});
  await click('Show file');
  assert.deepEqual(calls.find(c=>c[0]==='reveal'),['reveal','C:\\runs\\yolo\\train\\weights\\best.pt']);
  fs.writeFileSync(path.join(root,'build','train-tab-ui.png'),(await win.webContents.capturePage()).toPNG());
  // Back to the UNet: its own folders kept
  await click('Segmentation (UNet)');
  assert.equal(await js(`[...document.querySelectorAll('.train-input')][1].value`),'runs/unet');
  assert.equal(await js(`[...document.querySelectorAll('.train-input')][0].value`),'',"The YOLO dataset isn't the UNet's");
  const saved=JSON.parse(await js(`localStorage.getItem('firefly-train-config')`));
  assert.equal(saved.yolo.model,'yolo11s');assert.equal(saved.yolo.dataDir,'C:\\data\\dataset');
  assert.deepEqual(errors.filter(e=>!e.includes('No handler registered')&&!e.includes('Content Security Policy')),[]);
  console.log('PASS: Train tab: UNet / YOLO switch, YOLO settings and dataset check, start parameters, detector scores, best weights, settings kept per model');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();app.exit(process.exitCode||0);}
});
