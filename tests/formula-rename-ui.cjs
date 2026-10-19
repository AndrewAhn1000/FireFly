// Renaming a formula by typing into its name with real key presses (not set values), including clearing it first and
// a space, which React Flow also uses (to pan)
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','formula-rename-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Formula rename UI timed out');app.exit(1);},60000);
const recording={id:'rec1',name:'Run',status:'complete',samples:100,invalidSamples:0,durationMs:10000,inputEvents:0,
  metadata:{started:1,hz:15,observationSchema:{identity:'obs',fields:[{name:'Mem Char Position',type:'vector'}]},actionSchema:{identity:'act',buttons:[{id:'k1',vk:49}]}}};
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op)=>op==='windows'?{windows:[]}:op==='dataset.list'?{recordings:[recording]}:op==='observe.fields'?{fields:recording.metadata.observationSchema.fields,excluded:[]}:{ok:true});
  ipcMain.handle('policy:invoke',(_,op,params)=>op==='models'?[]:op==='columns'?{groups:[],fields:[],formulas:(params.formulas??[]).map(f=>({name:f.name,source:f.source,type:'vector',columns:[f.name+'.x',f.name+'.y'],error:null})),grids:[],spatial:[],goals:[]}:{});
  win=new BrowserWindow({width:1400,height:900,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+what);};
  await win.loadFile(path.join(root,'dist/index.html'));
  const graph={version:1,nodes:[{id:'pos',type:'state',position:{x:0,y:0},data:{kind:'state',name:'Mem Char Position'}},
    {id:'f',type:'formula',position:{x:300,y:0},data:{kind:'formula',name:'formula 1',source:'p + vec(0, -5)',inputs:['p']}}],
    edges:[{id:'e',source:'pos',sourceHandle:'out',target:'f',targetHandle:'in:p'}]};
  // Two graphs holding a formula node with the same id (one pasted from the other), both opened this session
  const scope='firefly-policy-graph-%7Bsettings%7D';
  const other={...graph,nodes:graph.nodes.map(n=>n.id==='f'?{...n,data:{...n.data,name:'Player Pos'}}:n)};
  const library={version:1,selected:'nav',entries:[{id:'policies',parent:null,kind:'folder',name:'Policies'},{id:'nav',parent:'policies',kind:'policy',name:'Navigation'},{id:'combat',parent:'policies',kind:'policy',name:'Combat'}]};
  await js(`localStorage.clear();localStorage.setItem('${scope}-library',${JSON.stringify(JSON.stringify(library))});
    localStorage.setItem('${scope}-document-nav',${JSON.stringify(JSON.stringify(other))});localStorage.setItem('${scope}-document-combat',${JSON.stringify(JSON.stringify(graph))});0`);
  await win.reload();await wait(800);
  await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
  await wait(500);
  // Open the combat graph from the library (the navigation one stays mounted behind it)
  await js(`(()=>{const e=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent.trim()==='Combat');e.click();})();0`);
  await wait(600);
  const input=`[...document.querySelectorAll('.graph-page:not(.pg-off) .react-flow__node[data-id="f"] [aria-label="Formula name"]')][0]`;
  await until(input,'the formula');
  const key=async(keyCode,ch)=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(ch)win.webContents.sendInputEvent({type:'char',keyCode:ch});win.webContents.sendInputEvent({type:'keyUp',keyCode});await wait(30);};
  win.webContents.focus();
  await js(`(()=>{const i=${input};i.focus();i.select();})()`);
  for(let i=0;i<12;i++)await key('Backspace');
  assert.equal(await js(`${input}.value`),'','cleared');
  for(const ch of 'Player Pos')await key(ch===' '?'Space':ch, ch);
  assert.equal(await js(`${input}.value`),'Player Pos','typed, space and all');
  assert.equal(await js(`[...document.querySelectorAll('.graph-page.pg-off [aria-label="Formula name"]')][0].value`),'Player Pos','the other graph’s formula, with the same id, untouched');
  const logged=errors.filter(e=>!/DevTools|Autofill|ResizeObserver/.test(e));
  assert.equal(logged.length,0,'Console errors: '+logged.join(' | '));
  console.log('Formula rename UI: ok');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
