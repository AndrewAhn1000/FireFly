// A Lua script's memory reads, against the captured window's own process (the test window's): a block read
// in one read_bytes and unpacked with string.unpack, and the per-run read limit, which says how to keep under it.
const assert=require('node:assert/strict');
module.exports=async function checkLuaMemory(invoke) {
  const run=script=>invoke('memory.run_script',{script});
  // Every Windows executable starts with "MZ", and says where its PE header is at 0x3C
  const exe='local m=list_modules()[1]; local base=get_module_base(m)';
  const {value:header}=await run(`${exe}; local b=read_bytes(base, 64); return {mz=b:sub(1,2), magic=string.unpack("<I2", b), pe=string.unpack("<I4", b, 0x3C + 1), u16=read_u16(base), size=#b}`);
  assert.equal(header.mz,'MZ');assert.equal(header.magic,0x5A4D);assert.equal(header.magic,header.u16,'read_bytes and read_u16 disagree');
  assert.equal(header.size,64);assert.ok(header.pe>0&&header.pe<4096,'the PE header offset unpacked from the block');
  // A block counts as one read: 4,000 of them, 4 KB each, is within the limit that 4,000 single reads would nearly reach
  assert.equal((await run(`${exe}; local n=0; for i=1,4000 do n=n+#read_bytes(base, 4096) end; return n`)).value,4000*4096);
  await assert.rejects(run(`${exe}; return read_bytes(base, 0)`),/1\.\.4096 bytes/);
  await assert.rejects(run(`${exe}; return read_bytes(base, 4097)`),/1\.\.4096 bytes/);
  await assert.rejects(run('return read_bytes(0, 4)'),/read failed at 0x0/);
  // Past the limit, the error says how to stay under it
  await assert.rejects(run(`${exe}; for i=1,5000 do read_u8(base) end`),/read limit exceeded \(max 4096 per call\): walk a linked list once.*read_bytes/);
  console.log('PASS: read_bytes reads a block in one read, string.unpack takes values out, bad sizes and addresses refused, and the read limit says how to keep under it');
};
