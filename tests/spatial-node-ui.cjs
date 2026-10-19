// Spatial node in the Policy Graph: wired point, shapes added from the picker, facing wired by dragging, its fields,
// what the worker is asked for (columns, preview) and what the node and the Policy node show
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','spatial-node-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Spatial UI timed out');app.exit(1);},60000);
const asked={columns:[],preview:[],live:[]};
const recording={id:'rec1',name:'Run',status:'complete',samples:100,invalidSamples:0,durationMs:10000,inputEvents:0,
  metadata:{started:1,hz:15,observationSchema:{identity:'obs',fields:[{name:'Player',type:'vector'},{name:'Face Left',type:'boolean'},{name:'monsters',type:'shapes'},{name:'platforms',type:'shapes'},
    {name:'players',type:'shapes'},{name:'Map Bounds',type:'object'}]},
    actionSchema:{identity:'act',buttons:[{id:'k1',vk:49}]}}};
// The worker's columns op, as spatial.py names them: per input, a column for each field it's for (the presets
// without fields of the node's own), with a value for each
const presets=spec=>[...['dx','dy','dist','found'].map(k=>({name:`nearest.${k}`,pick:'nearest'})),
  ...(spec.facing?['ahead','behind','above','below']:['left','right','above','below']).map(d=>({name:d,pick:d})),
  ...spec.radii.map(r=>({name:`within.${r}`,pick:'all',within:r,value:'count'})),{name:'inside',pick:'all',value:'inside'}];
