// Real renderer/preload with an isolated profile and deterministic catalog fixture.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','recordings-ui-profile'));
let win,live=null,failRead=false,reads=0;
const watchdog=setTimeout(()=>{console.error('Recordings UI test timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 try {
  const pixels=Buffer.alloc(320*200*4,120),image=nativeImage.createFromBitmap(pixels,{width:320,height:200});
  const saved={id:'saved',name:'Saved demonstration',status:'complete',samples:120,inputEvents:2,invalidSamples:1,durationMs:8000,metadata:{started:1000,hz:15,observationSchema:{fields:[{name:'health',type:'number'}]},actionSchema:{buttons:[{id:'left',vk:37}]}}};
  const event=status=>win.webContents.send('runtime:event',{event:'recording',result:status});
  ipcMain.handle('runtime:available',()=>true);ipcMain.handle('runtime:status',()=>({ready:true,error:null}));
  ipcMain.handle('windows:thumbnails',()=>({}));ipcMain.handle('models:list',()=>[]);ipcMain.handle('models:probe',()=>null);
  ipcMain.handle('training:check-checkpoint',()=>({found:false}));ipcMain.handle('training:gpu-check',()=>({available:false}));
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'Recording fixture',pid:1}]};
   if(op==='frame'){await wait(40);return {dataUrl:image.toDataURL(),timestamp:Date.now(),jpeg:image.toJPEG(80)};}
   if(op==='record.start'){
    live={...saved,id:args.recordingId,name:args.name,status:'recording',samples:0,inputEvents:0,invalidSamples:0,durationMs:0};
    event({active:true,id:live.id,samples:0,queued:0});return {ok:true};
   }
   if(op==='record.stop'){live.status='complete';event({active:false,id:live.id,samples:live.samples});return {ok:true};}
   if(op==='dataset.list'){reads++;return {recordings:live?[live,saved]:[saved]};}
   if(op==='dataset.read'){
    reads++;if(failRead)throw Error('Fixture read failed');
    const item=args.recordingId==='saved'?saved:live;
    const total=args.stream==='inputs'?item.inputEvents:item.samples;
    const offset=args.tail?Math.max(0,total-args.limit):args.offset;
    const rows=Array.from({length:Math.max(0,Math.min(args.limit,total-offset))},(_,i)=>{
      const seq=offset+i+1;
      return args.stream==='inputs'?{seq,kind:'button',timestamp:1000+seq*20,vk:37,down:seq===1}
       :{seq,kind:'sample',timestamp:1000+seq*67,valid:seq!==5,observations:[{name:'health',type:'number',value:seq/100,valid:true}],actions:{valid:seq!==5,reason:seq===5?'Window not focused':undefined,buttons:{left:seq%2===1}}};
    });
    return {recording:{...item,rows,offset,total,stream:args.stream}};
   }
   return {ok:true};
  });
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error'&&!d.message.includes('Fixture read failed'))errors.push(d.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(100);};
  const button=async text=>{await js(`[...document.querySelectorAll('.recordings-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);await wait(100);};
  const tab=async name=>{await js(`[...document.querySelectorAll('.bottom-center-panel .panel-tab')].find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);await wait(100);};
  const first=`document.querySelector('.recordings-table tbody tr td')?.textContent`;
  const last=`document.querySelector('.recordings-table tbody tr:last-child td')?.textContent`;
  await win.loadFile(path.join(root,'dist/index.html'));await until(`!!document.querySelector('.win-item')`);
  await tab('Recordings');await until(`${first}==='1'`);
  assert.equal(await js(`document.querySelector('[role="tab"]').previousElementSibling.textContent`),'Values');
  assert.equal(await js(`document.querySelectorAll('.recordings-table tbody tr').length`),50);
  assert.match(await js(`document.querySelector('.recordings-table').textContent`),/health.*left/s);
  assert.match(await js(`document.querySelector('.recordings-table').textContent`),/Window not focused/);
  await button('Next');await until(`${first}==='51'`);await button('Next');await until(`${last}==='120'`);
  await click('.recordings-table tbody tr');assert.match(await js(`document.querySelector('.recordings-detail pre').textContent`),/"seq": 101/);
  await js(`(()=>{const e=document.querySelector('[aria-label="Recorded data stream"]');e.value='inputs';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`${last}==='2'`);
  assert.match(await js(`document.querySelector('.recordings-table').textContent`),/button/);
  await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Start Session').click()`);await until(`!!document.querySelector('.toolbar-actions .tbtn-record')`);
  await js(`(()=>{const e=document.querySelector('[aria-label="Recorded data stream"]');e.value='samples';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('.toolbar-actions .tbtn-record');await until(`document.querySelector('.recordings-live')?.textContent.includes('Recording live')`);
  live.samples=65;live.inputEvents=4;event({active:true,id:live.id,samples:65,queued:2});await until(`${last}==='65'`);assert.equal(await js(first),'16');
  await click('.recordings-controls input');live.samples=70;await until(`document.querySelector('.recordings-pagination').textContent.includes('of 70')`);assert.equal(await js(first),'16');
  await button('First');await until(`${first}==='1'`);live.samples=80;await until(`document.querySelector('.recordings-pagination').textContent.includes('of 80')`);assert.equal(await js(first),'1');
  await button('Latest');await until(`${last}==='80'`);assert.equal(await js(first),'31');
  assert.equal(await js(`(()=>{const e=document.querySelector('.recordings-table-wrap');return e.scrollHeight-e.scrollTop-e.clientHeight<3;})()`),true,'Follow latest did not scroll to incoming data');
  win.webContents.invalidate();await wait(150);fs.writeFileSync(path.join(root,'build/recordings-live.png'),(await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('.recordings-list button')].find(b=>b.textContent.includes('Saved demonstration')).click()`);await until(`document.querySelector('.recordings-summary strong').textContent==='Saved demonstration'`);
  await tab('Values');await wait(200);const at=reads;await wait(1200);assert.equal(reads,at,'Hidden dock kept polling');
  await tab('Recordings');await until(`document.querySelector('.recordings-summary strong').textContent==='Saved demonstration'`);
  failRead=true;await button('Refresh recordings');await until(`document.querySelector('.recordings-error')?.textContent.includes('Fixture read failed')`);
  failRead=false;await button('Refresh recordings');await until(`!document.querySelector('.recordings-error')`);
  await button('View live recording');await until(`${last}==='80'`);
  live.status='complete';event({active:false,id:live.id,samples:80});await until(`document.querySelector('.recordings-summary').textContent.includes('complete')`);
  assert.deepEqual(errors,[]);
  console.log('PASS: tab placement, saved data and input events, paging/details, committed live tail, follow/manual review, hidden polling, selection retention, stop refresh and error recovery.');
  clearTimeout(watchdog);win.destroy();app.exit(0);
 }catch(e){console.error(e);clearTimeout(watchdog);if(win&&!win.isDestroyed())fs.writeFileSync(path.join(root,'build/recordings-ui-failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}
});
