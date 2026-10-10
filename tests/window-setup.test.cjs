const {test}=require('node:test');
const assert=require('node:assert/strict');
// localStorage, as far as windowSetup.ts uses it
const store=entries=>{const m=new Map(Object.entries(entries));return {get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.has(k)?m.get(k):null,
 setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),dump:()=>Object.fromEntries(m)};};
const enc=encodeURIComponent,old='MapleStory - Scania',fresh='MapleStory - Bera';
const library=(ids)=>JSON.stringify({version:1,selected:ids[0],entries:[{id:'policies',parent:null,kind:'folder',name:'Policies'},...ids.map(id=>({id,parent:'policies',kind:'policy',name:id}))]});
const saved=()=>store({
 [`firefly-states-${enc(old)}`]:JSON.stringify([{id:'s1',name:'hp',source:'script',script:'return 1'},{id:'s2',name:'x',source:'region',regionId:'r1'}]),
 [`firefly-state-folders-${enc(old)}`]:JSON.stringify([{id:'f1',name:'Player'}]),
 [`firefly-regions-${enc(old)}`]:JSON.stringify([{id:'r1',label:'Mini map',source:'script',script:'return {}'}]),
 [`firefly-record-setup-${enc(old)}`]:JSON.stringify({buttons:['left','alt'],hz:20}),
 [`firefly-recorded-${enc(old)}`]:JSON.stringify({hp:true}),
 [`firefly-policy-graph-${enc(old)}-library`]:library(['g1','g2']),
 [`firefly-policy-graph-${enc(old)}-document-g1`]:'{"version":1,"nodes":[1],"edges":[]}',
 [`firefly-policy-graph-${enc(old)}-document-g2`]:'{"version":1,"nodes":[2],"edges":[]}',
 [`firefly-policy-graph-${enc(old)}-document-g1-view`]:'{"x":1}',
 // Another window whose title starts with the old one's: its graph isn't the old one's
 [`firefly-policy-graph-${enc(old)}-2-library`]:library(['other']),
 // What the new window had: the recording setup every window gets, and a graph library made when it was opened
 [`firefly-record-setup-${enc(fresh)}`]:JSON.stringify({buttons:['w'],hz:15}),
 [`firefly-policy-graph-${enc(fresh)}-library`]:library(['empty']),
 [`firefly-policy-graph-${enc(fresh)}-document-empty`]:'{"version":1,"nodes":[],"edges":[]}',
});

test('windows with States or Regions are found by their titles, with what each has, but the one asked about',async()=>{
 const {savedSetups}=await import('../src/windowSetup.ts');
 const s=saved();
 assert.deepEqual(savedSetups(s,fresh).map(x=>[x.title,x.states,x.regions,x.graphs]),[[old,2,1,2]],'graphs alone (every window opened has one) aren’t a setup');
 assert.deepEqual(savedSetups(s,old),[]);
 s.setItem(`firefly-regions-${enc('Other')}`,'[{"id":"r"}]');
 assert.deepEqual(savedSetups(s,fresh).map(x=>x.title),[old,'Other'],'most first');
});

test('a setup is copied by part, in place of what the window had',async()=>{
 const {copySetup,setupOf}=await import('../src/windowSetup.ts');
 const s=saved();
 copySetup(s,old,fresh,['states']);
 const d=s.dump();
 assert.equal(d[`firefly-states-${enc(fresh)}`],d[`firefly-states-${enc(old)}`],'States, with their Lua scripts');
 assert.equal(d[`firefly-state-folders-${enc(fresh)}`],d[`firefly-state-folders-${enc(old)}`]);
 assert.equal(d[`firefly-regions-${enc(fresh)}`],d[`firefly-regions-${enc(old)}`],'Regions, with theirs');
 assert.deepEqual(JSON.parse(d[`firefly-record-setup-${enc(fresh)}`]),{buttons:['w'],hz:15},'the recording setup wasn’t asked for');
 assert.equal(setupOf(s,fresh).graphs,1);
 copySetup(s,old,fresh,['graphs','recording']);
 const e=s.dump();
 assert.equal(e[`firefly-policy-graph-${enc(fresh)}-library`],e[`firefly-policy-graph-${enc(old)}-library`]);
 assert.equal(e[`firefly-policy-graph-${enc(fresh)}-document-g2`],'{"version":1,"nodes":[2],"edges":[]}');
 assert.equal(e[`firefly-policy-graph-${enc(fresh)}-document-g1-view`],'{"x":1}');
 assert.equal(e[`firefly-policy-graph-${enc(fresh)}-document-empty`],undefined,'its own graph went with its library');
 assert.ok(!Object.keys(e).some(k=>k.startsWith(`firefly-policy-graph-${enc(fresh)}-2`)),'another window’s graph came along');
 assert.deepEqual(JSON.parse(e[`firefly-record-setup-${enc(fresh)}`]),{buttons:['left','alt'],hz:20});
 assert.equal(e[`firefly-recorded-${enc(fresh)}`],'{"hp":true}');
 // The window copied from is as it was
 assert.equal(Object.keys(e).filter(k=>k.includes(enc(old))).length,Object.keys(saved().dump()).filter(k=>k.includes(enc(old))).length);
});

