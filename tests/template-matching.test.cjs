const {test}=require('node:test');
const assert=require('node:assert/strict');
test('region follows highest confidence regardless of array order; no match has no new bounds',async()=>{
 const {strongestMatch}=await import('../src/templateMatching.ts');
 const a={x:.1,y:.1,w:.1,h:.1,confidence:.8,templateId:'a'},b={...a,x:.7,confidence:.96,templateId:'b'};
 assert.equal(strongestMatch([a,b]),b);assert.equal(strongestMatch([b,a]),b);assert.equal(strongestMatch([]),undefined);
});
test('multiple selections use OR over winning identities, preserve legacy states and keep empty distinct from any',async()=>{
 const {templateDetected,selectedTemplateIds}=await import('../src/templateMatching.ts');
 const frame=id=>({regionId:'r',matches:[{x:0,y:0,w:.1,h:.1,confidence:.98,templateId:id}]});
 const available=['a','b','c'];
 for(const id of ['a','b'])assert.equal(templateDetected(frame(id),'r',['a','b'],available),true);
 assert.equal(templateDetected(frame('c'),'r',['a','b'],available),false);
 assert.equal(templateDetected(frame('a'),'r',[],available),false);
 assert.equal(templateDetected(frame('c'),'r',undefined,available),true);
 assert.equal(templateDetected(frame('a'),'r',['deleted','a'],available),true);
 assert.equal(templateDetected(frame('b'),'r',['deleted','a'],available),false);
 assert.equal(templateDetected(frame('a'),'r',['deleted'],available),undefined);
 assert.deepEqual(selectedTemplateIds({templateId:'a'}),['a']);
 assert.deepEqual(selectedTemplateIds({templateId:'a',templateIds:[]}),[]);
 assert.deepEqual(selectedTemplateIds({templateIds:['a','b']}),['a','b']);
 assert.equal(selectedTemplateIds({}),undefined);
});
test('template states read winning identities and distinguish no match from unavailable',async()=>{
 const {templateDetected}=await import('../src/templateMatching.ts');
 const snapshot={regionId:'region',matches:[{x:.7,y:.1,w:.1,h:.1,confidence:.96,templateId:'b'}]};
 assert.equal(templateDetected(snapshot,'region','a',['a','b']),false);
 assert.equal(templateDetected(snapshot,'region','b',['a','b']),true);
 assert.equal(templateDetected(snapshot,'region',undefined,['a','b']),true);
 assert.equal(templateDetected({...snapshot,matches:[]},'region','b',['b']),false);
 assert.equal(templateDetected(null,'region','b',['b']),undefined);
 assert.equal(templateDetected(snapshot,'different','b',['b']),undefined);
 assert.equal(templateDetected(snapshot,'region','deleted',['a','b']),undefined);
 assert.equal(templateDetected(snapshot,'region',undefined,[]),undefined);
});
test('a template state takes a new answer only once it has held for its settle time',async()=>{
 const {settle}=await import('../src/templateMatching.ts');
 let s=settle(undefined,true,1000,'k',250);assert.equal(s.value,true);
 s=settle(s,false,1100,'k',250);assert.equal(s.value,true,'one frame flipped it');
 s=settle(s,false,1300,'k',250);assert.equal(s.value,true);
 s=settle(s,true,1320,'k',250);assert.equal(s.value,true);assert.equal(s.next,undefined,'a return to the shown answer should cancel the change');
 s=settle(s,false,1400,'k',250);s=settle(s,false,1660,'k',250);assert.equal(s.value,false,'a lasting change was not taken');
 assert.equal(settle(s,true,1700,'k',0).value,true,'no settle time takes an answer at once');
 assert.equal(settle(s,true,null,'k',250).value,true,'no capture time takes an answer at once');
 assert.equal(settle(s,true,1700,'other',250).value,true,'a changed selection takes an answer at once');
 assert.equal(settle(s,undefined,1700,'k',250).value,undefined,'unavailable is shown at once');
});
