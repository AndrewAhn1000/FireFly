// Production renderer + preload, isolated profile, deterministic capture/match events.
// Native OpenCV ranking is tested separately by template-tests.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','template-ui-profile'));
let win,context='',configuration;const configured={},removed=[];let excludedSent=null,recs=[{id:'rec1',name:'Old run',status:'complete',samples:10,inputEvents:2,invalidSamples:0,durationMs:1000,metadata:{started:0}}];const deleted=[];
const watchdog=setTimeout(()=>{console.error('Template UI test timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 try {
  const pixels=Buffer.alloc(320*200*4);
  for(let i=0;i<pixels.length;i+=4){pixels[i]=(i/4)%255;pixels[i+1]=60;pixels[i+2]=40;pixels[i+3]=255;}
  const image=nativeImage.createFromBitmap(pixels,{width:320,height:200}),url=image.toDataURL();
  const fixture={id:'region',label:'Tracked object',x:.1,y:.1,w:.1,h:.1,match:true,multiMatch:true,templates:[{id:'t1',cropUrl:url},{id:'t2',cropUrl:url},{id:'t3',cropUrl:url}]};
  // A second region follows its own object at the same time, from the same frames
  const second={id:'region-2',label:'Second object',x:.5,y:.5,w:.1,h:.1,match:true,templates:[{id:'u1',cropUrl:url}]};
  ipcMain.handle('runtime:available',()=>true);
  ipcMain.handle('runtime:status',()=>({ready:true,error:null}));
  ipcMain.handle('windows:thumbnails',()=>({}));
  ipcMain.handle('models:list',()=>[]);
  ipcMain.handle('models:probe',()=>null);
  ipcMain.handle('training:check-checkpoint',()=>({found:false}));
  ipcMain.handle('training:gpu-check',()=>({available:false}));
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'Template fixture',pid:1}]};
   if(op==='template.set'){configured[args.region]=args;if(args.region==='region'){context=args.context;configuration=args;}}
   if(op==='template.remove')removed.push(args.region);
   if(op==='observe.fields')return {fields:[{name:'hp',type:'number'},{name:'frame',type:'image'}],excluded:[]};
   if(op==='observe.recorded'){excludedSent=args.exclude;return {excluded:args.exclude};}
   if(op==='dataset.list')return {recordings:recs};
   if(op==='dataset.read')return {recording:{...recs.find(r=>r.id===args.recordingId),rows:[],offset:0,total:0}};
   if(op==='dataset.delete'){deleted.push(args.recordingId);recs=recs.filter(r=>r.id!==args.recordingId);return {ok:true};}
   if(op==='frame'){await wait(30);return {dataUrl:url,timestamp:Date.now(),jpeg:image.toJPEG(80)};}
   return {ok:true};
  });
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(code)=>{for(let i=0;i<60;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const clickText=async(text)=>{await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Button missing: '+${JSON.stringify(text)});b.click();})()`);await wait(150);};
  const toggle=async(group,template)=>{const selector=`[aria-label="${group}"] ${template ? `[aria-label="Template ${template}"]` : '.template-picker-any input'}`;await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(100);};
  const savedRegion=()=>js(`JSON.parse(localStorage.getItem('firefly-regions-Template%20fixture'))[0]`);
  const savedState=()=>js(`JSON.parse(localStorage.getItem('firefly-states-Template%20fixture'))[0]`);
  const emit=async(payload,token=context,others=[],timestamp)=>{win.webContents.send('runtime:event',{event:'template.match',result:{timestamp,regions:[{region:'region',context:token,...payload},...others]}});await wait(180);};
  const start=async()=>{await until(`!!document.querySelector('.win-item')`);await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await clickText('Start Session');await until(`document.body.textContent.includes('Capturing:')`);await wait(250);};
  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();localStorage.setItem('firefly-regions-Template%20fixture',${JSON.stringify(JSON.stringify([fixture,second]))})`);
  win.reload();await wait(400);await start();assert.ok(context);assert.equal(configuration.multiMatch,true);
  // Recording is set up in the Recordings tab, not the Inspector: what it holds is chosen per State and
  // per other observation; images are left out unless ticked, and the choices are kept per window
  assert.equal(await js(`[...document.querySelectorAll('.insp-section-hd')].some(h=>/Recording|Input Bindings/.test(h.textContent))`),false,'The Inspector still sets up recording');
  await js(`[...document.querySelectorAll('.panel-tab')].find(t=>t.textContent.startsWith('Recordings')).click()`);
  await until(`!!document.querySelector('.recordings-setup .rec-field')`);
  for(let i=0;i<20&&JSON.stringify(excludedSent)!=='["frame"]';i++)await wait(50);
  assert.deepEqual(excludedSent,['frame'],'Images should be left out of recordings by default');
  const rows=()=>js(`[...document.querySelectorAll('.recordings-setup .rec-field')].map(r=>r.querySelector('.rec-field-name').textContent)`);
  assert.deepEqual(await rows(),['hp','frame']);assert.ok(await js(`document.querySelector('.recordings-setup').textContent.includes('No States yet')`));
  const tick=name=>js(`[...document.querySelectorAll('.recordings-setup .rec-field')].find(l=>l.querySelector('.rec-field-name').textContent===${JSON.stringify(name)}).querySelector('input').click()`);
  await tick('hp');await wait(300);assert.deepEqual(excludedSent,['frame','hp']);
  await tick('frame');await wait(300);assert.deepEqual(excludedSent,['hp']);
  assert.deepEqual(await js(`JSON.parse(localStorage.getItem('firefly-recorded-Template%20fixture'))`),{hp:false,frame:true});
  await js(`document.querySelector('[aria-label="Samples per second"]')&&(()=>{const i=document.querySelector('[aria-label="Samples per second"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'25');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(150);
  assert.equal((await js(`JSON.parse(localStorage.getItem('firefly-record-setup-Template%20fixture'))`)).hz,25,'The sample rate is not kept');
  // A recording can be deleted, after confirming
  await until(`!!document.querySelector('.recordings-delete:not(:disabled)')`);
  await js(`window.confirm=()=>true;document.querySelector('.recordings-delete').click()`);await wait(300);
  assert.deepEqual(deleted,['rec1']);assert.ok(await js(`document.body.textContent.includes('No saved recordings yet')`),'Deleted recording still listed');
  assert.ok(configured['region-2']&&configured['region-2'].context!==context,'Both regions should be followed, each with its own context');
  const savedSecond=()=>js(`JSON.parse(localStorage.getItem('firefly-regions-Template%20fixture'))[1]`);
  // Following an object moves the box on screen, which the region editor shows in frame px (the frame is 320 wide)
  const shownX=async i=>{await js(`document.querySelectorAll('.region-row')[${i}].click()`);await wait(60);
   return js(`(()=>{const s=[...document.querySelectorAll('span')].find(s=>/^X [0-9]+px$/.test(s.textContent));return s?parseInt(s.querySelector('b').textContent):null})()`);};
  const secondAt=(x,token=configured['region-2'].context)=>({region:'region-2',context:token,x,y:.5,w:.1,h:.1,confidence:.9,found:true,templateId:'u1'});
  await emit({matches:[{x:.3,y:.2,w:.1,h:.1,confidence:.9,templateId:'t1'}]},context,[secondAt(.7)]);
  assert.equal(await shownX(0),96);assert.equal(await shownX(1),224,'The second region did not move with the first');
  // Only creating and editing a region saves it; following its object doesn't
  assert.equal((await savedRegion()).x,.1,'Following an object saved the region');assert.equal((await savedSecond()).x,.5,'Following an object saved the region');
  await emit({matches:[{x:.3,y:.2,w:.1,h:.1,confidence:.9,templateId:'t1'}]},context,[secondAt(.9,'obsolete-context')]);
  assert.equal(await shownX(1),224,'A result from before the second region changed moved it');
  // Following one object, a region can look only near where it was: the reach and where the box is now are sent
  const nearToggle=`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Only near where it was'))`;
  assert.equal(configured['region-2'].reach,-1,'A region should look through the whole window unless told otherwise');
  await js(`${nearToggle}.querySelector('input').click()`);await wait(150);
  assert.equal(configured['region-2'].reach,100);assert.equal(configured['region-2'].hint.x,.7,'The search should start from where the box is now');
  await js(`(()=>{const i=document.querySelector('[aria-label="How far from where it was to look"]');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'250');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(350);
  assert.equal(configured['region-2'].reach,250);assert.equal((await savedSecond()).searchReach,250);
  // When the object isn't near where it was: the same frame searched until it's found unless chosen, or
  // widened a step each frame, which is sent to the runtime and kept
  const widen=label=>`[...document.querySelectorAll('[aria-label="When it isn\\'t near where it was"] label')].find(l=>l.textContent.includes(${JSON.stringify(label)})).querySelector('input')`;
  assert.equal(configured['region-2'].widenEachFrame,false);
  assert.equal(await js(`${widen("Search the frame until it's found")}.checked`),true,'searching the frame until found is the default');
  await js(`${widen('Widen the search a step each frame')}.click()`);await wait(150);
  assert.equal(configured['region-2'].widenEachFrame,true,'widening each frame wasn\'t sent');
  assert.equal((await savedSecond()).searchWiden,'frames');
  await js(`${widen("Search the frame until it's found")}.click()`);await wait(150);
  assert.equal(configured['region-2'].widenEachFrame,false);
  // How much further each step looks: twice unless chosen, for either way of widening
  assert.equal(configured['region-2'].widenBy,2);
  await js(`(()=>{const i=document.querySelector('[aria-label="How much further each step looks"]');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'3.5');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(350);
  assert.equal(configured['region-2'].widenBy,3.5,'the step wasn\'t sent');
  assert.equal((await savedSecond()).searchWidenBy,3.5);
  assert.ok(await js(`document.body.textContent.includes('3.5× as far')`),'the step isn\'t shown');
  win.webContents.invalidate();await wait(150);fs.writeFileSync(path.join(root,'build/template-region-editor.png'),(await win.webContents.capturePage()).toPNG());
  await shownX(0);assert.equal(await js(`!!${nearToggle}`),false,'Multi-match finds every instance, so it has no search area');
  const weaker={x:.2,y:.2,w:.1,h:.1,confidence:.8,templateId:'t1'},best={...weaker,x:.6,confidence:.97,templateId:'t2'};
  await emit({matches:[weaker,best],topConfidence:.97});assert.equal(await shownX(0),192);assert.equal(await shownX(1),224,'A result without the second region moved it');
  await emit({matches:[{...best,x:.8}]},'obsolete-context');assert.equal(await shownX(0),192);
  await js(`Array.from(document.querySelectorAll('.insp-section')).find(s=>s.querySelector('.insp-section-hd')?.textContent.includes('States')).querySelector('button').click()`);await wait(100);
  await clickText('Region');assert.equal(await js(`document.querySelector('[aria-label="State value"]').value`),'@template-detected');
  // A region that follows its object also offers where its box is and how fast it moves
  assert.deepEqual(await js(`[...document.querySelector('[aria-label="State value"]').options].map(o=>o.value).filter(v=>v==='@position'||v==='@velocity')`),['@position','@velocity']);
  await toggle('State templates',null);
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add State').disabled`),true);
  await toggle('State templates',1);await toggle('State templates',2);
  win.webContents.invalidate();await wait(150);fs.writeFileSync(path.join(root,'build/template-state-picker.png'),(await win.webContents.capturePage()).toPNG());
  await clickText('Add State');assert.deepEqual((await savedState()).templateIds,['t1','t2']);
  // In the recording setup, a State shows under its own name, before the other observations, and can't be
  // ticked until the runtime observes it
  assert.deepEqual(await rows(),['State 1','hp','frame'],'States should come first, then the other observations');
  assert.equal(await js(`document.querySelector('.recordings-setup .rec-field-off input').disabled`),true,'A State not observed yet should not be tickable');
  await js(`[...document.querySelectorAll('.panel-tab')].find(t=>t.textContent.startsWith('Recordings')).click()`);await wait(200);
  win.webContents.invalidate();await wait(150);fs.writeFileSync(path.join(root,'build/template-recording-setup.png'),(await win.webContents.capturePage()).toPNG());assert.equal((await savedState()).type,'boolean');
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true);
  await emit({matches:[{...weaker,confidence:.99}]});assert.equal(await shownX(0),64);
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true);
  await emit({matches:[{...weaker,templateId:'t3'}]});
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-false')`),true);
  await emit({matches:[weaker]});
  await js(`document.querySelector('.state-row').click()`);await wait(100);
  await toggle('Templates for State 1',1);assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-false')`),true);
  await toggle('Templates for State 1',2);assert.deepEqual((await savedState()).templateIds,[]);
  await toggle('Templates for State 1',null);assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true);
  await toggle('Templates for State 1',1);await toggle('Templates for State 1',2);
  await emit({matches:[],found:false,topConfidence:0});assert.equal(await shownX(0),64);
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-false')`),true);
  await js(`document.querySelector('.tp-btn-main').click()`);await wait(100);
  await emit({matches:[best]});assert.equal(await shownX(0),64,'paused region moved');
  await js(`document.querySelector('.tp-btn-main').click()`);await wait(100);
  await emit({...best,found:true});assert.equal(await shownX(0),192,'single match did not track');
  win.reload();await wait(400);await start();assert.deepEqual((await savedState()).templateIds,['t1','t2']);
  await emit({matches:[best]});assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true);
  win.webContents.invalidate();await wait(150);fs.writeFileSync(path.join(root,'build/template-tracking-ui.png'),(await win.webContents.capturePage()).toPNG());
  await js(`(()=>{const key='firefly-states-Template%20fixture';const states=JSON.parse(localStorage.getItem(key));delete states[0].templateIds;states[0].templateId='t2';states[0].settleMs=250;
   states.push({id:'second-seen',name:'Second seen',type:'boolean',source:'region',regionId:'region-2',output:'@template-detected'},{id:'where',name:'Where',type:'vector',source:'region',regionId:'region',output:'@position'},{id:'speed',name:'Speed',type:'vector',source:'region',regionId:'region',output:'@velocity'});
   localStorage.setItem(key,JSON.stringify(states));})()`);
  win.reload();await wait(400);await start();await emit({matches:[best]});
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true);
  // Position and velocity states show what the runtime works out for the region, and nothing while its object is lost
  const chipOf=name=>js(`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name').textContent===${JSON.stringify(name)})?.querySelector('.state-val-chip')?.textContent??null`);
  await emit({matches:[best],position:[200.4,50],velocity:[120,-30.2]});
  assert.equal(await chipOf('Where'),'(200, 50)');assert.equal(await chipOf('Speed'),'(120, -30)');
  await emit({matches:[],found:false,position:null,velocity:null});
  assert.equal(await chipOf('Where'),'–');assert.equal(await chipOf('Speed'),'–');
  // With a settle time chosen, a template state rides out a frame or two of another answer, by capture time
  const stateTrue=()=>js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`);
  await emit({matches:[best]},context,[],9700);assert.equal(await stateTrue(),false,'A new answer should wait for its settle time too');
  await emit({matches:[best]},context,[],10000);assert.equal(await stateTrue(),true);
  await emit({matches:[weaker]},context,[],10100);assert.equal(await stateTrue(),true,'Another template winning one frame flipped the state');
  await emit({matches:[],found:false},context,[],10200);assert.equal(await stateTrue(),true,'Losing the object for a moment flipped the state');
  await emit({matches:[weaker]},context,[],10400);assert.equal(await stateTrue(),false,'A lasting change was not taken');
  await emit({matches:[best]},context,[],10450);assert.equal(await stateTrue(),false);
  await emit({matches:[best]},context,[],10750);assert.equal(await stateTrue(),true);
  // By default there's no settle time: an answer is taken at once. Following one object, a frame it isn't
  // found in keeps the state as it was, for up to half a second, and then it's gone
  const seen=()=>js(`[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name').textContent==='Second seen')?.querySelector('.state-val-chip')?.classList.contains('state-val-true')??null`);
  const second2=(found,t)=>emit({matches:[best]},context,[found?{...secondAt(.7),detected:[{x:.7,y:.5,w:.1,h:.1,confidence:.9,templateId:'u1'}]}
    :{region:'region-2',context:configured['region-2'].context,found:false,confidence:.2,detected:[]}],t);
  await second2(false,10800);assert.equal(await seen(),false);
  await second2(true,10850);assert.equal(await seen(),true,'A new answer waited without a settle time');
  await second2(false,10900);assert.equal(await seen(),true,'A frame of losing the object flipped the state');
  await second2(false,11300);assert.equal(await seen(),true,'Losing the object briefly flipped the state');
  await second2(false,11450);assert.equal(await seen(),false,'An object gone for good kept its state');
  await emit({matches:[best]});
  await js(`document.querySelector('.state-row').click()`);await wait(100);
  assert.equal(await js(`document.querySelector('[aria-label="Templates for State 1"] [aria-label="Template 2"]').checked`),true);
  assert.equal(await js(`document.querySelector('[aria-label="Templates for State 1"] [aria-label="Template 1"]').checked`),false);
  // Following one object, a state reads every template that won a place of its own, not only the one the box follows
  await emit({...weaker,confidence:.99,found:true,detected:[{...weaker,confidence:.99},best]});
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-true')`),true,'A visible template that wasn’t the best left its state false');
  await emit({...weaker,confidence:.99,found:true,detected:[{...weaker,confidence:.99}]});
  assert.equal(await js(`document.querySelector('.state-val-chip').classList.contains('state-val-false')`),true);
  await js(`document.querySelectorAll('.region-del')[1].click()`);await wait(150);
  assert.deepEqual(removed,['region-2'],'Deleting a region should stop following only it');
  await emit({matches:[{...best,x:.4}]});assert.equal(await shownX(0),128,'Deleting one region stopped the other');
  assert.equal((await savedRegion()).x,.1,'Following an object saved the region');
  // The least confidence to accept is chosen from 0 to 100% in the region editor and sent to the runtime.
  // A match under it doesn't move the box, but the confidence bar still shows how well it matched.
  const setThreshold=async v=>{await js(`(()=>{const i=document.querySelector('[aria-label="Least confidence to accept"]');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${v}');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(350);};
  assert.equal(await shownX(0),128);
  assert.deepEqual(await js(`(()=>{const i=document.querySelector('[aria-label="Least confidence to accept"]');return [i.min,i.max]})()`),['0','1']);
  await setThreshold(.95);assert.equal(configured.region.threshold,.95,'The threshold was not sent to the runtime');
  assert.equal((await savedRegion()).matchThreshold,.95);
  await emit({...best,x:.7,confidence:.9,found:true});
  assert.equal(await shownX(0),128,'A match under the threshold moved the box');
  assert.equal(await js(`document.querySelector('.rtp-conf-val').textContent`),'90%','The confidence under the threshold was not shown');
  await setThreshold(.5);assert.equal(configured.region.threshold,.5);
  // A drag let go outside the Game View still ends, so the box goes on following its object
  await js(`(()=>{const c=document.querySelector('canvas.vp-roi-canvas'),img=document.querySelector('.vp-preview-img'),r=c.getBoundingClientRect();
   const nw=img.naturalWidth,nh=img.naturalHeight,s=Math.min(1,c.width/nw,c.height/nh),ox=(c.width-nw*s)/2,oy=(c.height-nh*s)/2;
   c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+ox+.45*nw*s,clientY:r.top+oy+.25*nh*s}));
   document.body.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);await wait(100);
  await emit({matches:[{...best,x:.5}]});assert.equal(await shownX(0),160,'A drag let go outside the Game View stopped the box following its object');
  // Switching following off in the region editor keeps the box where its object was, and saves it there
  await js(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('Follow the object in this box')).querySelector('input').click()`);await wait(150);
  assert.equal((await savedRegion()).x,.5,'Turning following off did not save the box where its object was');
  assert.equal(await shownX(0),160);
  assert.deepEqual(errors,[]);
  console.log('PASS: several regions followed from the same frames, strongest instance tracking, multiple-template OR states, excluded winners, any/empty selection, edit/persistence, legacy single-template migration, no-match and paused/single tracking.');
  clearTimeout(watchdog);win.destroy();app.exit(0);
 }catch(e){console.error(e);clearTimeout(watchdog);if(win&&!win.isDestroyed())fs.writeFileSync(path.join(root,'build/template-ui-failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(1);}
});
