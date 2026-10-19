// Goal node in the Policy Graph: its position, facing and target wired, what the worker is asked for (columns,
// preview) and what the node and the Policy node show
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','goal-node-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Goal UI timed out');app.exit(1);},60000);
const asked={columns:[],preview:[]};
const recording={id:'rec1',name:'Run',status:'complete',samples:100,invalidSamples:0,durationMs:10000,inputEvents:0,
  metadata:{started:1,hz:15,observationSchema:{identity:'obs',fields:[{name:'Player',type:'vector'},{name:'Face Left',type:'boolean'},{name:'Waypoint',type:'vector'},{name:'hp',type:'number'}]},
    actionSchema:{identity:'act',buttons:[{id:'k1',vk:49}]}}};
// The worker's columns op, as observations.py names a goal's columns (goal_names)
const goalColumns=g=>[`${g.name}.${g.facing?'forward':'dx'}`,`${g.name}.dy`,`${g.name}.dist`];
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op)=>{
    if(op==='windows')return {windows:[{id:'123',title:'Test Game',pid:1}]};
    if(op==='dataset.list')return {recordings:[recording]};
    if(op==='observe.fields')return {fields:recording.metadata.observationSchema.fields,excluded:[]};
    return {ok:true};
  });
  ipcMain.handle('policy:invoke',(_,op,params)=>{
    if(op==='models')return [];
    if(op==='columns'){asked.columns.push(params);
      return {groups:[],fields:[],formulas:[],grids:[],spatial:[],goals:(params.goals??[]).map(g=>({name:g.name,columns:goalColumns(g),values:g.target?[120,-30,123.7]:null,moved:180,error:null}))};}
    if(op==='preview'){asked.preview.push(params);return {samples:900,stepMs:66,recordings:[{id:'rec1',rows:2400}],skipped:[],skippedReasons:{},values:params.columns,inputs:params.columns.length,buttons:[{id:'k1',pressed:.3}]};}
    return {};
  });
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+what);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(80);};
  await win.loadFile(path.join(root,'dist/index.html'));
  const state=(id,name,y)=>({id,type:'state',position:{x:0,y},data:{kind:'state',name}});
  const graph={version:1,nodes:[state('player','Player',0),state('face','Face Left',120),state('way','Waypoint',240),state('hp','hp',360),
    {id:'goal',type:'goal',position:{x:320,y:0},data:{kind:'goal',name:'goal',lookAhead:[1,4],targets:3,minMove:20}},
    {id:'recs',type:'recordings',position:{x:320,y:600},data:{kind:'recordings',ids:['rec1']}},
    {id:'pol',type:'policy',position:{x:760,y:0},data:{kind:'policy',name:'Navigate',buttons:null,off:[],stepMs:null,history:0,delayMs:0,epochs:60}}],
    edges:[{id:'e1',source:'player',sourceHandle:'out',target:'goal',targetHandle:'in:@position'},
      {id:'e3',source:'goal',sourceHandle:'out',target:'pol',targetHandle:'values'},{id:'e4',source:'recs',sourceHandle:'data',target:'pol',targetHandle:'data'},
      {id:'e5',source:'hp',sourceHandle:'out',target:'pol',targetHandle:'values'}]};
  await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem('firefly-states-%7Bsettings%7D',JSON.stringify([{id:'s1',name:'Health',type:'number',source:'script',script:'return 1',observationName:'hp'}]));localStorage.setItem('firefly-policy-graph-%7Bsettings%7D',${JSON.stringify(JSON.stringify(graph))})`);
  win.reload();await wait(600);await click('Graphs');
  const node=`document.querySelector('.react-flow__node[data-id="goal"]')`,policy=`document.querySelector('.react-flow__node[data-id="pol"]')`;
  await until(node,'the Goal node shows');
  assert.match(await js(`${node}.textContent`),/Position: Player/);
  assert.match(await js(`${node}.textContent`),/Without a Target it trains/);
  // The worker is asked about it, and the node shows its columns and how far the player went in its look-ahead
  await until(`${node}.textContent.includes('you went 180 px in 4 s')`,'what the worker said');
  assert.deepEqual(asked.columns.at(-1).goals,[{name:'goal',position:'Player',lookAhead:[1,4],targets:3,minMove:20}]);
  assert.match(await js(`${node}.querySelector('.pg-spatial-values').textContent`),/^dxdydist$/);
  // The Policy node takes it as a value, and its dataset is previewed with the goal and its columns
  await until(`${policy}.textContent.includes('goal')`,'the Policy node lists it');
  // A State recorded under another name is listed by the State's own name
  await until(`[...${policy}.querySelectorAll('.pg-value b')].map(b=>b.textContent).join()==='goal,Health'`,'values by their States’ names');
  assert.equal(await js(`[...${policy}.querySelectorAll('.pg-value b')][1].title`),'Recorded as hp');
  for(let i=0;i<60&&!asked.preview.length;i++)await wait(50);
  await wait(900);
  let request=asked.preview.at(-1);
  assert.deepEqual(request.goal,{name:'goal',position:'Player',lookAhead:[1,4],targets:3,minMove:20});
  assert.deepEqual(request.columns,['goal.dx','goal.dy','goal.dist','hp']);
  // Wiring by dragging: a true/false isn't a position, so it's refused there; facing and target are taken
  const wireTo=async(from,to,handle)=>js(`(()=>{
    const source=document.querySelector('.react-flow__node[data-id="${from}"] .react-flow__handle.source');
    const target=document.querySelector('.react-flow__node[data-id="${to}"] [data-handleid="${handle}"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  const wire=(from,handle)=>wireTo(from,'goal',handle);
  await wire('face','in:@target');await wait(200);
  assert.ok(!(await js(`${node}.textContent.includes('Target: Face Left')`)),'a true/false was taken as a target');
  await wire('face','in:@facing');
  await until(`${node}.textContent.includes('Facing left: Face Left')`,'facing wired');
  // Measured from the facing, the policy needs the facing among its values, or it can't tell which key is ahead
  await until(`${policy}.textContent.includes('goal is measured from Face Left')`,'the facing not a value is a problem');
  await wireTo('face','pol','values');
  await until(`!${policy}.textContent.includes('is measured from Face Left')`,'the facing a value');
  await wire('way','in:@target');
  await until(`${node}.textContent.includes('Target: Waypoint')`,'target wired');
  await until(`!${node}.textContent.includes('Without a Target')`,'the warning goes');
  await until(`${node}.querySelector('.pg-spatial-values').textContent==='forward120dy-30dist123.7'`,'its columns toward the target');
  // The look-ahead: the shortest stays first
  await js(`(()=>{const i=${node}.querySelector('[aria-label="Look ahead to"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'0.5');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`${node}.textContent.includes('at where you got to 0.5 s later')`,'one look-ahead');
  for(let i=0;i<60&&JSON.stringify(asked.preview.at(-1).goal?.lookAhead)!=='[0.5,0.5]';i++)await wait(50);
  request=asked.preview.at(-1);
  assert.deepEqual(request.goal,{name:'goal',position:'Player',facing:'Face Left',target:'Waypoint',lookAhead:[0.5,0.5],targets:3,minMove:20});
  assert.deepEqual(request.columns,['goal.forward','goal.dy','goal.dist','hp','Face Left']);
  // A second goal, dropped from the palette and wired into the same policy, is a problem, not a second goal
  await js(`(()=>{const item=[...document.querySelectorAll('.pg-palette-item')].find(i=>i.textContent.trim().endsWith('Goal'));
    const t=new DataTransfer();item.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:t}));
    const c=document.querySelector('.pg-canvas'),r=c.getBoundingClientRect();
    // somewhere no node is
    let x=r.x+40,y=r.y+r.height-60;
    for(const [fx,fy] of [[.05,.92],[.5,.95],[.9,.95],[.9,.5],[.05,.5]]){const px=r.x+fx*r.width,py=r.y+fy*r.height,el=document.elementFromPoint(px,py);if(el&&!el.closest('.react-flow__node')){x=px;y=py;break;}}
    c.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:t,clientX:x,clientY:y}));})()`);
  const second=`[...document.querySelectorAll('.react-flow__node')].find(n=>n.querySelector('[aria-label="Goal name"]')?.value==='goal 2')`;
  await until(second,'a goal dropped from the palette');
  const id=await js(`${second}.dataset.id`);
  // A node just dropped has its handles measured a moment later: a wire before that misses, so it's tried again
  await wait(300);
  for(let attempt=0;attempt<3&&!(await js(`${second}.textContent.includes('Position: Player')`));attempt++){await wireTo('player',id,'in:@position');await wait(400);}
  await until(`${second}.textContent.includes('Position: Player')`,'the second goal wired');
  await js(`(()=>{
    const source=${second}.querySelector('.react-flow__handle.source'),target=${policy}.querySelector('[data-handleid="values"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  await until(`${policy}&&${policy}.textContent.includes('A policy has one goal')`,'one goal a policy');
  const logged=errors.filter(e=>!/DevTools|Autofill|ResizeObserver loop/.test(e));
  assert.equal(logged.length,0,'Console errors: '+logged.join(' | '));
  console.log('Goal node UI: ok');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