const fieldsOf=spec=>spec.fields??presets(spec);
function columns(spec){
  return spec.sets.flatMap(s=>fieldsOf(spec).filter(f=>!f.inputs||f.inputs.includes(s.alias)).map(f=>`${spec.name}.${s.alias}.${f.name}`));
}
// What each field is about in the stand-in picture: one box for a single shape, the box counted for all
const about=spec=>Object.fromEntries(fieldsOf(spec).map(f=>[f.name,f.pick==='all'?{shapes:[0]}:f.pick==='left'?null:{end:[250,90,50],shape:0}]));
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  const frame=nativeImage.createFromBitmap(Buffer.alloc(320*200*4,90),{width:320,height:200}); // the game, for a session
  ipcMain.handle('runtime:invoke',async(_,op)=>{
    if(op==='windows')return {windows:[{id:'123',title:'Test Game',pid:1}]};
    if(op==='frame'){await wait(20);return {dataUrl:frame.toDataURL(),timestamp:Date.now(),width:320,height:200};}
    if(op==='dataset.list')return {recordings:[recording]};
    if(op==='observe.fields')return {fields:recording.metadata.observationSchema.fields,excluded:[]};
    return {ok:true};
  });
  ipcMain.handle('policy:invoke',(_,op,params)=>{
    if(op==='models')return [];
    if(op==='columns'){asked.columns.push(params);
      return {groups:[],fields:[],formulas:[],grids:[],spatial:(params.spatial??[]).map(s=>{const c=columns(s);return {name:s.name,columns:c,values:c.map((_,i)=>i*1.5),error:null,
        picture:{bounds:s.bounds?[-200,-100,800,400]:[0,0,400,200],fitted:!s.bounds,point:[200,90],facingLeft:s.facing?false:null,radii:s.radii,
          sets:s.sets.map(set=>({alias:set.alias,shapes:[{points:[[250,80],[270,80],[270,100],[250,100],[250,80]],closed:true,props:{hp:40}},{points:[[0,100],[400,100]],closed:false}],
          props:['hp','id'],fields:about(s),distances:[50,10]}))}};})};}
    // One live sample: the point and the boxes it holds, drawn round them
    if(op==='spatial.sample'){asked.live.push(params);const c=columns(params.spatial);
      return {name:params.spatial.name,columns:c,values:c.map(()=>7),error:null,picture:{bounds:[0,0,1000,500],fitted:true,point:[500,250],facingLeft:null,radii:params.spatial.radii,
        sets:params.spatial.sets.map(set=>({alias:set.alias,shapes:[{points:[[600,200],[640,200],[640,240],[600,240],[600,200]],closed:true}],fields:about(params.spatial),distances:[100]}))}};}
    if(op==='preview'){asked.preview.push(params);return {samples:900,stepMs:66,recordings:[{id:'rec1',rows:900}],skipped:[],skippedReasons:{},values:params.columns,inputs:params.columns.length,buttons:[{id:'k1',pressed:.3}]};}
    return {};
  });
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async(code,what=code)=>{for(let i=0;i<100;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+what);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(80);};
  await win.loadFile(path.join(root,'dist/index.html'));
  const state=(id,name,y)=>({id,type:'state',position:{x:0,y},data:{kind:'state',name}});
  const legacy={version:1,nodes:[state('player','Player',0),state('face','Face Left',120),state('mobs','monsters',240),state('floor','platforms',360),
    state('others','players',480),state('bounds','Map Bounds',600),
    {id:'near',type:'spatial',position:{x:320,y:0},data:{kind:'spatial',name:'near',inputs:['monsters'],radii:[100,250,500],maxDistance:1000}},
    {id:'recs',type:'recordings',position:{x:320,y:600},data:{kind:'recordings',ids:['rec1']}},
    {id:'pol',type:'policy',position:{x:760,y:0},data:{kind:'policy',name:'Combat',buttons:null,off:[],stepMs:null,history:0,delayMs:0,epochs:60}}],
    edges:[{id:'e1',source:'player',sourceHandle:'out',target:'near',targetHandle:'in:@point'},{id:'e2',source:'mobs',sourceHandle:'out',target:'near',targetHandle:'in:monsters'},
      {id:'e3',source:'near',sourceHandle:'out',target:'pol',targetHandle:'values'},{id:'e4',source:'recs',sourceHandle:'data',target:'pol',targetHandle:'data'}]};
  await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem('firefly-policy-graph-%7Bsettings%7D',${JSON.stringify(JSON.stringify(legacy))})`);
  win.reload();await wait(600);await click('Graphs');
  const node=`document.querySelector('.react-flow__node[data-id="near"]')`;
  await until(node,'the Spatial node shows');
  assert.match(await js(`${node}.textContent`),/Point: Player/);
  // The worker is asked for its columns, and the node shows them with their values
  await until(`${node}.textContent.includes('12 values, in the latest sample')`,'its 12 values from the worker');
  let spec=asked.columns.at(-1).spatial[0];
  assert.deepEqual(spec,{name:'near',point:'Player',sets:[{alias:'monsters',shapes:['monsters']}],radii:[100,250,500],maxDistance:1000});
  // The latest sample drawn: a canvas with something on it
  await until(`${node}.querySelector('[aria-label="Spatial picture"]')`,'the picture');
  assert.match(await js(`${node}.querySelector('.pg-spatial-values').textContent`),/monsters\.nearest\.dist3monsters/);
  // The Policy node takes it as one value of 12 columns, and its dataset is previewed with them
  const policy=`document.querySelector('.react-flow__node[data-id="pol"]')`;
  await until(`${policy}.textContent.includes('spatial · 12 values')`,'the Policy node lists it');
  for(let i=0;i<60&&!asked.preview.length;i++)await wait(50);
  await wait(900);
  let request=asked.preview.at(-1);
  assert.equal(request.spatial[0].name,'near');
  assert.ok(request.columns.includes('near.monsters.within.250'));
  // More shapes from the picker: an input named after the state, wired
  await js(`(()=>{const s=${node}.querySelector('[aria-label="Add shapes from"]');
    const o=[...s.options].find(o=>o.textContent==='platforms');if(!o)throw Error('platforms not offered: '+[...s.options].map(o=>o.textContent));
    if([...s.options].some(o=>['Player','Face Left','monsters'].includes(o.textContent)))throw Error('offered: '+[...s.options].map(o=>o.textContent));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`${node}.textContent.includes('24 values, in the latest sample')`,'24 values after adding platforms');
  spec=asked.columns.at(-1).spatial[0];
  assert.deepEqual(spec.sets,[{alias:'monsters',shapes:['monsters']},{alias:'platforms',shapes:['platforms']}]);
  // A second wire into an input that has one: both measured as one set, the first kept
  const wire=async(from,handle)=>js(`(()=>{
    const source=document.querySelector('.react-flow__node[data-id="${from}"] .react-flow__handle.source');
    const target=${node}.querySelector('[data-handleid="${handle}"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  await wire('others','in:monsters');
  await until(`${node}.textContent.includes('← monsters + players')`,'two states in one input');
  for(let i=0;i<60&&JSON.stringify(asked.columns.at(-1).spatial[0].sets[0].shapes)!=='["monsters","players"]';i++)await wait(50);
  assert.deepEqual(asked.columns.at(-1).spatial[0].sets[0],{alias:'monsters',shapes:['monsters','players']});
  // Bounds: only a shapes state, and only one
  await wire('player','in:@bounds');await wait(200);
  assert.ok(!(await js(`${node}.textContent.includes('Bounds: Player')`)),'a position was taken as bounds');
  await wire('bounds','in:@bounds');
  await until(`${node}.textContent.includes('Bounds: Map Bounds')`,'bounds wired');
  // A table, as a script returns one, is offered as bounds rather than called unusable
  assert.match(await js(`document.querySelector('.react-flow__node[data-id="bounds"]').textContent`),/Spatial node's Bounds/);
  assert.ok(!(await js(`document.querySelector('.react-flow__node[data-id="bounds"]').textContent.includes("can't be used")`)));
  for(let i=0;i<60&&!asked.columns.at(-1).spatial[0].bounds;i++)await wait(50);
  assert.equal(asked.columns.at(-1).spatial[0].bounds,'Map Bounds');
  // How an input reads x, y, w, h: a script's boxes from their top-left corner
  await js(`(()=>{const s=${node}.querySelector('[aria-label="monsters read as"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'corner');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(let i=0;i<60&&asked.columns.at(-1).spatial[0].sets[0].read!=='corner';i++)await wait(50);
  assert.deepEqual(asked.columns.at(-1).spatial[0].sets,[{alias:'monsters',shapes:['monsters','players'],read:'corner'},{alias:'platforms',shapes:['platforms']}]);
  // Facing, by dragging a wire from Face Left: left and right become ahead and behind
  await js(`(()=>{
    const source=document.querySelector('.react-flow__node[data-id="face"] .react-flow__handle.source');
    const target=${node}.querySelector('[data-handleid="in:@facing"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  await until(`${node}.textContent.includes('Facing left: Face Left')`,'facing wired');
  // Measured from the facing, the policy needs it as a value
  await js(`(()=>{
    const source=document.querySelector('.react-flow__node[data-id="face"] .react-flow__handle.source');
    const target=document.querySelector('.react-flow__node[data-id="pol"] [data-handleid="values"]');
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:a.x+a.width/2,clientY:a.y+a.height/2}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:b.x+b.width/2,clientY:b.y+b.height/2}));
  })()`);
  await until(`[...document.querySelectorAll('.react-flow__node[data-id="pol"] .pg-value b')].some(b=>b.textContent==='Face Left')`,'facing a value');
  await until(`${node}.querySelector('.pg-spatial-values').textContent.includes('platforms.ahead')`,'ahead and behind');
  assert.equal(asked.columns.at(-1).spatial[0].facing,'Face Left');
  // Fields: the presets listed; a new one for the monsters alone, the weakest's hp, from what their shapes carry
  const fieldNames=()=>js(`[...${node}.querySelectorAll('.pg-sf-row b')].map(b=>b.textContent)`);
  assert.deepEqual(await fieldNames(),['nearest.dx','nearest.dy','nearest.dist','nearest.found','ahead','behind','above','below','within.100','within.250','within.500','inside']);
  const form=`${node}.querySelector('.pg-sf-form')`;
  const type=async(label,value)=>{await js(`(()=>{const i=${form}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(60);};
  const pick=async(label,value)=>{await js(`(()=>{const s=${form}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(60);};
  const tick=async text=>{await js(`[...${form}.querySelectorAll('label')].find(l=>l.textContent===${JSON.stringify(text)}).querySelector('input').click()`);await wait(60);};
  await js(`${node}.querySelector('.pg-sf-add').click()`);await until(form,'the field form');
  await type('Field name','weakest.hp');await pick('Which shape','lowest');
  assert.match(await js(`${form}.textContent`),/Say which field it ranks by/);
  assert.ok(await js(`[...document.querySelectorAll('datalist option')].some(o=>o.value==='hp')`),'the shapes’ own fields offered');
  await type('Ranked by','hp');await pick('Gives','prop');
  await tick('every input');await tick('platforms');  // for the monsters alone
  await tick('In an area');await type('Area ahead','150');  // only those touching a box ahead, as an attack reaches
  await js(`[...${form}.querySelectorAll('button')].find(b=>b.textContent==='Add').click()`);
  await until(`${node}.querySelector('.pg-spatial-values').textContent.includes('monsters.weakest.hp')`,'the new field’s column');
  let fields=asked.columns.at(-1).spatial[0].fields;
  assert.deepEqual(fields.at(-1),{name:'weakest.hp',pick:'lowest',value:'prop',by:'hp',prop:'hp',area:{ahead:150,behind:10,above:80,below:10},inputs:['monsters']});
  assert.match(await js(`${node}.querySelector('.pg-sf').textContent`),/lowest hp in an area \(150 ahead, 10 behind, 80 up, 10 down\) · its hp · for monsters/);
  assert.equal(fields.length,13,'the presets made its own, with the new one');
  assert.ok(!(await js(`${node}.querySelector('.pg-spatial-values').textContent.includes('platforms.weakest.hp')`)),'not for the platforms');
  // A preset removed, another edited
  await js(`${node}.querySelector('[aria-label="Remove inside"]').click()`);await wait(100);
  await js(`${node}.querySelector('[aria-label="Edit within.500"]').click()`);await until(form,'editing within.500');
  await type('Field name','within.300');await type('Within','300');
  await js(`[...${form}.querySelectorAll('button')].find(b=>b.textContent==='Save').click()`);
  await until(`${node}.querySelector('.pg-spatial-values').textContent.includes('within.300')`,'the edited field');
  fields=asked.columns.at(-1).spatial[0].fields;
  assert.deepEqual(fields.map(f=>f.name),['nearest.dx','nearest.dy','nearest.dist','nearest.found','ahead','behind','above','below','within.100','within.250','within.300','weakest.hp']);
  assert.deepEqual(fields[10],{name:'within.300',pick:'all',value:'count',within:300});
  // The platform under the point, how far its end ahead is; and the nearest ahead leaving that one out (the next ledge)
  const addField=async(name,which,gives,extra=async()=>{})=>{
    await js(`${node}.querySelector('.pg-sf-add').click()`);await until(form,'a new field');
    await type('Field name',name);await pick('Which shape',which);await pick('Gives',gives);
    await tick('every input');await tick('monsters');await extra();
    await js(`[...${form}.querySelectorAll('button')].find(b=>b.textContent==='Add').click()`);
    await until(`${node}.querySelector('.pg-spatial-values').textContent.includes('platforms.${name}')`,name);
  };
  await addField('on.ahead','under','ahead_end',async()=>assert.ok(!(await js(`[...${form}.querySelectorAll('label')].some(l=>l.textContent==='Not the one under the point')`)),'under can leave itself out'));
  await addField('next.dy','ahead','dy',()=>tick('Not the one under the point'));
  fields=asked.columns.at(-1).spatial[0].fields;
  assert.deepEqual(fields.slice(-2),[{name:'on.ahead',pick:'under',value:'ahead_end',inputs:['platforms']},{name:'next.dy',pick:'ahead',value:'dy',notUnder:true,inputs:['platforms']}]);
  assert.match(await js(`${node}.querySelector('.pg-sf').textContent`),/under · its ahead end · for platforms/);
  assert.match(await js(`${node}.querySelector('.pg-sf').textContent`),/ahead \(not the one under\) · dy · for platforms/);
  // A name taken is refused
  await js(`${node}.querySelector('.pg-sf-add').click()`);await until(form,'a new field');
  await type('Field name','ahead');
  assert.match(await js(`${form}.textContent`),/Another field has that name/);
  assert.ok(await js(`[...${form}.querySelectorAll('button')].find(b=>b.textContent==='Add').disabled`));
  await js(`[...${form}.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click()`);await wait(100);
  await wait(1000);
  request=asked.preview.at(-1);
  assert.equal(request.columns.length,26);  // 12 for the monsters, 13 for the platforms, and the facing
  assert.ok(request.columns.includes('near.monsters.weakest.hp')&&!request.columns.includes('near.platforms.weakest.hp'));
  assert.ok(!request.columns.some(c=>c.endsWith('.inside')));
  // Saved with the graph
  const scope='firefly-policy-graph-%7Bsettings%7D';
  await wait(600);
  const doc=await js(`(()=>{const id=JSON.parse(localStorage.getItem('${scope}-library')).selected;return JSON.parse(localStorage.getItem('${scope}-document-'+id));})()`);
  const saved=doc.nodes.find(n=>n.id==='near');
  assert.deepEqual(saved.data.inputs,['monsters','platforms']);
  assert.deepEqual(saved.data.fields.map(f=>f.name).slice(-4),['within.300','weakest.hp','on.ahead','next.dy']);
  assert.ok(doc.edges.some(e=>e.source==='face'&&e.target==='near'&&e.targetHandle==='in:@facing'));
  assert.equal(doc.edges.filter(e=>e.target==='near'&&e.targetHandle==='in:monsters').length,2);
  assert.deepEqual(saved.data.reads,{monsters:'corner'});
  // Bounds aren't values: the policy's request doesn't need them recorded, and its columns are the same
  assert.equal(asked.preview.at(-1).spatial[0].bounds,'Map Bounds');
  const image=await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.join(root,'build','spatial-node-ui.png'),image.toPNG());
  // Preview: the whole picture large, every input with what's wired into it, hidden and shown, closed by Escape
  await js(`${node}.querySelector('.pg-spatial-open').click()`);
  const dialog=`document.querySelector('[role="dialog"][aria-label="Preview of near"]')`;
  await until(dialog,'the preview opens');
  const legend=await js(`[...${dialog}.querySelectorAll('.pg-spatial-legend-row')].map(r=>r.textContent)`);
  assert.equal(legend.length,2);
  assert.match(legend[0],/^monsters.*monsters \+ players.*2 shapes · nearest 3 px/);
  assert.match(legend[1],/^platforms.*platforms/);
  assert.ok(await js(`${dialog}.querySelector('canvas[aria-label="Spatial preview"]').width>300`),'a large canvas');
  await js(`${dialog}.querySelector('.pg-spatial-legend-row').click()`);await wait(100);
  assert.ok(await js(`${dialog}.querySelector('.pg-spatial-legend-row').classList.contains('pg-dim')`),'hiding an input');
  // Zooming with the wheel changes nothing but the view
  await js(`(()=>{const c=${dialog}.querySelector('canvas[aria-label="Spatial preview"]'),r=c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
    c.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.x+10,clientY:r.y+10}));})()`);await wait(100);
  assert.match(await js(`${dialog}.querySelector('.pg-spatial-pointer').textContent`),/^\(-?\d+, -?\d+\)$/);
  // Every value of an input, each pointing at the relation it comes from
  const rows=await js(`[...${dialog}.querySelectorAll('[aria-label="platforms values"] div')].map(d=>d.firstChild.textContent)`);
  assert.deepEqual(rows,['nearest.dx','nearest.dy','nearest.dist','nearest.found','ahead','behind','above','below','within.100','within.250','within.300','on.ahead','next.dy']);
  await js(`${dialog}.querySelector('[aria-label="platforms values"] div:nth-child(5)').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
  await until(`${dialog}.querySelector('[aria-label="platforms values"] div:nth-child(5)').classList.contains('pg-on')`,'pointing at a value');
  for(const label of ['Lines','Counted','Shape fields'])assert.ok(await js(`[...${dialog}.querySelectorAll('.pg-spatial-show label')].some(l=>l.textContent==='${label}'&&l.querySelector('input').checked)`),label);
  const preview=await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.join(root,'build','spatial-preview-ui.png'),preview.toPNG());
  // A key meant for the preview doesn't reach the graph: Backspace with the node selected leaves it there
  await js(`${node}.click()`);await wait(100);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true}))`);await wait(200);
  assert.ok(await js(node),'Backspace in the preview deleted the node');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(`!${dialog}`,'Escape closes the preview');
  // Reset puts the presets back
  await js(`[...${node}.querySelectorAll('.pg-sf-hd button')].find(b=>b.textContent==='Reset').click()`);
  await until(`${node}.textContent.includes('24 values')`,'the presets again');
  assert.equal(asked.columns.at(-1).spatial[0].fields,undefined);
  assert.equal(asked.live.length,0,'measured live with no session');
  // Refresh, above the picture: with no session it asks the worker for the latest recorded sample again
  const refreshButton=`[...${node}.querySelectorAll('.pg-spatial-refresh button')].find(b=>b.textContent==='Refresh')`;
  assert.ok(await js(`!!${refreshButton}&&${node}.querySelector('.pg-spatial-refresh').compareDocumentPosition(${node}.querySelector('[aria-label="Spatial picture"]'))&Node.DOCUMENT_POSITION_FOLLOWING`),'Refresh above the picture');
  let before=asked.columns.length;
  await js(`${refreshButton}.click()`);
  for(let i=0;i<60&&asked.columns.length===before;i++)await wait(50);
  assert.ok(asked.columns.length>before,'Refresh asked the worker again');
  assert.equal(asked.live.length,0,'measured live with no session');
  // With a capture session, the preview is live: what FireFly observes, measured as it comes
  await until(`!!document.querySelector('.win-item')`,'the window list');
  await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
  await click('Start Session');
  await click('Game View'); // where a session shows
  await until(`!!document.querySelector('[aria-label="Preview source"]')`,'a session');
  await click('Graphs');
  await until(`${node}&&!${node}.querySelector('.pg-spatial-open').disabled`,'the Preview button');
  await js(`${node}.querySelector('.pg-spatial-open').click()`);
  await until(dialog,'the preview opens in a session');
  const observed=[{name:'Player',valid:true,value:[500,250],type:'vector'},{name:'monsters',valid:true,value:[],type:'shapes'}];
  for(let i=0;i<8;i++){win.webContents.send('runtime:event',{event:'observations',result:{observations:observed,tracked:[{name:'Face Left',valid:true,value:true,type:'boolean'}],frame:{w:320,h:200}}});await wait(60);}
  await until(`${dialog}.querySelector('.modal-title').textContent.includes('live')`,'the preview turns live');
  const live=asked.live.at(-1);
  assert.equal(live.spatial.name,'near');
  assert.deepEqual(live.observations.map(o=>o.name),['Player','monsters','Face Left'],'the graph\'s and the tracked observations, together');
  assert.deepEqual(live.frame,{w:320,h:200});
  assert.ok(live.fields.some(f=>f.name==='Player'&&f.type==='vector'));
  assert.ok(asked.live.length<=8,'one request per observation at most');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(`!${dialog}`,'closed');
  const sent=asked.live.length;
  win.webContents.send('runtime:event',{event:'observations',result:{observations:observed,tracked:[]}});await wait(400);
  assert.equal(asked.live.length,sent,'still measuring once the preview closed');
  // In a session, Refresh measures what FireFly saw last, and the node shows it
  await js(`${refreshButton}.click()`);
  await until(`${node}.textContent.includes('Live, as of')`,'the node live after Refresh');
  assert.equal(asked.live.length,sent+1,'one measurement for one Refresh');
  assert.match(await js(`${node}.textContent`),/as FireFly sees them now/);
  // React Flow measures a node again as it grows (its values coming in), which Chromium reports as a ResizeObserver loop: harmless
  const logged=errors.filter(e=>!/DevTools|Autofill|ResizeObserver loop/.test(e));
  assert.equal(logged.length,0,'Console errors: '+logged.join(' | '));
  console.log('Spatial node UI: ok');
  clearTimeout(watchdog);app.exit(0);
 } catch(e){console.error(e);app.exit(1);}
});
