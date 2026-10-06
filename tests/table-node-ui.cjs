// Table node in a collection graph: a condition for a Trigger, wired columns with their Match, and the table viewer
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','table-node-ui-profile'));
let win;const watchdog=setTimeout(()=>{console.error('Table UI timed out');app.exit(1);},45000);
const tableCalls=[];
// Three rows to look for, among 230 (so the viewer has pages), newest first by key
let rows=[
  {key:'230',columns:{map_id:100000000,map_region:[2,-1],mob_animations:[1,3]},savedAt:'2026-10-03T10:05:00Z',image:'C:/data/3.png'},
  {key:'229',columns:{map_id:104000000,map_region:[0,0],mob_animations:[2]},savedAt:'2026-10-03T10:02:00Z',image:'C:/data/2.png'},
  {key:'228',columns:{map_id:100000000,map_region:[3,-1],mob_animations:[1]},savedAt:'2026-10-03T10:01:00Z',image:'C:/data/1.png'},
  ...Array.from({length:227},(_,i)=>({key:String(227-i),columns:{map_id:200000000+i,map_region:[i%4,1],mob_animations:[7]},savedAt:'2026-10-03T09:00:00Z',image:`C:/data/g${i}.png`})),
];
// What the worker's table.rows does: every filter word in the row's JSON, sorted, one page
function page({offset=0,limit=100,filter='',sort={column:'savedAt',up:false}}){
  const words=filter.toLowerCase().split(/\s+/).filter(Boolean);
  const kept=rows.filter(r=>words.every(w=>JSON.stringify(r.columns).toLowerCase().includes(w)));
  const value=r=>sort.column==='savedAt'?Number(r.key):r.columns[sort.column];
  const order=(a,b)=>{const x=value(a),y=value(b);return typeof x==='number'&&typeof y==='number'?x-y:JSON.stringify(x).localeCompare(JSON.stringify(y));};
  kept.sort((a,b)=>(order(a,b)||Number(a.key)-Number(b.key))*(sort.up?1:-1));
  return {all:rows.length,total:kept.length,columns:['map_id','map_region','mob_animations'],rows:kept.slice(offset,offset+limit)};
}
app.whenReady().then(async()=>{
 try {
  for(const [name,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(name,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
    if(op==='windows')return {windows:[{id:'123',title:'Test Game',pid:1}]};
    if(op==='dataset.list')return {recordings:[]};
    if(op==='observe.fields')return {fields:[]};
    if(op==='frame'){await wait(50);return {pending:true};}
    if(op==='memory.read')return {value:100000000};
    if(op==='memory.run_script')return {value:args.script.includes('busy')?true:args.script.includes('region')?{x:2,y:-1}:[1,3]};
    return {};
  });
  ipcMain.handle('policy:invoke',(_,op)=>op==='models'?[]:{});
  ipcMain.handle('collection:table',(_,op,params)=>{
    tableCalls.push([op,params]);
    if(op==='delete'){rows=params.key?rows.filter(r=>r.key!==params.key):[];return;}
    return page(params);
  });
  win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code),errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const until=async code=>{for(let i=0;i<80;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const click=async label=>{await js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click()})()`);await wait(80);};
  const input=async(label,value,scope='document')=>{await js(`(()=>{const i=${scope}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(80);};
  const choose=async(scope,label,value)=>{await js(`(()=>{const s=${scope}.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(120);};
  const drag=async(fromSel,toSel)=>{await js(`(()=>{
    const source=${fromSel},target=${toSel};
    const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
    const x=a.x+a.width/2,y=a.y+a.height/2,tx=b.x+b.width/2,ty=b.y+b.height/2;
    source.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window,button:0,buttons:1,clientX:x,clientY:y}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,view:window,buttons:1,clientX:tx,clientY:ty}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window,button:0,clientX:tx,clientY:ty}));
  })()`);await wait(200);};
  await win.loadFile(path.join(root,'dist/index.html'));
  const states=[
    {id:'map',name:'Map ID',type:'number',source:'memory',address:'0x1000',offsets:[],byteType:'i32'},
    {id:'region',name:'Map Region',type:'vector',source:'script',script:'return {x=2,y=-1} -- region'},
    {id:'mobs',name:'Mob animations',type:'collection',source:'script',script:'return {1,3}'},
    {id:'busy',name:'Busy',type:'boolean',source:'script',script:'return true -- busy'},
  ];
  await js(`localStorage.clear();localStorage.setItem('firefly-states-Test%20Game',${JSON.stringify(JSON.stringify(states))})`);
  win.reload();await wait(500);
  await until(`document.querySelector('.win-item')`);await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await click('Start Session');
  await until(`document.querySelector('[aria-label="Edit Mob animations"]')`);
  await click('Graphs');
  await click('+ Collection');await input('Graph name','Seen moments');await click('Save');
  await until(`document.querySelector('.collection-editor')`);
  const scope='firefly-policy-graph-Test%20Game';
  const selected=await js(`JSON.parse(localStorage.getItem('${scope}-library')).selected`);
  const readDoc=()=>js(`JSON.parse(localStorage.getItem('${scope}-document-${selected}'))`);
  for(const kind of ['Table','State','State','State','State'])await click(kind);
  await wait(300);
  let doc=await readDoc();
  const id=kind=>doc.nodes.find(n=>n.data.kind===kind).id;
  const table=id('table'),trigger=id('trigger'),capture=id('capture'),output=id('output');
  const stateNodes=doc.nodes.filter(n=>n.data.kind==='state').map(n=>n.id);
  const nodeOf=id=>`document.querySelector('.react-flow__node[data-id="${id}"]')`;
  for(const [i,name] of ['Map ID','Map Region','Mob animations','Busy'].entries())await choose(nodeOf(stateNodes[i]),'State',name);
  doc=await readDoc();
  assert.deepEqual(stateNodes.map(s=>doc.nodes.find(n=>n.id===s).data.name),['Map ID','Map Region','Mob animations','Busy']);
  // Columns are wired States; a list is compared item by item, anything else by its value
  for(const s of stateNodes.slice(0,3))await choose(nodeOf(table),'Add a column from',s);
  doc=await readDoc();
  assert.deepEqual(doc.nodes.find(n=>n.id===table).data.inputs,['map_id','map_region','mob_animations']);
  assert.deepEqual(doc.nodes.find(n=>n.id===table).data.match,{map_id:'same',map_region:'same',mob_animations:'any'});
  await choose(nodeOf(table),'Match map_region','store');
  assert.equal((await readDoc()).nodes.find(n=>n.id===table).data.match.map_region,'store');
  await choose(nodeOf(table),'Match map_region','same');
  // The table decides whether to take a screenshot: Table → Trigger, with Capture → Output as it was
  await js(`void document.querySelector('.react-flow__controls-fitview')?.click()`);await wait(300);
  await drag(`${nodeOf(table)}.querySelector('.react-flow__handle.source')`,`${nodeOf(trigger)}.querySelector('[data-handleid="in"]')`);
  doc=await readDoc();
  assert.ok(doc.edges.some(e=>e.source===table&&e.target===trigger&&e.targetHandle==='in'),'Table → Trigger was not wired');
  assert.deepEqual(doc.edges.filter(e=>e.target===output).map(e=>e.source),[capture]);
  // A table isn't an image: it can't feed a Dataset Output, and has no image input of its own
  await drag(`${nodeOf(table)}.querySelector('.react-flow__handle.source')`,`${nodeOf(output)}.querySelector('[data-handleid="in"]')`);
  assert.deepEqual((await readDoc()).edges.filter(e=>e.target===output).map(e=>e.source),[capture],'A table fed a Dataset Output');
  // Gone from the earlier designs
  for(const handle of ['image','keep'])assert.equal(await js(`${nodeOf(table)}.querySelector('[data-handleid="${handle}"]')`),null,handle);
  assert.equal(await js(`${nodeOf(output)}.querySelector('[data-handleid="saved"]')`),null);
  assert.equal(await js(`${nodeOf(table)}.querySelector('[aria-label^="Up to"]')`),null);
  assert.deepEqual(await js(`[...${nodeOf(table)}.querySelector('[aria-label="Match map_id"]').options].map(o=>o.textContent)`),['Same value','Any new item','Any value']);
  // Logic takes wired conditions like the other nodes: rows naming what's wired, any number, one for Not
  await click('Logic');await wait(200);
  doc=await readDoc();
  const logic=doc.nodes.find(n=>n.data.kind==='logic').id;
  assert.deepEqual(doc.nodes.find(n=>n.id===logic).data.inputs,[]);
  assert.ok(await js(`${nodeOf(logic)}.textContent.includes('Drop a condition here')`));
  const offered=await js(`[...${nodeOf(logic)}.querySelector('[aria-label="Add an input from"]').options].map(o=>o.textContent)`);
  assert.ok(offered.includes('Seen')&&offered.includes('Busy')&&!offered.includes('Map ID'),'Only true/false sources: '+offered);
  await choose(nodeOf(logic),'Add an input from',table);
  await drag(`${nodeOf(stateNodes[3])}.querySelector('.react-flow__handle.source')`,`${nodeOf(logic)}.querySelector('[data-handleid="in:+"]')`);
  doc=await readDoc();
  assert.deepEqual(doc.nodes.find(n=>n.id===logic).data.inputs,['a','b'],'A wire dropped on the node adds an input');
  assert.deepEqual(doc.edges.filter(e=>e.target===logic).map(e=>[e.source,e.targetHandle]),[[table,'a'],[stateNodes[3],'b']]);
  assert.deepEqual(await js(`[...${nodeOf(logic)}.querySelectorAll('.pg-from')].map(s=>s.textContent)`),['← Seen','← Busy']);
  await choose(nodeOf(logic),'Combine','not');
  doc=await readDoc();
  assert.deepEqual(doc.nodes.find(n=>n.id===logic).data.inputs,['a'],'Not keeps the first input');
  assert.deepEqual(doc.edges.filter(e=>e.target===logic).map(e=>e.targetHandle),['a']);
  assert.equal(await js(`${nodeOf(logic)}.querySelector('[data-handleid="in:+"]')`),null,'Not takes no more inputs');
  await js(`${nodeOf(logic)}.querySelector('[title="Remove input a"]').click()`);await wait(100);
  assert.deepEqual((await readDoc()).nodes.find(n=>n.id===logic).data.inputs,[]);
  await js(`${nodeOf(logic)}.querySelector('.pg-node-delete').click()`);await wait(100);
  fs.writeFileSync(path.join(root,'build','table-node-ui-graph.png'),(await win.webContents.capturePage()).toPNG());
  // The viewer: a page at a time, the filter and sort over the whole table, delete one, delete all
  const pageText=`document.querySelector('.table-viewer-page').textContent`;
  const rowCount=`document.querySelectorAll('.table-viewer tbody tr').length`;
  await js(`${nodeOf(table)}.querySelector('.collection-table-open button').click()`);
  await until(`${rowCount}===100`);
  assert.deepEqual(tableCalls[0],['rows',{scope,table:'Seen',offset:0,limit:100,filter:'',sort:{column:'savedAt',up:false}}]);
  assert.deepEqual(await js(`[...document.querySelectorAll('.table-viewer th')].map(t=>t.textContent).slice(0,4)`),['map_id','map_region','mob_animations','Saved ▼']);
  assert.equal(await js(pageText),'Rows 1–100 of 230 · page 1 of 3');
  await js(`document.querySelector('[aria-label="Next page"]').click()`);await until(`${pageText}.startsWith('Rows 101–200')`);
  await js(`document.querySelector('[aria-label="Last page"]').click()`);await until(`${pageText}==='Rows 201–230 of 230 · page 3 of 3'`);
  assert.equal(await js(rowCount),30);
  assert.ok(await js(`document.querySelector('[aria-label="Next page"]').disabled`),'No page after the last');
  await input('Filter rows','104000000');
  await until(`${rowCount}===1&&${pageText}.includes('matching (230 in all)')`);
  assert.ok((await js(pageText)).startsWith('Rows 1–1 of 1'),'A filter starts from the first page');
  await input('Filter rows','100000000 [2,-1]');
  await until(`${rowCount}===1&&document.querySelector('.table-viewer tbody td:nth-child(2)').textContent==='[2,-1]'`);
  await input('Filter rows','');
  await until(`${rowCount}===100`);
  await js(`[...document.querySelectorAll('.table-viewer th')].find(t=>t.textContent==='map_id').click()`);
  await until(`document.querySelector('.table-viewer tbody tr td').textContent==='100000000'`);
  fs.writeFileSync(path.join(root,'build','table-node-ui-viewer.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.table-viewer tbody tr [aria-label="Delete row"]').click()`);
  await until(`${pageText}.includes('of 229')`);
  assert.equal(tableCalls.find(c=>c[0]==='delete')[1].scope,scope);
  await js(`window.confirm=()=>true;0`);await click('Delete all rows');
  await until(`document.querySelector('.table-viewer').textContent.includes('Nothing kept yet')`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await wait(80);
  assert.equal(await js(`document.querySelector('.table-viewer')`),null,'Escape closes the viewer');
  // While a graph runs: its summary shows as text, settings lock, and the table still opens
  win.webContents.send('collection:status',[{graphId:selected,scope,name:'Seen moments',running:true,test:false,saved:3,fired:3,skipped:0,error:'',values:{[table]:'New: mob_animations [3]'},issues:{},recent:[]}]);await wait(150);
  assert.ok(await js(`${nodeOf(table)}.textContent.includes('New: mob_animations [3]')`));
  assert.ok(await js(`${nodeOf(table)}.querySelector('[aria-label="Table name"]').matches(':disabled')`));
  assert.ok(await js(`${nodeOf(table)}.querySelector('[aria-label="Match map_id"]').disabled`));
  assert.ok(!(await js(`${nodeOf(table)}.querySelector('.collection-table-open button').disabled`)));
  win.webContents.send('collection:status',[]);await wait(100);
  // A graph saved while the Table sat in the image path (with a Keep if wire) is rewired around it on load
  const old=await readDoc();
  old.edges=old.edges.filter(e=>!(e.source===table&&e.target===trigger)&&e.target!==output).concat([
    {id:'old-image',source:capture,target:table,sourceHandle:'out',targetHandle:'image'},
    {id:'old-output',source:table,target:output,sourceHandle:'out',targetHandle:'in'},
    {id:'old-keep',source:stateNodes[3],target:table,sourceHandle:'out',targetHandle:'keep'}]);
  await js(`localStorage.setItem('${scope}-document-${selected}',${JSON.stringify(JSON.stringify(old))})`);
  win.reload();await wait(600);await click('Graphs');await until(`${nodeOf(table)}`);await wait(200);
  doc=await readDoc();
  assert.deepEqual(doc.edges.filter(e=>e.target===output).map(e=>e.source),[capture],'Capture → Output was not restored');
  assert.ok(!doc.edges.some(e=>e.target===table&&['image','keep'].includes(e.targetHandle)),'Old Table wires were kept');
  assert.deepEqual(errors.filter(e=>!e.includes('No handler registered')&&!e.includes('Content Security Policy')),[]);
  console.log('PASS: Table node: Table → Trigger, not into outputs, Logic with wired rows (picker, dropped wire, Not keeps one), paged table viewer, columns with Match (lists by item; Any value), viewer filter/sort/delete, opens while running, old image-path graphs rewired');
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(watchdog);win?.destroy();app.exit(process.exitCode||0);}
});
