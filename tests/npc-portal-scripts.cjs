const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const luaMap = values => '{' + Object.entries(values).map(([k,v])=>`[${k}]=${v}`).join(',') + '}';
module.exports = async function checkNpcPortalScripts(invoke) {
  const portalSource=fs.readFileSync(path.join(__dirname,'../scripts/portals.lua'),'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname,'../scripts/portal-diagnostics.lua'),'utf8'),
    portalSource.replace('local DIAGNOSTICS = false','local DIAGNOSTICS = true'),
    'Diagnostics must execute the exact same traversal and checks as the Region script');
  const run = async (file,setup) => (await invoke('memory.run_script', {
    script: setup + fs.readFileSync(path.join(__dirname,'../scripts',file),'utf8')
  })).value;
  const npcPointers = {
    [0xBF14EC]:0x1000,[0xBF5198]:0x2000,[0x2028]:0x3000,
    [0x3004]:0x3100,[0x3010]:0x4000,[0x40E4]:0x5000,[0x5040]:0x6000,[0x6024]:0x7000,
    [0x3110]:0x4100,[0x41E4]:0x5100,[0x5140]:0x6100,[0x6124]:0x7100,
    [0x711C]:0x7200,[0x7224]:0x7300
  };
  for (const mode of ['stable','settles','unstable','partial','reversed','size-filter','all-filtered','empty','missing-camera','missing-pool','missing-node','missing-rect','changed-count']) {
    const setup = `
local pointers=${luaMap(npcPointers)}
if '${mode}'=='missing-camera' then pointers[0xBF14EC]=0 end
if '${mode}'=='missing-pool' then pointers[0xBF5198]=0 end
if '${mode}'=='missing-node' then pointers[0x3004]=0 end
if '${mode}'=='missing-rect' then pointers[0x7224]=0 end
local cameraReads, countReads, reads = 0, 0, {}
local function read_u32(a) return pointers[a] or 0 end
local function read_i32(a)
    if a==0x10F8 then cameraReads=cameraReads+1; return cameraReads*100 end
    if a==0x10FC then return 200 end
    if a==0x2024 then
        countReads=countReads+1
        if '${mode}'=='empty' then return 0 end
        if '${mode}'=='changed-count' and countReads>1 then return 1 end
        return 2
    end
    local rect = a>=0x7300 and 0x7300 or 0x7000
    local n=reads[rect] or 0; reads[rect]=n+1
    local sample=math.floor(n/4)
    local x2=318
    if '${mode}'=='settles' and sample==0 then x2=10000 end
    if '${mode}'=='unstable' or ('${mode}'=='partial' and rect==0x7300) then x2=x2+sample*1000 end
    if '${mode}'=='size-filter' then x2=356 end
    if '${mode}'=='all-filtered' then x2=600 end
    local values={[0x60]=156,[0x64]=292,[0x70]=x2,[0x74]=413}
    if '${mode}'=='reversed' then values={[0x60]=318,[0x64]=413,[0x70]=156,[0x74]=292} end
    return values[a-rect] or 0
end
`;
    const result = await run('npcs.lua',setup);
    const expected = ['unstable','partial','missing-camera','missing-pool','missing-node','missing-rect','changed-count'].includes(mode) ? null
      : ['empty','all-filtered'].includes(mode) ? {} : mode==='size-filter' ? [{x:56,y:92,w:200,h:121}]
      : [{x:56,y:92,w:162,h:121},{x:56,y:92,w:324,h:121}];
    assert.deepEqual(result,expected,`NPC ${mode}`);
  }
  const portalPointers = {[0xBF14EC]:0x11000,[0xBED768]:0x12000,[0xBED788]:0x13000,
    [0x12004]:0x14000,[0x12018]:2,[0x13668]:123,
    [0x14004]:0x15000,[0x1400C]:0x15100,[0x14014]:0x15200,[0x1401C]:0x15300};
  for (const mode of ['stable','settles','odd-width','unstable','zero-size','filtered-all','bad-slots','small-slot','unaligned-slot','array-overflow','bad-pool','small-pool','bad-camera','map-change','empty']) {
    const pointers={...portalPointers};
    if(mode==='bad-slots') { pointers[0x14004]=0xFFFFFFEE; pointers[0x1400C]=0; }
    if(mode==='small-slot') { pointers[0x14004]=0x97; pointers[0x1400C]=0x100; }
    if(mode==='unaligned-slot') { pointers[0x14004]=0x15001; pointers[0x1400C]=0; }
    if(mode==='array-overflow') pointers[0x12004]=0xFFFFFFF8;
    if(mode==='bad-pool') pointers[0xBED768]=0xFFFFFFEE;
    if(mode==='small-pool') pointers[0xBED768]=0x97;
    if(mode==='bad-camera') pointers[0xBF14EC]=0xFFFFFFEE;
    if(mode==='empty') pointers[0x12018]=0;
    const setup = `
local pointers=${luaMap(pointers)}
local cameraReads, mapReads, reads = 0, 0, {}
local fail_read=read_u32
local function read_u32(a)
    if a==0x13668 then
        mapReads=mapReads+1
        if '${mode}'=='map-change' and mapReads>1 then return 456 end
    end
    if pointers[a]==nil then return fail_read(0x10000000a) end
    return pointers[a]
end
local function read_i32(a)
    if a==0x110F8 then cameraReads=cameraReads+1; return cameraReads*100 end
    if a==0x110FC then return 200 end
    local index=math.floor((a-0x15000)/0x100)
    local offset=a-(0x15000+index*0x100)
    if index<0 or index>3 then return fail_read(a) end
    if offset==0x1C then
        if '${mode}'=='filtered-all' then return 123 end
        return ({123,456,999999999,789})[index+1]
    end
    if offset==0x08 then return ({2,3,7,2})[index+1] end
    local n=reads[index] or 0; reads[index]=n+1
    local sample=math.floor(n/4)
    local width=80
    if '${mode}'=='odd-width' then width=81 end
    if '${mode}'=='settles' and sample==0 then width=10000 end
    if '${mode}'=='unstable' then width=width+sample*1000 end
    if '${mode}'=='zero-size' then width=0 end
    return ({[0x0C]=200+index*20,[0x10]=400,[0x14]=width,[0x18]=100})[offset] or 0
end
`;
    // A count inconsistent with the allocation is still an error, not a valid
    // empty result. The original C++ does not supply the allocation's length.
    if(mode==='filtered-all') {
      await assert.rejects(run('portals.lua',setup),/read failed/);
      continue;
    }
    const result=await run('portals.lua',setup);
    const width=mode==='odd-width'?81:80;
    const expected=['stable','settles','odd-width'].includes(mode) ?
      [{x:80,y:100,w:width,h:100},{x:100,y:100,w:width,h:100},{x:120,y:100,w:width,h:100}] :
      ['bad-slots','small-slot','unaligned-slot'].includes(mode) ? [{x:100,y:100,w:80,h:100},{x:120,y:100,w:80,h:100}] : {};
    assert.deepEqual(result,expected,`Portal ${mode}`);
    const diagnostic=await run('portal-diagnostics.lua',setup);
    if(mode==='stable') {
      assert.match(diagnostic,/count=2 map=123/);
      assert.match(diagnostic,/slot=0 .*filtered out/);
      assert.match(diagnostic,/slot=1 .*type=3 toMap=456 eligible/);
      assert.match(diagnostic,/scanned=4 counted=2 eligible=3 invalid=0 unstable=0 nonpositive=0 boxes=3/);
    }
    if(mode==='small-slot') {
      assert.match(diagnostic,/slot=0 ptr=0x97 null\/invalid/);
    }
    if(mode==='empty') assert.match(diagnostic,/exit=portal count is zero/);
    if(mode==='bad-camera') assert.match(diagnostic,/exit=invalid camera/);
    if(mode==='bad-pool'||mode==='small-pool') assert.match(diagnostic,/exit=invalid pool/);
    if(mode==='array-overflow') assert.match(diagnostic,/exit=invalid array range/);
    if(mode==='map-change') assert.match(diagnostic,/exit=array\/count\/map changed.*discarded=yes/);
    if(mode==='unstable') assert.match(diagnostic,/unstable=3 nonpositive=0 boxes=0/);
    if(mode==='zero-size') assert.match(diagnostic,/unstable=0 nonpositive=3 boxes=0/);
  }
  console.log('PASS: NPC/portal Lua scripts, shared camera, changing rectangles, size rules, C++ qualifying-portal count across extra entries, invalid pointers, and map changes');
};
