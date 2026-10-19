// A policy's versions are filed by its Policy node's id, so a graph pasted from another trains the same policy: the
// Policy node says so and can be made its own policy, Paste gives a Policy node another graph has a new id, and the
// Play tab names each policy by its node's name now and the graph it's in. Needs `npm run build`
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','policy-identity-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Policy identity UI timed out');app.exit(1);},60000);
const version=(id,created,policy)=>({id,created,version:3,trainingSamples:800,validationSamples:200,stepMs:66,policy,observationSchema:{identity:'obs'},actionSchema:{identity:'act'},
  buttons:[{button:'right',precision:.8,recall:.8,f1:.8,pressed:.3}],outputs:[{id:'right',vk:39}],config:{recordingIds:['r1'],columns:['x'],buttons:['right'],stepMs:66,history:0,actionDelayMs:0,epochs:5}});
const versions=[version('v1',100,{id:'P1',name:'Policy 1'}),version('v2',200,{id:'P1',name:'Policy 1'})];
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  const image=nativeImage.createFromBitmap(Buffer.alloc(320*200*4,90),{width:320,height:200}); // the game, for a session
  ipcMain.handle('runtime:invoke',async(_,op)=>{
    if(op==='windows')return {windows:[{id:'123',title:'Test Game',pid:1}]};
    if(op==='frame'){await wait(20);return {dataUrl:image.toDataURL(),timestamp:Date.now(),width:320,height:200};}
    return op==='dataset.list'?{recordings:[]}:op==='observe.fields'?{fields:[],excluded:[]}:{ok:true};
  });
  ipcMain.handle('policy:invoke',(_,op)=>op==='models'?versions:{});
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+what);};
  const click=async text=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab,.panel-tab-click')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click()})()`);await wait(100);};
  await win.loadFile(path.join(root,'dist/index.html'));
  // Two graphs, the second pasted from the first: their Policy nodes are one policy, P1
  const scope='firefly-policy-graph-%7Bsettings%7D';
  const graph=name=>({version:1,edges:[],nodes:[{id:'P1',type:'policy',position:{x:400,y:0},data:{kind:'policy',name,buttons:null,off:[],stepMs:null,history:0,delayMs:0,epochs:60}}]});
  const library={version:1,selected:'gB',entries:[{id:'policies',parent:null,kind:'folder',name:'Policies'},{id:'gA',parent:'policies',kind:'policy',name:'Combat graph'},{id:'gB',parent:'policies',kind:'policy',name:'Navigation graph'}]};
  await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem('${scope}-library',${JSON.stringify(JSON.stringify(library))});
    localStorage.setItem('${scope}-document-gA',${JSON.stringify(JSON.stringify(graph('Combat')))});localStorage.setItem('${scope}-document-gB',${JSON.stringify(JSON.stringify(graph('Policy 1')))})`);
  await win.reload();
  await wait(600);
  const tab=async name=>{await js(`[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent.trim()===${JSON.stringify(name)}).click()`);await wait(150);};
  // The Play tab: the policy by its Policy node's name now (its versions say Policy 1), in both graphs
  await tab('Play');
  const header=`document.querySelector('.play-group-hd')`;
  await until(`${header}&&${header}.textContent.includes('Combat')`,'the policy by its node’s name');
  assert.match(await js(`${header}.textContent`),/^Combat · Combat graph, Navigation graph2 versions$/);
  // The pasted graph's Policy node says it's the same policy, and is made its own
  await click('Graphs');
  const node=`document.querySelector('.react-flow__node[data-id="P1"]')`;
  await until(`${node}&&${node}.textContent.includes('same policy as the Policy node in “Combat graph”')`,'the shared policy warning');
  await click('Make it its own policy');
  await until(`!document.querySelector('.react-flow__node[data-id="P1"]')`,'a new id');
  const own=`document.querySelector('.react-flow__node.react-flow__node-policy')`;
  await until(`${own}&&!${own}.textContent.includes('same policy')`,'the warning gone');
  for(let i=0;i<40&&JSON.parse(await js(`localStorage.getItem('${scope}-document-gB')`)).nodes[0].id==='P1';i++)await wait(50);
  const saved=JSON.parse(await js(`localStorage.getItem('${scope}-document-gB')`));
  assert.notEqual(saved.nodes[0].id,'P1');
  // The versions stay with the Combat graph
  await tab('Play');
  await until(`${header}.textContent==='Combat · Combat graph2 versions'`,'the versions with the other graph alone');
  // Pasting the Combat graph again: its Policy node gets a new id, since the Combat graph has P1
  await click('Graphs');
  // a hidden window can't read the clipboard, so it's handed the copied graph
  await js(`window.confirm=()=>true;navigator.clipboard.readText=async()=>${JSON.stringify(JSON.stringify(graph('Combat')))};0`);
  await click('Paste graph');
  await until(`${own}&&${own}.querySelector('[aria-label="Policy name"]').value==='Combat'`,'the pasted graph');
  assert.ok(!(await js(`!!document.querySelector('.react-flow__node[data-id="P1"]')`)),'the pasted Policy node kept P1');
  assert.ok(!(await js(`${own}.textContent.includes('same policy')`)));
  const logged=errors.filter(e=>!/DevTools|Autofill|ResizeObserver loop/.test(e));
  assert.equal(logged.length,0,'Console errors: '+logged.join(' | '));
  console.log('Policy identity UI: ok');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
