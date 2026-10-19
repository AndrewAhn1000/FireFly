// Planner node: a graph from before it (a Goal following a recording's route) comes back with a Planner doing that,
// wired into the Goal's Target; the Planner's route and aim reach the worker as the Goal's route; what can be wired to
// and from it; and one dropped from the palette. Needs `npm run build`
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','planner-node-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Planner UI timed out');app.exit(1);},60000);
const asked={preview:[],plan:[]};
const fields=[{name:'Player',type:'vector'},{name:'Face Left',type:'boolean'},{name:'platforms',type:'shapes'},{name:'hp',type:'number'}];
const recording=(id,name,started)=>({id,name,status:'complete',samples:100,invalidSamples:0,durationMs:30000,inputEvents:0,
  metadata:{started,hz:15,observationSchema:{identity:'obs',fields},actionSchema:{identity:'act',buttons:[{id:'k1',vk:49}]}}});
const recordings=[recording('old','First run',1),recording('new','Second run',2)];
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op)=>op==='windows'?{windows:[]}:op==='dataset.list'?{recordings}:op==='observe.fields'?{fields,excluded:[]}:{ok:true});
  ipcMain.handle('policy:invoke',(_,op,params)=>{
    if(op==='models')return [];
    if(op==='columns')return {groups:[],fields:[],formulas:[],grids:[],spatial:[],goals:(params.goals??[]).map(g=>({name:g.name,columns:[`${g.name}.forward`,`${g.name}.dy`,`${g.name}.dist`],values:null,moved:null,error:null}))};
    // The planner's map: places along a floor and up a ledge, the way there once a destination is chosen
    if(op==='planner.preview'){asked.plan.push(params);const dest=params.goal.plan.destination;
      const places=[[0,200],[40,200],[80,200],[120,200],[160,100],[200,100]];
      return {places,moves:[[0,1],[1,2],[2,3],[3,4],[4,5]],count:{places:6,moves:5},recordings:params.recordingIds.length,level:null,error:null,
        position:[0,200],destination:dest?[200,100]:null,path:dest?places:null,target:dest?[80,200]:null,next:dest?{keys:['right'],ms:200,seen:7}:null,seconds:dest?1.4:null};}
    if(op==='preview'){asked.preview.push(params);return {samples:900,stepMs:66,recordings:[{id:'old',rows:900}],skipped:[],skippedReasons:{},values:params.columns,inputs:params.columns.length,buttons:[{id:'k1',pressed:.3}]};}
    return {};
  });
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+what);};
  await win.loadFile(path.join(root,'dist/index.html'));
  // A graph from before the Planner: the Goal follows the first run's route, and a target State was wired in too
  const state=(id,name,y)=>({id,type:'state',position:{x:0,y},data:{kind:'state',name}});
  const graph={version:1,nodes:[state('player','Player',0),state('face','Face Left',120),state('hp','hp',240),state('floor','platforms',360),
    {id:'goal',type:'goal',position:{x:500,y:0},data:{kind:'goal',name:'goal',lookAhead:[1,4],targets:3,minMove:20,route:{recording:'old',aheadS:2.5}}},
    {id:'near',type:'spatial',position:{x:250,y:400},data:{kind:'spatial',name:'near',inputs:['platforms'],radii:[100,250,500],maxDistance:1000}},
    {id:'recs',type:'recordings',position:{x:500,y:600},data:{kind:'recordings',ids:['old']}},
    {id:'pol',type:'policy',position:{x:900,y:0},data:{kind:'policy',name:'Navigate',buttons:null,off:[],stepMs:null,history:0,delayMs:0,epochs:60}}],
    edges:[{id:'e1',source:'player',sourceHandle:'out',target:'goal',targetHandle:'in:@position'},{id:'e2',source:'face',sourceHandle:'out',target:'goal',targetHandle:'in:@facing'},
      {id:'e3',source:'player',sourceHandle:'out',target:'goal',targetHandle:'in:@target'},
      {id:'e4',source:'goal',sourceHandle:'out',target:'pol',targetHandle:'values'},{id:'e5',source:'hp',sourceHandle:'out',target:'pol',targetHandle:'values'},{id:'e5b',source:'face',sourceHandle:'out',target:'pol',targetHandle:'values'},
      {id:'e6',source:'recs',sourceHandle:'data',target:'pol',targetHandle:'data'},
      {id:'e7',source:'player',sourceHandle:'out',target:'near',targetHandle:'in:@point'},{id:'e8',source:'floor',sourceHandle:'out',target:'near',targetHandle:'in:platforms'}]};
  await js(`localStorage.clear();localStorage.setItem('firefly-policy-graph-%7Bsettings%7D',${JSON.stringify(JSON.stringify(graph))});0`);
  await win.reload();await wait(600);
  await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
  const goal=`document.querySelector('.react-flow__node[data-id="goal"]')`,planner=`document.querySelector('.react-flow__node-planner')`;
  await until(planner,'a Planner made for the Goal that followed a route');
  assert.match(await js(`${goal}.textContent`),/Target: planner \(follows a recording\)/);
  assert.ok(!(await js(`${goal}.querySelector('[aria-label="Play goes"]')`)),'the route choice left the Goal');
  assert.equal(await js(`${planner}.querySelector('[aria-label="Route recording"]').value`),'old');
  assert.equal(await js(`${planner}.querySelector('[aria-label="Aim ahead"]').value`),'2.5');
  assert.deepEqual(await js(`[...${planner}.querySelectorAll('[aria-label="Planner mode"] option')].map(o=>[o.value,o.disabled])`),[['route',false],['plan',false]]);
  // The worker gets the route as the Goal's, as before the Planner, and no target
  for(let i=0;i<80&&!asked.preview.length;i++)await wait(50);
  await wait(900);
  let request=asked.preview.at(-1);
  assert.deepEqual(request.goal,{name:'goal',position:'Player',facing:'Face Left',route:{recording:'old',aheadS:2.5},lookAhead:[1,4],targets:3,minMove:20});
  // Saved converted: the Goal without its route, the Planner wired into its Target in place of the State
  await wait(400);
  const saved=JSON.parse(await js(`(()=>{const s='firefly-policy-graph-%7Bsettings%7D',id=JSON.parse(localStorage.getItem(s+'-library')).selected;return localStorage.getItem(s+'-document-'+id);})()`));
  assert.equal(saved.nodes.find(n=>n.id==='goal').data.route,undefined);
  const p=saved.nodes.find(n=>n.data.kind==='planner');
  assert.deepEqual(saved.edges.filter(e=>e.target==='goal'&&e.targetHandle==='in:@target').map(e=>e.source),[p.id]);
  // Another recording and a further aim reach the worker; aiming past the Goal's look-ahead is pointed out
  const choose=async(label,value)=>{await js(`(()=>{const s=${planner}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'${value}');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(80);};
  const type=async(label,value)=>{await js(`(()=>{const i=${planner}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${value}');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(80);};
  await choose('Route recording','new');await type('Aim ahead','6');
  await until(`${planner}.textContent.includes('Aim ahead within the Goal')`,'aiming past the look-ahead pointed out');
  for(let i=0;i<60&&asked.preview.at(-1).goal?.route?.aheadS!==6;i++)await wait(50);
  assert.deepEqual(asked.preview.at(-1).goal.route,{recording:'new',aheadS:6});
  // Wiring: a Spatial node into its Map; a State can't be its Map; its output only into a Goal's Target
  const wire=async(from,to,handle,fromHandle='.react-flow__handle.source')=>js(`(()=>{
    const source=document.querySelector('.react-flow__node[data-id="${from}"] ${fromHandle}');
    const target=document.querySelector('.react-flow__node[data-id="${to}"] [data-handleid="${handle}"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  await wire('hp',p.id,'in:@map');await wait(200);
  assert.match(await js(`${planner}.textContent`),/Map \(optional\)/,'a State was taken as its map');
  await wire('near',p.id,'in:@map');
  await until(`${planner}.textContent.includes('Map: near')`,'a Spatial node as its map');
  await wire(p.id,'pol','values');await wait(200);
  assert.ok(!(await js(`[...document.querySelectorAll('.react-flow__node[data-id="pol"] .pg-value b')].some(b=>b.textContent==='planner')`)),'a Planner taken as a value');
  // One dropped from the palette starts on the newest recording
  await js(`(()=>{const item=[...document.querySelectorAll('.pg-palette-item')].find(i=>i.textContent.includes('Planner'));
    const t=new DataTransfer();item.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:t}));
    const c=document.querySelector('.pg-canvas'),r=c.getBoundingClientRect();
    c.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:t,clientX:r.x+40,clientY:r.y+r.height-60}));})()`);
  await until(`document.querySelectorAll('.react-flow__node-planner').length===2`,'a Planner dropped');
  const dropped=`[...document.querySelectorAll('.react-flow__node-planner')].find(n=>n.querySelector('[aria-label="Planner name"]').value==='planner 2')`;
  assert.equal(await js(`${dropped}.querySelector('[aria-label="Route recording"]').value`),'new');
  assert.match(await js(`${dropped}.textContent`),/Wire it into a Goal's Target/);
  // Plan from what I've done: the map from the policy's recordings, a destination clicked on it reaching the worker
  await choose('Planner mode','plan');
  await until(`${planner}.querySelector('[aria-label="Planner map"]')`,'its map');
  let plan=asked.plan.at(-1);
  assert.equal(plan.goal.position,'Player');
  assert.deepEqual(plan.recordingIds,['old'],'the policy’s recordings');
  assert.equal(plan.goal.plan.destination,undefined,'no destination yet');
  assert.match(await js(`${planner}.textContent`),/6 places · 5 moves from 1 recording/);
  await until(`document.querySelector('.react-flow__node[data-id="pol"]').textContent.includes('click its map where play heads')`,'no destination yet is a problem');
  await wait(300);
  {const r=await js(`(()=>{const b=${planner}.getBoundingClientRect();return [b.x,b.y,b.width,b.height].map(Math.round)})()`);
   require('node:fs').writeFileSync(path.join(root,'build','planner-node-ui.png'),(await win.webContents.capturePage({x:Math.max(0,r[0]-10),y:Math.max(0,r[1]-10),width:r[2]+20,height:r[3]+20})).toPNG());}
  await js(`${planner}.querySelector('.pg-spatial-open').click()`);
  const dialog=`document.querySelector('[role="dialog"][aria-label^="Preview of planner"]')`;
  await until(`${dialog}&&${dialog}.querySelector('canvas[aria-label="Planner preview"]')`,'the preview');
  // A real click (mouse input to the window, as a person's), not events made up in the page
  {const [x,y]=await js(`(()=>{const r=${dialog}.querySelector('canvas[aria-label="Planner preview"]').getBoundingClientRect();return [Math.round(r.x+r.width*0.8),Math.round(r.y+r.height*0.3)]})()`);
   win.webContents.focus();
   win.webContents.sendInputEvent({type:'mouseMove',x,y});await wait(50);
   win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await wait(60);
   win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await wait(100);}
  for(let i=0;i<80&&!asked.plan.at(-1).goal.plan.destination;i++)await wait(50);
  plan=asked.plan.at(-1);
  assert.equal(plan.goal.plan.destination.kind,'point');
  assert.ok(Number.isFinite(plan.goal.plan.destination.x)&&Number.isFinite(plan.goal.plan.destination.y),'a point on the map');
  await until(`${dialog}.textContent.includes('The way there: 1.4 s')`,'the way there in the preview');
  require('node:fs').writeFileSync(path.join(root,'build','planner-preview-ui.png'),(await win.webContents.capturePage()).toPNG());
  assert.match(await js(`${dialog}.textContent`),/next: → · 0\.2 s · seen 7×/);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(`!${dialog}`,'closed');
  // The node's own map: a real click there moves the destination; Refresh asks the worker again
  const before=JSON.stringify(asked.plan.at(-1).goal.plan.destination);
  {const [x,y]=await js(`(()=>{const r=${planner}.querySelector('[aria-label="Planner map"]').getBoundingClientRect();return [Math.round(r.x+r.width*0.2),Math.round(r.y+r.height*0.7)]})()`);
   win.webContents.sendInputEvent({type:'mouseMove',x,y});await wait(50);
   win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await wait(60);
   win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await wait(100);}
  for(let i=0;i<80&&JSON.stringify(asked.plan.at(-1).goal.plan.destination)===before;i++)await wait(50);
  assert.notEqual(JSON.stringify(asked.plan.at(-1).goal.plan.destination),before,'a click on the node’s map moved the destination');
  assert.equal(asked.plan.at(-1).goal.plan.destination.kind,'point');
  const asks=asked.plan.length;
  await js(`[...${planner}.querySelectorAll('.pg-spatial-refresh button')].find(b=>b.textContent==='Refresh').click()`);
  for(let i=0;i<60&&asked.plan.length===asks;i++)await wait(50);
  assert.ok(asked.plan.length>asks,'Refresh asked the worker again');
  for(let i=0;i<80&&!asked.preview.at(-1).goal?.plan;i++)await wait(50);
  request=asked.preview.at(-1);
  assert.deepEqual(Object.keys(request.goal.plan).sort(),['aheadS','cell','destination']);
  assert.equal(request.goal.route,undefined);
  // Heading for where a recording ended; a Level and a Destination wired in
  await choose('Plan destination','end');
  for(let i=0;i<80&&asked.preview.at(-1).goal?.plan?.destination?.kind!=='end';i++)await wait(50);
  assert.deepEqual(asked.preview.at(-1).goal.plan.destination,{kind:'end',recording:'new'});
  await wire('hp',p.id,'in:@level');
  await until(`${planner}.textContent.includes('Level: hp')`,'a level');
  await wire('player',p.id,'in:@destination');
  await until(`${planner}.textContent.includes('Destination: Player')`,'a destination');
  await choose('Plan destination','input');
  for(let i=0;i<80&&asked.preview.at(-1).goal?.plan?.destination?.kind!=='input';i++)await wait(50);
  assert.deepEqual(asked.preview.at(-1).goal.plan,{cell:40,aheadS:2.5,level:'hp',destination:{kind:'input',name:'Player'}});
  // Keep away from, learning from failure, and the plan's next move as the policy's values reach the worker
  await js(`${planner}.querySelector('[aria-label="Shapes to keep away from"] input').click()`);
  await js(`${planner}.querySelector('[aria-label="Learn from failure"]').click()`);
  for(let i=0;i<80&&asked.preview.at(-1).goal?.plan?.learn!==false;i++)await wait(50);
  assert.deepEqual([asked.preview.at(-1).goal.plan.avoid,asked.preview.at(-1).goal.plan.learn],[[{alias:'platforms',shapes:['platforms']}],false]);
  assert.equal(asked.preview.at(-1).goal.hint,undefined);
  await js(`${goal}.querySelector('[aria-label="Plan next move as values"]').click()`);
  for(let i=0;i<80&&!asked.preview.at(-1).goal?.hint;i++)await wait(50);
  assert.equal(asked.preview.at(-1).goal.hint,true);
  assert.match(await js(`${goal}.textContent`),/Adds next\.<button> and soon\.<button>/);
  const logged=errors.filter(e=>!/DevTools|Autofill|ResizeObserver loop/.test(e));
  assert.equal(logged.length,0,'Console errors: '+logged.join(' | '));
  console.log('Planner node UI: ok');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
