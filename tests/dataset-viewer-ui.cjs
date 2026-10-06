// Dataset preview from a Dataset Output node: saved images in order, their label boxes, next/previous, split filter
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
const {listDataset,readItem,deleteItem}=require('../electron/datasetPreview.cjs');
const deleted=[];
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','dataset-viewer-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Dataset viewer UI timed out');app.exit(1);},45000);
// A dataset of three solid images (the oldest last on disk by name), labels for two, and its class names
function makeDataset(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ff-viewer-'));
  const solid=(r,g,b)=>{const px=Buffer.alloc(200*150*4);for(let i=0;i<px.length;i+=4){px[i]=b;px[i+1]=g;px[i+2]=r;px[i+3]=255;}return nativeImage.createFromBitmap(px,{width:200,height:150}).toPNG();};
  const put=(rel,content,when)=>{const f=path.join(dir,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);if(when)fs.utimesSync(f,when,when);};
  put('data.yaml','names:\n  0: screen_monsters\n  1: screen_npcs\n  2: screen_portals\nnc: 3\n');
  put('images/train/1000000/000002.png',solid(40,120,60),new Date(2000));
  put('images/train/1000000/000001.png',solid(60,60,140),new Date(1000));
  put('images/val/1010000/000003.png',solid(120,80,40),new Date(3000));
  put('labels/train/1000000/000001.txt','0 0.25 0.5 0.2 0.2\n1 0.75 0.5 0.1 0.4\n2 0.5 0.2 0.3 0.2\n');
  put('labels/train/1000000/000001.json',JSON.stringify({trigger:'While new',savedAt:'2026-10-04T22:12:14Z'}));
  put('labels/train/1000000/000002.txt','');
  return dir;
}
app.whenReady().then(async()=>{
 const dataset=makeDataset();
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',(_,op)=>op==='windows'?{windows:[]}:op==='dataset.list'?{recordings:[]}:op==='observe.fields'?{fields:[]}:{});
  ipcMain.handle('policy:invoke',(_,op)=>op==='models'?[]:{});
  ipcMain.handle('dataset:list',(_,directory)=>listDataset(directory));
  ipcMain.handle('dataset:item',(_,directory,relative)=>readItem(directory,relative));
  // As main does, with the files removed instead of sent to the Recycle Bin, and one table row each
  ipcMain.handle('dataset:delete',async(_,directory,relative)=>{deleted.push([directory,relative]);const done=await deleteItem(directory,relative,async f=>fs.rmSync(f));return {files:done.files.length,rows:1,rowsError:''};});
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async code=>{for(let i=0;i<80;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(100);};
  const input=async(label,value)=>{await js(`(()=>{const i=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(80);};
  const key=async k=>{await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}));0`);await wait(150);};
  const count=()=>js(`document.querySelector('.dataset-viewer-count').textContent`);
  const shown=()=>js(`document.querySelector('.dataset-viewer-ft code').textContent`);
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game')`);
  win.reload();await wait(600);await click('Graphs');
  await click('+ Collection');await input('Graph name','Shots');await click('Save');
  await until(`document.querySelector('.collection-editor')`);
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview images').disabled`),'No folder, no preview');
  await input('Dataset folder',dataset);
  await click('Preview images');
  await until(`document.querySelector('.dataset-viewer img')`);
  // The oldest first, with its three boxes and their classes
  assert.equal(await count(),'1 / 3');
  assert.equal(await shown(),'images/train/1000000/000001.png');
  assert.equal(await js(`document.querySelectorAll('.dataset-box').length`),3);
  assert.deepEqual(await js(`[...document.querySelectorAll('.dataset-box span')].map(s=>s.textContent)`),['screen_monsters','screen_npcs','screen_portals']);
  assert.equal(await js(`document.querySelector('.dataset-box').style.left`),'15%','Centre 0.25, width 0.2: left edge at 15%');
  assert.ok(await js(`document.querySelector('.dataset-viewer-ft').textContent.includes('While new')`));
  fs.writeFileSync(path.join(root,'build','dataset-viewer-ui.png'),(await win.webContents.capturePage()).toPNG());
  // Next, the arrow keys, and the ends
  await click('Next ▶');await until(`document.querySelector('.dataset-viewer-ft code').textContent.endsWith('000002.png')`);
  assert.equal(await count(),'2 / 3');
  assert.ok(await js(`document.querySelector('.dataset-viewer-legend').textContent.includes('No boxes (background)')`));
  await key('ArrowRight');await until(`document.querySelector('.dataset-viewer-ft code').textContent.endsWith('000003.png')`);
  assert.equal(await count(),'3 / 3');
  assert.ok(await js(`document.querySelector('.dataset-viewer-legend').textContent.includes('No label file')`));
  assert.ok(await js(`document.querySelector('[aria-label="Next image"]').disabled`),'Next stops at the last image');
  await key('Home');assert.equal(await count(),'1 / 3');
  await key('ArrowLeft');assert.equal(await count(),'1 / 3','Previous stops at the first image');
  // Only the validation images, and labels hidden
  await js(`(()=>{const s=document.querySelector('[aria-label="Split"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'val');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.querySelector('.dataset-viewer-ft code').textContent.endsWith('000003.png')`);
  assert.equal(await count(),'1 / 1');
  await js(`document.querySelector('.dataset-viewer-hd input[type=checkbox]').click()`);await wait(80);
  assert.equal(await js(`document.querySelectorAll('.dataset-box').length`),0);
  // Deleting: back to every image, delete the first; it leaves the list and the next one takes its place
  await js(`(()=>{const s=document.querySelector('[aria-label="Split"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'all');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.querySelector('.dataset-viewer-ft code').textContent.endsWith('000001.png')`);
  await js(`window.confirm=()=>false;0`);await click('Delete image');
  assert.equal(await count(),'1 / 3','Cancelled: nothing deleted');
  await js(`window.confirm=()=>true;0`);await click('Delete image');
  await until(`document.querySelector('.dataset-viewer-count').textContent==='1 / 2'`);
  await until(`document.querySelector('.dataset-viewer-ft code').textContent.endsWith('000002.png')`);
  assert.deepEqual(deleted,[[dataset,'images/train/1000000/000001.png']]);
  assert.ok(!fs.existsSync(path.join(dataset,'images/train/1000000/000001.png'))&&!fs.existsSync(path.join(dataset,'labels/train/1000000/000001.txt')));
  assert.ok(await js(`document.querySelector('.dataset-viewer-notice').textContent==='Moved 3 files to the Recycle Bin · 1 table row deleted'`));
  await key('Delete');await until(`document.querySelector('.dataset-viewer-count').textContent==='1 / 1'`);
  await key('Escape');
  assert.equal(await js(`document.querySelector('.dataset-viewer')`),null,'Escape closes the preview');
  assert.deepEqual(errors.filter(e=>!e.includes('No handler registered')&&!e.includes('Content Security Policy')),[]);
  console.log('PASS: dataset preview: saved images oldest first, label boxes with class names, next/previous/arrow keys/Home, split filter, labels toggle, delete (button, Delete key, cancel), Escape');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();fs.rmSync(dataset,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
