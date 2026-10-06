const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {listDataset,readItem}=require('../electron/datasetPreview.cjs');
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex'); // enough to be served as an image
const write=(file,content,when)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);if(when)fs.utimesSync(file,when,when);};

test('lists a YOLO dataset oldest first and reads each image with its boxes, metadata and class names',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-preview-'));
  write(path.join(root,'data.yaml'),'path: x\ntrain: images/train\nval: images/val\n\nnames:\n  0: screen_monsters\n  1: screen_npcs\nnc: 2\n');
  write(path.join(root,'images/train/100/000002.png'),png,new Date(2000));
  write(path.join(root,'images/val/100/000005.png'),png,new Date(3000));
  write(path.join(root,'images/train/200/000001.png'),png,new Date(1000));
  write(path.join(root,'labels/train/100/000002.txt'),'0 0.5 0.5 0.2 0.1\n1 0.25 0.75 0.1 0.2\n');
  write(path.join(root,'labels/train/100/000002.json'),JSON.stringify({trigger:'While new',savedAt:'2026-10-04T22:13:30Z',session:'s',sequence:2,imageSize:[802,627],states:{}}));
  write(path.join(root,'labels/val/100/000005.txt'),'');
  const listing=listDataset(root);
  assert.equal(listing.yolo,true);
  assert.deepEqual(listing.classes,['screen_monsters','screen_npcs']);
  assert.deepEqual(listing.items,[{path:'images/train/200/000001.png',split:'train'},{path:'images/train/100/000002.png',split:'train'},{path:'images/val/100/000005.png',split:'val'}],'In the order they were saved');
  const item=readItem(root,'images/train/100/000002.png');
  assert.match(item.image,/^data:image\/png;base64,/);
  assert.deepEqual(item.boxes,[{cls:0,x:0.5,y:0.5,w:0.2,h:0.1},{cls:1,x:0.25,y:0.75,w:0.1,h:0.2}]);
  assert.deepEqual(item.meta,{trigger:'While new',savedAt:'2026-10-04T22:13:30Z',session:'s',sequence:2,imageSize:[802,627]});
  assert.deepEqual(readItem(root,'images/val/100/000005.png').boxes,[],'An empty label file is a background image');
  assert.equal(readItem(root,'images/train/200/000001.png').boxes,null,'A missing label file says so');
  assert.throws(()=>readItem(root,'../outside.png'),/outside the dataset folder/);
  assert.throws(()=>readItem(root,'data.yaml'),/Not an image/);
  assert.throws(()=>listDataset('relative/folder'),/absolute/);
  assert.throws(()=>listDataset(path.join(root,'missing')),/does not exist/);
  fs.rmSync(root,{recursive:true,force:true});
});

test('deleting an image takes its label and metadata with it, through the given trash, and nothing outside the folder',async()=>{
  const {deleteItem}=require('../electron/datasetPreview.cjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-preview-'));
  write(path.join(root,'images/train/100/000001.png'),png);
  write(path.join(root,'labels/train/100/000001.txt'),'0 0.5 0.5 0.1 0.1\n');
  write(path.join(root,'labels/train/100/000001.json'),'{}');
  write(path.join(root,'session/000002.png'),png);
  write(path.join(root,'session/000002.png.json'),'{}');
  const trashed=[],trash=async file=>{trashed.push(path.relative(root,file).split(path.sep).join('/'));fs.rmSync(file);};
  const done=await deleteItem(root,'images/train/100/000001.png',trash);
  assert.equal(done.image,path.join(root,'images','train','100','000001.png'));
  assert.deepEqual(trashed,['images/train/100/000001.png','labels/train/100/000001.txt','labels/train/100/000001.json']);
  await deleteItem(root,'session/000002.png',trash);
  assert.deepEqual(trashed.slice(3),['session/000002.png','session/000002.png.json'],'A plain output\'s JSON goes with its image');
  await assert.rejects(deleteItem(root,'images/train/100/000001.png',trash),/no longer there/);
  await assert.rejects(deleteItem(root,'../elsewhere.png',trash),/outside the dataset folder/);
  fs.rmSync(root,{recursive:true,force:true});
});

test('reads a plain output (images with JSON beside them) without labels',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-preview-'));
  write(path.join(root,'session/000001.png'),png);
  write(path.join(root,'session/000001.png.json'),JSON.stringify({trigger:'Enemy'}));
  const listing=listDataset(root);
  assert.equal(listing.yolo,false);
  assert.deepEqual(listing.items,[{path:'session/000001.png',split:''}]);
  const item=readItem(root,'session/000001.png');
  assert.equal(item.boxes,null);
  assert.equal(item.meta.trigger,'Enemy');
  fs.rmSync(root,{recursive:true,force:true});
});
