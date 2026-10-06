// Execute the saved script in the real Lua VM with deterministic, changing memory.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function checkMonsterScript(invoke) {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/monsters.lua'), 'utf8');
  for (const mode of ['stable', 'settles', 'unstable', 'partial', 'reversed', 'empty', 'missing-camera', 'missing-pool', 'missing-list', 'missing-rect', 'changed-count', 'recover']) {
    const setup = `
local pointers = {
    [0xBF14EC]=0x1000, [0xBEBFA4]=0x2000, [0x2028]=0x3000,
    [0x3004]=0x4000, [0x44C0]=0x5000, [0x5040]=0x6000, [0x6024]=0x7000,
    [0x2FF4]=0x8000, [0x8014]=0x4100, [0x45C0]=0x5100, [0x5140]=0x6100, [0x6124]=0x7100
}
if '${mode}'=='empty' then pointers[0x3004]=0 end
if '${mode}'=='missing-camera' then pointers[0xBF14EC]=0 end
if '${mode}'=='missing-pool' then pointers[0xBEBFA4]=0 end
if '${mode}'=='missing-list' then pointers[0x2028]=0 end
if '${mode}'=='missing-rect' then pointers[0x6024]=0 end
recoveryRound=(recoveryRound or 0)+1
local reads, cameraReads, countReads = 0, 0, 0
local function read_u32(address) return pointers[address] or 0 end
local function read_i32(address)
    if address == 0x10F8 then cameraReads=cameraReads+1; return cameraReads*100 end
    if address == 0x10FC then return 200 end
    if address == 0x2024 then
        countReads=countReads+1
        if '${mode}'=='partial' or '${mode}'=='missing-list' then return 1 end
        if '${mode}'=='changed-count' and countReads>1 then return 1 end
        return 0
    end
    if address>=0x7100 and address<0x7200 then
        return ({[0x7160]=156,[0x7164]=292,[0x7170]=318,[0x7174]=413})[address]
    end
    reads=reads+1
    local sample=math.floor((reads-1)/4)
    local x2=318
    if '${mode}' == 'unstable' or '${mode}'=='partial' or ('${mode}'=='recover' and recoveryRound==2) then x2=x2+sample*1000 end
    if '${mode}'=='recover' and recoveryRound==3 then x2=320 end
    if '${mode}' == 'settles' and sample == 0 then x2=10000 end
    local values = {[0x7060]=156, [0x7064]=292, [0x7070]=x2, [0x7074]=413}
    if '${mode}' == 'reversed' then values={[0x7060]=318,[0x7064]=413,[0x7070]=156,[0x7074]=292} end
    return values[address] or 0
end
`;
    const result = await invoke('memory.run_script', {script: setup + script});
    if (['unstable','partial','missing-camera','missing-pool','missing-list','missing-rect','changed-count'].includes(mode))
      assert.equal(result.value,null,`${mode}: unavailable reads must return nil, not an empty/partial list`);
    else if(mode==='empty') assert.deepEqual(result.value,{});
    else assert.deepEqual(result.value,[{x:56,y:92,w:162,h:121}],mode);
    if(mode==='recover') {
      assert.equal((await invoke('memory.run_script',{script:setup+script})).value,null);
      assert.deepEqual((await invoke('memory.run_script',{script:setup+script})).value,[{x:56,y:92,w:164,h:121}]);
    }
  }
};
