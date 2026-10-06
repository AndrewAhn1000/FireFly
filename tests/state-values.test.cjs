const {test}=require('node:test');
const assert=require('node:assert/strict');

test('Lua state values match their declared types without coercion',async()=>{
 const {stateValueError:check}=await import('../src/stateValues.ts');
 const boxes=[{x:10,y:20,w:30,h:40}];
 for(const value of [boxes,[],{},null,undefined,'42',true,NaN,Infinity])assert.ok(check('number',value));
 assert.match(check('number',boxes),/Expected Number.*returned a list/);
 for(const value of [0,-42,1.5])assert.equal(check('number',value),null);
 for(const value of [true,false])assert.equal(check('boolean',value),null);
 for(const value of [0,1,'true',boxes])assert.ok(check('boolean',value));
 for(const value of [[1,2],{x:1,y:-2}])assert.equal(check('vector',value),null);
 for(const value of [[1],[1,2,3],[1,'2'],{x:NaN,y:2},boxes])assert.ok(check('vector',value));
 assert.equal(check('text','hello'),null);assert.ok(check('text',42));
 for(const value of [boxes,[],{}])assert.equal(check('collection',value),null);
 for(const value of [42,'hello',null,{x:1}])assert.ok(check('collection',value));
 assert.equal(check('object',{x:1}),null);assert.ok(check('object',boxes));
 assert.equal(check('category','walking'),null);assert.equal(check('category',1),null);assert.ok(check('category',boxes));
});
