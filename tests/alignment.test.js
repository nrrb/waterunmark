import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePattern, deblend } from '../src/core.js';
import { handles, hitHandle, resizeRect, moveRect } from '../src/geometry.js';

function fixture(){
  const w=160,h=90,mw=18,mh=16,mask=new Uint8Array(mw*mh);
  for(let y=2;y<14;y++)for(let x=2;x<16;x++)if(x<5||y===7||y===8||x>12&&y<8)mask[y*mw+x]=255;
  const clean=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)clean.set([50+Math.floor(x/8),70+Math.floor(y/6),90,255],(y*w+x)*4);
  const image=clean.slice(),positions=[{x:12,y:10},{x:85,y:28}];
  for(const pos of positions)for(let y=0;y<mh;y++)for(let x=0;x<mw;x++){
    const a=.3*mask[y*mw+x]/255,i=((pos.y+y)*w+pos.x+x)*4;
    for(let c=0;c<3;c++)image[i+c]=clean[i+c]*(1-a)+255*a;
  }
  const boxes=[{x:5,y:4,w:34,h:29},{x:67,y:14,w:53,h:42}];
  const pattern={mask,mw,mh,template:{...positions[0],w:mw,h:mh},boxes,radius:8,threshold:.15,softness:.25,layoutVersion:2,phase:'marking',enabled:true,opacity:.3,color:[255,255,255],mode:'normal'};
  return{w,h,mask,image,clean,positions,pattern};
}
test('independent offsets fit differently padded search boxes without scaling text',()=>{
  const f=fixture(),r=analyzePattern(f.image,f.w,f.h,f.pattern,.6);
  assert.deepEqual(r.boxes.map(b=>[b.match.x,b.match.y]),f.positions.map(p=>[p.x,p.y]));
  assert.deepEqual(r.boxes.map(b=>[b.match.w,b.match.h]),[[18,16],[18,16]]);
  assert.ok(r.boxes.every(b=>b.accepted&&b.score>.8));
  const output=deblend(f.image,f.w,f.h,[{...f.pattern,...r}]).pixels;
  for(let i=0;i<output.length;i++)assert.ok(Math.abs(output[i]-f.clean[i])<=1,`channel ${i}`);
  assert.deepEqual(output.slice(0,20),f.image.slice(0,20));
});
test('Done can estimate a fresh template and align all marked instances',()=>{
  const f=fixture(),r=analyzePattern(f.image,f.w,f.h,{...f.pattern,mask:null,mw:0,mh:0},.55);
  assert.equal(r.phase,'ready');assert.equal(r.layoutVersion,2);assert.ok(r.mask.length>0);
  const dx=r.boxes[1].match.x-r.boxes[0].match.x,dy=r.boxes[1].match.y-r.boxes[0].match.y;
  assert.equal(dx,73);assert.equal(dy,18);assert.ok(r.boxes.every(b=>b.accepted));
});
test('undersized and blank boxes remain unapplied; marking never applies stale fits',()=>{
  const f=fixture(),boxes=[...f.pattern.boxes,{x:120,y:5,w:8,h:8},{x:115,y:50,w:40,h:35}];
  const r=analyzePattern(f.image,f.w,f.h,{...f.pattern,boxes},.6);
  assert.equal(r.boxes[2].match,null);assert.match(r.boxes[2].reason,/smaller/);assert.equal(r.boxes[2].accepted,false);
  assert.equal(r.boxes[3].accepted,false);
  assert.deepEqual(deblend(f.image,f.w,f.h,[{...f.pattern,...r,phase:'marking'}]).pixels,f.image);
});
test('overlapping search boxes identifying the same text do not correct it twice',()=>{
  const f=fixture(),boxes=[f.pattern.boxes[0],{x:7,y:5,w:36,h:30}];
  const r=analyzePattern(f.image,f.w,f.h,{...f.pattern,boxes},.5);
  assert.equal(r.boxes[0].accepted,true);assert.equal(r.boxes[1].accepted,false);assert.equal(r.boxes[1].duplicate,true);
  const normal=deblend(f.image,f.w,f.h,[{...f.pattern,...r}]);
  const forced=deblend(f.image,f.w,f.h,[{...f.pattern,...r,boxes:r.boxes.map(b=>({...b,accepted:true}))}]);
  assert.deepEqual(normal,forced);
});
test('eight handles resize independently, constrain to image, and cannot cross',()=>{
  const r={x:20,y:30,w:40,h:20};
  assert.equal(handles(r).length,8);
  for(const [handle,x,y]of handles(r))assert.equal(hitHandle(r,{x,y},2),handle);
  assert.deepEqual(resizeRect(r,'e',13,99,100,100),{x:20,y:30,w:53,h:20});
  assert.deepEqual(resizeRect(r,'nw',-80,-80,100,100),{x:0,y:0,w:60,h:50});
  assert.deepEqual(resizeRect(r,'w',100,0,100,100),{x:56,y:30,w:4,h:20});
  assert.deepEqual(resizeRect(r,'se',200,200,100,100),{x:20,y:30,w:80,h:70});
  assert.deepEqual(moveRect(r,100,-100,100,100),{x:60,y:0,w:40,h:20});
});
