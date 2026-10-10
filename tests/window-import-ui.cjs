// Production renderer/preload, isolated profile, a mocked runtime. A window's setup is kept under its title, so
// the same game titled differently starts with none: a new window can start from another's setup, and a session
// can import one, part by part. Needs `npm run build`: electron tests/window-import-ui.cjs
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const profile=path.join(root,'build','window-import-ui-profile');
fs.rmSync(profile,{recursive:true,force:true});
app.setPath('userData',profile);
let win;
const watchdog=setTimeout(()=>{console.error('Window import UI timed out');app.exit(1);},60000);
const enc=encodeURIComponent,old='MapleStory - Scania',bera='MapleStory - Bera',reboot='MapleStory - Reboot';
app.whenReady().then(async()=>{
 try {
  for(const [channel,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(channel,()=>result);
  ipcMain.handle('policy:invoke',()=>[]);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'1',title:old,pid:1},{id:'2',title:bera,pid:2},{id:'3',title:reboot,pid:3}]};
   if(op==='observe.fields')return {fields:[]};
   if(op==='dataset.list')return {recordings:[]};
   if(op==='frame'){await wait(50);return {pending:true};}
   if(op==='memory.run_script')return {value:/-- nothing yet/.test(args.script)?null:7};
   return {};
  });
  win=new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw Error('UI condition failed: '+what);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.click()})()`);await wait(80);};
  const choose=async(label,value)=>{await js(`(()=>{const i=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(60);};
  const open=async title=>{await until(`[...document.querySelectorAll('.win-item')].some(w=>w.textContent.includes(${JSON.stringify(title)}))`);
   await js(`[...document.querySelectorAll('.win-item')].find(w=>w.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await wait(100);};
  const stateNames=()=>js(`[...document.querySelectorAll('.state-row .state-name')].map(n=>n.textContent)`);
  const stored=(prefix,title)=>js(`localStorage.getItem(${JSON.stringify(prefix+enc(title))})`);

  // The setup built on the old window: a Lua State, a memory State, a Lua Region, buttons and a graph
  const states=[{id:'hp',name:'HP',type:'number',source:'script',script:'return 7'},{id:'mp',name:'MP',type:'number',source:'memory',address:'0x10',byteType:'u32'},
    {id:'cam',name:'Camera',type:'vector',source:'script',script:'return nil -- nothing yet'}];
  const regions=[{id:'map',label:'Mini Map',x:0,y:0,w:0,h:0,templates:[],source:'script',script:'return {{x=0,y=0,w=10,h=10}}',scriptWidth:800,scriptHeight:600}];
  const library={version:1,selected:'g1',entries:[{id:'policies',parent:null,kind:'folder',name:'Policies'},{id:'g1',parent:'policies',kind:'policy',name:'Hunt'}]};
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();const set=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
   set('firefly-states-${enc(old)}',${JSON.stringify(states)});set('firefly-regions-${enc(old)}',${JSON.stringify(regions)});
   set('firefly-record-setup-${enc(old)}',{buttons:['left','right','alt'],hz:20});
   set('firefly-policy-graph-${enc(old)}-library',${JSON.stringify(library)});
   set('firefly-policy-graph-${enc(old)}-document-g1',{version:1,nodes:[],edges:[]});0`);
  win.reload();await wait(500);

  // A new window starts from the old one's setup, chosen as the session starts
  await open(bera);
  await until(`!!document.querySelector('[aria-label="Start with the setup of"]')`,'a new window is offered another’s setup');
  assert.match(await js(`document.querySelector('[aria-label="Start with the setup of"]').textContent`),/MapleStory - Scania \(3 states, 1 region, 1 graph\)/);
  await choose('Start with the setup of',old);
  await click('Start Session');
  await until(`document.querySelectorAll('.state-row').length===3`,'the States copied');
  assert.deepEqual(await stateNames(),['HP','MP','Camera']);
  assert.equal(await stored('firefly-states-',bera),await stored('firefly-states-',old));
  assert.equal(await stored('firefly-regions-',bera),await stored('firefly-regions-',old),'the Lua Region, with its script');
  assert.deepEqual(JSON.parse(await stored('firefly-record-setup-',bera)),{buttons:['left','right','alt'],hz:20});
  assert.equal(JSON.parse(await js(`localStorage.getItem('firefly-policy-graph-${enc(bera)}-library')`)).entries[1].name,'Hunt','the graphs');
  // A window with a setup of its own isn't offered another's
  await open(bera);
  await until(`!!document.querySelector('.modal-session-info')`);
  assert.equal(await js(`!!document.querySelector('[aria-label="Start with the setup of"]')`),false);
  assert.match(await js(`document.querySelector('.modal-session-info').textContent`),/3 states and 1 region/);
  await click('Cancel');

  // Started empty, a session imports a setup from the Inspector, only the parts chosen
  await open(reboot);
  await until(`!!document.querySelector('[aria-label="Start with the setup of"]')`);
  await click('Start Session');
  await until(`document.querySelector('.statusbar')?.textContent.includes(${JSON.stringify(reboot)})`,'capturing the third window');
  assert.deepEqual(await stateNames(),[]);
  await click('Import…');
  await until(`!!document.querySelector('[aria-label="Import a setup"]')`);
  assert.deepEqual(await js(`[...document.querySelectorAll('[aria-label="Import from"] option')].map(o=>o.value)`),[bera,old],'both windows with a setup');
  await choose('Import from',old);
  await js(`[...document.querySelectorAll('.import-part')].find(l=>l.textContent.startsWith('Recording setup')).querySelector('input').click()`);await wait(60);
  assert.match(await js(`document.querySelector('[aria-label="Import a setup"]').textContent`),/Replaces its 1 graph/);
  await click('Import');
  await until(`document.querySelectorAll('.state-row').length===3`,'the States imported');
  assert.deepEqual(await stateNames(),['HP','MP','Camera']);
  assert.equal(await stored('firefly-regions-',reboot),await stored('firefly-regions-',old));
  assert.notDeepEqual(JSON.parse(await stored('firefly-record-setup-',reboot)).buttons,['left','right','alt'],'the recording setup wasn’t chosen');
  await until(`JSON.parse(localStorage.getItem('firefly-policy-graph-${enc(reboot)}-library')??'{}').entries?.some(e=>e.name==='Hunt')`,'the graphs imported');
  // The Lua State imported runs, as it did on the old window
  await until(`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name')?.textContent==='HP')?.querySelector('.state-val-chip')?.textContent==='7'`,'the Lua State runs');
  // One whose script runs and returns nil, with no value before, has no value: that isn't a failed read
  const camera=`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name')?.textContent==='Camera')?.querySelector('.state-read-status')`;
  await until(`${camera}?.textContent==='No value'`,'a nil State says it has no value');
  assert.match(await js(`${camera}.title`),/returned nil: the script ran/);
  // The windows imported from keep their own
  assert.equal(await stored('firefly-states-',old),JSON.stringify(states));

  assert.deepEqual(errors,[]);
  console.log('PASS: a new window starts from another window’s setup (States, Lua Regions, recording setup, graphs); one with its own isn’t offered; Inspector Import copies the chosen parts, and the Lua State runs.');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);clearTimeout(watchdog);app.exit(1);}
});
