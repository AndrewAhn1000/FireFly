// Production renderer + preload, isolated profile, deterministic capture/match events.
// Paused, a region's box is moved, resized and cut into templates where it's shown over the paused frame,
// not where its object is being followed to in the live frames behind it.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setPath('userData',path.join(root,'build','paused-region-edit-ui-profile'));
let win,context='';
const watchdog=setTimeout(()=>{console.error('Paused region edit UI test timed out');app.exit(1);},45000);
app.whenReady().then(async()=>{
 try {
  // Each pixel's colour says where it is: red is its x and green its y, so a template's first pixel says where it was cut
  const W=200,H=150,pixels=Buffer.alloc(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;pixels[i]=0;pixels[i+1]=y;pixels[i+2]=x;pixels[i+3]=255;}
  const image=nativeImage.createFromBitmap(pixels,{width:W,height:H}),url=image.toDataURL();
  const fixture={id:'region',label:'Tracked object',x:.1,y:.1,w:.2,h:.2,match:true,templates:[{id:'t1',cropUrl:url}]};
  for(const [channel,result] of [['runtime:available',true],['runtime:status',{ready:true,error:null}],['windows:thumbnails',{}],['models:list',[]],['models:probe',null],['training:check-checkpoint',{found:false}],['training:gpu-check',{available:false}],['collection:status',[]]])ipcMain.handle(channel,()=>result);
  ipcMain.handle('runtime:invoke',async(_,op,args)=>{
   if(op==='windows')return {windows:[{id:'123',title:'Paused fixture',pid:1}]};
   if(op==='template.set'&&args.region==='region')context=args.context;
   if(op==='observe.fields')return {fields:[]};
   if(op==='dataset.list')return {recordings:[]};
   if(op==='frame'){await wait(30);return {dataUrl:url,timestamp:Date.now(),jpeg:image.toJPEG(95)};}
   return {ok:true};
  });
  win=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{offscreen:true,preload:path.join(root,'electron/preload.cjs'),backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<60;i++){if(await js(code))return;await wait(50);}throw Error('UI condition failed: '+code);};
  const emit=async box=>{win.webContents.send('runtime:event',{event:'template.match',result:{timestamp:Date.now(),regions:[{region:'region',context,...box,confidence:.9,found:true,templateId:'t1'}]}});await wait(250);};
  const saved=()=>js(`JSON.parse(localStorage.getItem('firefly-regions-Paused%20fixture'))[0]`);
  // The box the region editor shows, in frame px
  const shown=async()=>{await js(`document.querySelector('.region-row').click()`);await wait(60);
   return js(`(()=>{const v=k=>{const s=[...document.querySelectorAll('span')].find(s=>new RegExp('^'+k+' [0-9]+px$').test(s.textContent));return s?parseInt(s.querySelector('b').textContent):null};return {x:v('X'),y:v('Y'),w:v('W'),h:v('H')}})()`);};
  // Where in the frame the newest template was cut from, by the colour of its first pixel
  const cutAt=async()=>{const t=(await saved()).templates.at(-1);
   return js(`new Promise(ok=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);const p=g.getImageData(0,0,1,1).data;ok({x:p[0],y:p[1],w:i.width,h:i.height});};i.src=${JSON.stringify(t.cropUrl)};})`);};
  const near=(got,want,msg)=>{for(const k of Object.keys(want))assert.ok(Math.abs(got[k]-want[k])<=3,`${msg}: ${JSON.stringify(got)} is not ${JSON.stringify(want)}`);};
  const addTemplate=async()=>{const n=(await saved()).templates.length;await js(`document.querySelector('.rtp-thumb-add').click()`);
   for(let i=0;i<40&&(await saved()).templates.length===n;i++)await wait(50);};
  // Drags with the mouse from one frame point to another, in frame px
  const drag=async(from,to)=>{await js(`(()=>{const c=document.querySelector('canvas.vp-roi-canvas'),img=document.querySelector('.vp-preview-img'),r=c.getBoundingClientRect();
   const nw=img.naturalWidth,nh=img.naturalHeight,s=Math.min(1,c.width/nw,c.height/nh),ox=(c.width-nw*s)/2,oy=(c.height-nh*s)/2;
   const at=([x,y])=>({bubbles:true,clientX:r.left+ox+x*s,clientY:r.top+oy+y*s});
   c.dispatchEvent(new MouseEvent('mousedown',at(${JSON.stringify(from)})));
   c.dispatchEvent(new MouseEvent('mousemove',at(${JSON.stringify(to)})));
   c.dispatchEvent(new MouseEvent('mouseup',at(${JSON.stringify(to)})));})()`);await wait(150);};
  const transport=()=>js(`document.querySelector('.tp-btn-main').click()`).then(()=>wait(150));

  await win.loadFile(path.join(root,'dist/index.html'));
  await js(`localStorage.clear();localStorage.setItem('firefly-regions-Paused%20fixture',${JSON.stringify(JSON.stringify([fixture]))})`);
  win.reload();await wait(400);
  await until(`!!document.querySelector('.win-item')`);await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Start Session').click()`);
  await until(`document.body.textContent.includes('Capturing:')`);await wait(250);assert.ok(context);

  // Followed to (100, 75), then paused there
  await emit({x:.5,y:.5,w:.2,h:.2});await wait(150);
  near(await shown(),{x:100,y:75},'Live, the box is where its object was found');
  await transport();
  // The object moves on in the live frames behind the paused one
  await emit({x:.2,y:.2,w:.2,h:.2});
  near(await shown(),{x:100,y:75},'Paused, the box moved with the live frames');
  // A template is cut from where the box is shown over the paused frame
  await addTemplate();near(await cutAt(),{x:100,y:75,w:40,h:30},'Paused, the template was cut from the live position');

  // Moved by hand while paused, it stays where it's put
  await drag([120,90],[160,100]);
  near(await shown(),{x:140,y:85},'A box moved while paused snapped back');
  assert.ok(Math.abs((await saved()).x-.7)<.02,'A box moved while paused was not saved');
  await emit({x:.2,y:.2,w:.2,h:.2});
  near(await shown(),{x:140,y:85},'Following the live frames moved a box placed while paused');
  await addTemplate();near(await cutAt(),{x:140,y:85,w:40,h:30},'The template was not cut from where the box was moved to');

  // Resized by its corner handle
  await drag([180,115],[170,110]);
  near(await shown(),{x:140,y:85,w:30,h:25},'A box resized while paused snapped back');
  await addTemplate();near(await cutAt(),{x:140,y:85,w:30,h:25},'The template was not cut from the resized box');

  // The arrow keys move it a pixel at a time
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);await wait(400);
  near(await shown(),{x:141,y:85},'An arrow key did not move the box while paused');

  // Live again, it goes back to following its object
  await transport();await emit({x:.3,y:.4,w:.2,h:.2});
  near(await shown(),{x:60,y:60},'Live again, the box did not follow its object');
  assert.deepEqual(errors,[]);
  console.log('PASS: paused boxes are moved, resized, nudged and cut into templates where they are shown, and follow their object again when live');
  clearTimeout(watchdog);app.exit(0);
 } catch(e) {console.error(e);app.exit(1);}
});
