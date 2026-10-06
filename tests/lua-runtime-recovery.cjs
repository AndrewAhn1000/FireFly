const assert = require('node:assert/strict');

module.exports = async function checkLuaRuntimeRecovery(invoke) {
  // The exact same source reuses one cached VM, alternating failures and success.
  // Globals intentionally persist; local variables and returned tables must not.
  const script = `
recoveryRun = (recoveryRun or 0) + 1
local localRun = 0
localRun = localRun + 1
local boxes = {{x=56,y=92,w=162,h=121}}
if recoveryRun % 2 == 1 then
    return read_i32(0xFFFFFFEE + 0x1C)
end
return {run=recoveryRun, localRun=localRun, boxes=boxes, size=get_window_size()}
`;
  for (let i=1;i<=50;i++) {
    await assert.rejects(invoke('memory.run_script',{script}),/read failed at 0x10000000a/);
    const {value}=await invoke('memory.run_script',{script});
    assert.equal(value.run,i*2);
    assert.equal(value.localRun,1);
    assert.deepEqual(value.boxes,[{x:56,y:92,w:162,h:121}]);
    assert.ok(value.size.w>0 && value.size.h>0);
  }
  // A different script's cache entry must not see the previous script's global.
  assert.equal((await invoke('memory.run_script',{script:'return recoveryRun == nil'})).value,true);
  // UI States/Regions send concurrent requests, while native execution is serial.
  // Distinct script results must never be routed into one another's responses.
  const scripts=Array.from({length:8},(_,i)=>`return {source=${i},x=${100+i},y=${200+i},w=${30+i},h=${40+i}}`);
  for(let round=0;round<20;round++) {
    const results=await Promise.all(scripts.map(script=>invoke('memory.run_script',{script})));
    results.forEach((result,i)=>assert.deepEqual(result.value,{source:i,x:100+i,y:200+i,w:30+i,h:40+i}));
  }
  console.log('PASS: 50 failed reads followed by successful runs in the same Lua VM; locals reset and globals persist only within that cached script');
  console.log('PASS: 160 concurrent Lua requests kept each script result paired with its own request');
};