test('a part the other window has none of leaves this one with none of it either',async()=>{
 const {copySetup}=await import('../src/windowSetup.ts');
 const s=saved();
 s.setItem(`firefly-states-${enc('Empty')}`,'[]');
 copySetup(s,'Empty',old,['states']);
 assert.equal(s.getItem(`firefly-regions-${enc(old)}`),null);
 assert.equal(s.getItem(`firefly-states-${enc(old)}`),'[]');
});

test('a setup goes into a file under {window} and comes out under whatever window it is imported for', async () => {
 const {exportSetup, importSetupFile, fileSummary, WINDOW} = await import('../src/windowSetup.ts');
 const s = saved();
 // A collection graph whose Dataset Output saves into a folder on this PC
 s.setItem(`firefly-policy-graph-${enc(old)}-document-g2`, JSON.stringify({version: 1, nodes: [{id: 'o', data: {kind: 'output', directory: 'C:\Users\me\FireFly\dataset', pattern: '{map}'}}], edges: []}));
 const file = exportSetup(s, old, ['states', 'graphs', 'recording']);
 assert.deepEqual(file.parts, ['states', 'graphs', 'recording']);
 assert.ok(Object.keys(file.entries).every(k => k.includes(WINDOW) && !k.includes(enc(old))), 'keyed by {window}, not the title');
 assert.ok(!Object.keys(file.entries).some(k => k.includes('other')), 'a window whose title starts with this one’s isn’t in it');
 assert.equal(file.cleared, 1, 'the Dataset Output folder was left out');
 assert.equal(JSON.parse(file.entries[`firefly-policy-graph-${WINDOW}-document-g2`]).nodes[0].data.directory, '');
 assert.equal(JSON.parse(file.entries[`firefly-policy-graph-${WINDOW}-document-g2`]).nodes[0].data.pattern, '{map}');
 const sum = fileSummary(file.entries);
 assert.deepEqual([sum.states, sum.regions, sum.graphs, sum.parts], [2, 1, 2, ['states', 'graphs', 'recording']]);

 // Into another PC's window, titled differently, which had its own recording setup and an empty graph
 const other = store({[`firefly-record-setup-${enc(fresh)}`]: JSON.stringify({buttons: ['w'], hz: 15}),
  [`firefly-policy-graph-${enc(fresh)}-library`]: library(['empty']), [`firefly-policy-graph-${enc(fresh)}-document-empty`]: '{}'});
 importSetupFile(other, fresh, {...file.entries, 'firefly-train-config': '{"dataDir":"C:\\x"}', 'something-else': '1'}, ['states', 'graphs']);
 const got = other.dump();
 assert.equal(JSON.parse(got[`firefly-states-${enc(fresh)}`]).length, 2);
 assert.equal(JSON.parse(got[`firefly-regions-${enc(fresh)}`])[0].label, 'Mini map');
 assert.ok(got[`firefly-policy-graph-${enc(fresh)}-document-g1`] && !got[`firefly-policy-graph-${enc(fresh)}-document-empty`], 'its graphs replace the old ones');
 assert.equal(got[`firefly-record-setup-${enc(fresh)}`], JSON.stringify({buttons: ['w'], hz: 15}), 'a part not chosen is left alone');
 assert.ok(!('firefly-train-config' in got) && !('something-else' in got), 'keys FireFly doesn’t import are ignored');
});
