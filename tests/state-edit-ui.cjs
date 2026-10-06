// Production renderer/preload with an isolated profile and deterministic memory responses.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','state-edit-ui-profile'));
let win,lastScript,definitions=[],releasePreview,scriptValue=[{x:10,y:20,w:30,h:40}],holdLive=false,releaseLive,failLive=false,memoryValue=10;
const watchdog=setTimeout(()=>{console.error('State editing UI timed out');app.exit(1);},45000);
app.whenReady().then(async()=>{
 try {
  for(const [channel,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(channel,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'State editing fixture',pid:1}]};
   if(op==='observe.tracked'){definitions=args.observations;return {};}
   if(op==='observe.fields')return {fields:[]};
   if(op==='dataset.list')return {recordings:[]};
   if(op==='frame'){await wait(50);return {pending:true};}
   if(op==='memory.run_script'){
    if(args.stateId)lastScript=args;
    if(holdLive)await new Promise(r=>releaseLive=r);
    if(failLive)throw Error('Temporary script read failure');
    if(args.script==='return 999 -- delayed')await new Promise(r=>releasePreview=r);
    return {value:scriptValue};
   }
   if(op==='memory.read')return {value:memoryValue};
   return {};
  });
  win=new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.click()})()`);await wait(60);};
  const edit=async name=>{await js(`document.querySelector('[aria-label="Edit ${name}"]').click()`);await wait(80);};
  const input=async(label,value)=>{await js(`(()=>{const i=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(50);};
  const selectType=async value=>{await js(`(()=>{const i=document.querySelector('[aria-label="State type"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(50);};
  const key='firefly-states-State%20editing%20fixture';
  const saved=()=>js(`JSON.parse(localStorage.getItem('${key}'))`);
  const original=[{id:'mobs',name:'Monsters',type:'collection',source:'script',script:'return {{x=1,y=2,w=3,h=4}}'},{id:'hp',name:'HP',type:'number',source:'memory',address:'0x1000',offsets:['0x24','0x10'],byteType:'i32'}];
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();localStorage.setItem('${key}',${JSON.stringify(JSON.stringify(original))});localStorage.setItem('firefly-regions-State%20editing%20fixture',JSON.stringify([{id:'ui',label:'Mini Map',x:0,y:0,w:.2,h:.2,templates:[]}]))`);win.reload();await wait(500);
  await until(`document.querySelector('.win-item')`);await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await click('Start Session');
  await until(`document.querySelector('[aria-label="Edit Monsters"]')`);
  const monsterRow=`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name')?.textContent==='Monsters')`;
  await until(`${monsterRow}?.querySelector('.state-val-chip')?.textContent==='1 items'`);
  holdLive=true;
  for(let n=0;n<50&&!releaseLive;n++)await wait(20);assert.ok(releaseLive);
  await wait(150);
  assert.equal(await js(`${monsterRow}.querySelector('.state-val-chip').textContent`),'1 items','Pending reads must keep the last value');
  holdLive=false;releaseLive();
  scriptValue=null;
  await until(`${monsterRow}.querySelector('.state-read-status')?.textContent==='Last value'`);
  assert.equal(await js(`${monsterRow}.querySelector('.state-val-chip').textContent`),'1 items');
  failLive=true;await wait(120);
  assert.equal(await js(`${monsterRow}.querySelector('.state-val-chip').textContent`),'1 items');
  failLive=false;scriptValue=[];
  await until(`${monsterRow}.querySelector('.state-val-chip')?.textContent==='0 items'`);
  await until(`!${monsterRow}.querySelector('.state-read-status')`);
  memoryValue=0;
  await until(`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name')?.textContent==='HP')?.querySelector('.state-val-chip')?.textContent==='0'`);
  scriptValue=[{x:10,y:20,w:30,h:40}];
  await edit('Monsters');assert.equal(await js(`document.querySelector('[aria-label="State Lua script"]').value`),original[0].script);
  assert.ok(await js(`document.querySelector('.modal-title').textContent==='Edit State'`));
  await js(`(()=>{const i=document.querySelector('[aria-label="State Lua script"]');i.focus();i.setSelectionRange(0,0);i.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));})()`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="State Lua script"]').value`),'    '+original[0].script);
  await js(`document.querySelector('[aria-label="State Lua script"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="State Lua script"]').value`),original[0].script);
  await input('State Lua script','return regions.Mi');
  await until(`document.querySelector('[aria-label="Name suggestions"]')`);
  await js(`document.querySelector('[aria-label="State Lua script"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="State Lua script"]').value`),'return regions["Mini Map"]');
  // Memory and Lua States are suggested as states.Name, except the State being edited
  await input('State Lua script','return states.');
  await until(`document.querySelector('[aria-label="Name suggestions"]')`);
  assert.deepEqual(await js(`[...document.querySelectorAll('[aria-label="Name suggestions"] code')].map(c=>c.textContent)`),['states.HP']);
  await js(`document.querySelector('[aria-label="State Lua script"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('[aria-label="State Lua script"]').value`),'return states.HP');
  await click('Run Script');await wait(150);
  assert.deepEqual(lastScript.states.map(s=>[s.id,s.name,s.kind]),[['mobs','Monsters','script'],['hp','HP','memory']],'Scripts get the memory and Lua States');
  assert.equal(lastScript.stateId,'mobs','A State being edited is named, so it cannot read itself');
  assert.ok(await js(`document.querySelector('.modal-title')`),'Completion Enter must not submit the dialog');
  await input('State Lua script','return {{x=100,y=200,w=30,h=40}}');
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save Changes').disabled`));
  await input('State name','Enemy bounds');await click('Run Script');
  await until(`document.querySelector('.script-test-ok')`);
  await selectType('number');
  assert.ok(await js(`document.querySelector('.script-test-err')`),'Changing the declared type must revalidate the tested result');
  assert.match(await js(`document.querySelector('.modal-overlay .sv-err').textContent`),/Expected Number.*Lua returned a list/);
  fs.writeFileSync(path.join(root,'build','state-type-error-ui.png'),(await win.webContents.capturePage()).toPNG());
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save Changes').disabled`));
  await js(`document.querySelector('[aria-label="State name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.deepEqual(await saved(),original,'Enter bypassed type validation');
  await click('Run Script');await until(`document.querySelector('.script-test-err')`);
  await selectType('collection');await until(`document.querySelector('.script-test-ok')`);
  await click('Save Changes');await wait(220);
  const changed=await saved();assert.equal(changed.length,2);assert.equal(changed[0].id,'mobs');assert.equal(changed[0].name,'Enemy bounds');assert.equal(changed[0].type,'collection');assert.equal(changed[0].script,'return {{x=100,y=200,w=30,h=40}}');assert.equal(changed[0].observationName,'Monsters');
  assert.ok(definitions.some(d=>d.name==='Monsters'&&d.script===changed[0].script),'Runtime did not get the updated script with its stable observation name');
  scriptValue=42;
  await until(`[...document.querySelectorAll('.state-row')].some(row=>row.textContent.includes('Enemy bounds')&&row.textContent.includes('Invalid type')&&!(row=>{const dt=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));row.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return dt.types.includes('application/firefly-node');})(row))`);
  scriptValue=[{x:10,y:20,w:30,h:40}];
  await until(`[...document.querySelectorAll('.state-row')].some(row=>row.textContent.includes('Enemy bounds')&&!row.textContent.includes('Invalid type')&&(row=>{const dt=new DataTransfer();row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));row.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return dt.types.includes('application/firefly-node');})(row))`);
  await edit('Enemy bounds');await input('State Lua script','return 123');await click('Cancel');assert.deepEqual(await saved(),changed);
  await edit('Enemy bounds');await input('State Lua script','return 999 -- delayed');await click('Run Script');
  for(let n=0;n<40&&!releasePreview;n++)await wait(25);assert.ok(releasePreview);
  await input('State Lua script','return 888');releasePreview();await wait(100);
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save Changes').disabled`),'An old preview validated changed code');
  await click('Cancel');await edit('HP');
  assert.equal(await js(`document.querySelector('input[placeholder="0x00000000"]')?.value ?? [...document.querySelectorAll('.modal-form-input')].find(i=>i.value==='0x1000')?.value`),'0x1000');
  await input('State name','Health');await click('Save Changes');await wait(100);
  const memory=(await saved())[1];assert.equal(memory.id,'hp');assert.deepEqual(memory.offsets,['0x24','0x10']);assert.equal(memory.byteType,'i32');assert.equal(memory.observationName,'HP');
  win.webContents.send('runtime:event',{event:'recording',result:{active:true,id:'r',samples:0,invalidSamples:0,inputEvents:0}});await wait(100);
  assert.ok(await js(`document.querySelector('[aria-label="Edit Enemy bounds"]').disabled`));
  win.webContents.send('runtime:event',{event:'recording',result:{active:false}});await wait(80);await edit('Enemy bounds');
  fs.writeFileSync(path.join(root,'build','state-edit-ui.png'),(await win.webContents.capturePage()).toPNG());
  console.log('PASS: editing Lua and memory States, type mismatches including type changes and Enter, stable identity/names, persistence, cancel, script-preview race, and recording lock');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();app.exit(process.exitCode||0);}
});
