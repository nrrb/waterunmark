import test from 'node:test';
import assert from 'node:assert/strict';
import { deblend, estimateMask, findRepeats, boxBlur } from '../src/core.js';

const pattern=(overrides={})=>({enabled:true,mode:'normal',color:[255,255,255],opacity:.25,mw:2,mh:1,mask:new Uint8Array([255,128]),boxes:[{x:1,y:0,w:2,h:1}],...overrides});
test('inverse alpha blend recovers colors; zero-mask and unselected pixels stay exact',()=>{
  const clean=new Uint8ClampedArray([20,40,60,255,80,120,160,255,10,50,100,180,70,90,130,255]);
  const observed=clean.slice(),p=pattern();
  for(let x=1;x<3;x++)for(let c=0;c<3;c++){const a=p.opacity*p.mask[x-1]/255;observed[x*4+c]=(1-a)*clean[x*4+c]+a*255;}
  const {pixels}=deblend(observed,4,1,[p]);
  for(let i=0;i<clean.length;i++)assert.ok(Math.abs(clean[i]-pixels[i])<=1,`channel ${i}`);
  assert.deepEqual(pixels.slice(0,4),clean.slice(0,4));assert.deepEqual(pixels.slice(12),clean.slice(12));
  assert.deepEqual(deblend(observed,4,1,[{...p,mask:new Uint8Array(2)}]).pixels,observed);
  assert.deepEqual(deblend(observed,4,1,[{...p,enabled:false}]).pixels,observed);
});
test('overlapping colored overlays undo in reverse application order',()=>{
  const original=new Uint8ClampedArray([70,100,140,255]);
  const ps=[pattern({mw:1,mask:new Uint8Array([255]),boxes:[{x:0,y:0,w:1,h:1}],color:[255,150,100],opacity:.2}),pattern({mw:1,mask:new Uint8Array([255]),boxes:[{x:0,y:0,w:1,h:1}],color:[80,200,255],opacity:.3})];
  const input=Float32Array.from(original);for(const p of ps)for(let c=0;c<3;c++)input[c]=input[c]*(1-p.opacity)+p.color[c]*p.opacity;
  const result=deblend(input,1,1,ps).pixels;
  for(let i=0;i<4;i++)assert.equal(result[i],original[i]);
});
test('screen inversion recovers original and counts clipped pixels once',()=>{
  const p=pattern({mw:1,mask:new Uint8Array([255]),boxes:[{x:0,y:0,w:1,h:1}],mode:'screen',color:[180,220,255],opacity:.4});
  const original=[50,90,140,255],input=Float32Array.from(original);
  for(let c=0;c<3;c++)input[c]=255*(1-(1-original[c]/255)*(1-p.opacity*p.color[c]/255));
  assert.deepEqual(Array.from(deblend(input,1,1,[p]).pixels),original);
  const bad=deblend(new Uint8ClampedArray([1,2,3,255]),1,1,[{...p,mode:'normal',opacity:.9}]);
  assert.equal(bad.clipped,1);assert.deepEqual(Array.from(bad.pixels),[0,0,0,255]);
});
test('preview is repeatable without changing its immutable source',()=>{
  const input=new Uint8ClampedArray([60,100,120,255,160,170,180,255,190,200,210,255]);const copy=input.slice();
  const a=deblend(input,3,1,[pattern()]);deblend(input,3,1,[pattern({opacity:.6})]);const b=deblend(input,3,1,[pattern()]);
  assert.deepEqual(a,b);assert.deepEqual(input,copy);
});
test('box filter and estimated mask distinguish bright strokes from flat background',()=>{
  const w=60,h=30,input=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<w*h;i++){input.set([80,80,80,255],i*4);}
  for(let y=8;y<23;y++)for(const x of [10,11,12,25,26,27])input.set([150,150,150,255],(y*w+x)*4);
  const mask=estimateMask(input,w,h,{x:0,y:0,w,h},6,.15,.25);
  assert.equal(mask[12*w+11],255);assert.equal(mask[12*w+42],0);
  assert.deepEqual(Array.from(boxBlur(new Float32Array([4,4,4,4]),2,2,2)),[4,4,4,4]);
});
test('repeat finder locates identical text strokes and suppresses duplicate suggestions',()=>{
  const w=110,h=70,tw=16,th=14,mask=new Uint8Array(tw*th),input=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<w*h;i++)input.set([80,80,80,255],i*4);
  for(let y=2;y<12;y++)for(let x=2;x<14;x++)if(x<4||y===6||x>11&&y<7)mask[y*tw+x]=255;
  const places=[{x:10,y:8},{x:62,y:40}];
  for(const r of places)for(let y=0;y<th;y++)for(let x=0;x<tw;x++)if(mask[y*tw+x])input.set([160,160,160,255],((r.y+y)*w+r.x+x)*4);
  const found=findRepeats(input,w,h,{mw:tw,mh:th,mask},.7);
  for(const p of places)assert.ok(found.some(b=>Math.abs(b.x-p.x)<=1&&Math.abs(b.y-p.y)<=1),JSON.stringify(found));
});
