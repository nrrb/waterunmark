export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// Summed-area filtering keeps mask extraction O(image pixels), independent of radius.
export function boxBlur(input, w, h, radius) {
  const stride = w + 1, integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += input[y * w + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const result = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
    const x1 = Math.min(w, x + radius + 1), y1 = Math.min(h, y + radius + 1);
    result[y * w + x] = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return result;
}

export function estimateMask(image, w, h, rect, radius = 12, threshold = .15, softness = .25) {
  const values = new Float32Array(w * h);
  for (let i = 0; i < values.length; i++) values[i] = Math.min(image[i * 4], image[i * 4 + 1], image[i * 4 + 2]);
  const bg = boxBlur(values, w, h, radius);
  const raw = new Float32Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const i = (rect.y + y) * w + rect.x + x;
    raw[y * rect.w + x] = clamp((values[i] - bg[i]) / Math.max(12, 255 - bg[i]));
  }
  const positive = Array.from(raw).filter(v => v > .015).sort((a,b) => a-b);
  const peak = positive[Math.floor(positive.length * .9)] || 1;
  return Uint8Array.from(raw, v => Math.round(255 * clamp((v / peak - threshold) / Math.max(.01, softness))));
}

export function maskAt(pattern, rect, x, y) {
  const fx = (x - rect.x + .5) / rect.w * pattern.mw - .5;
  const fy = (y - rect.y + .5) / rect.h * pattern.mh - .5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const at = (a,b) => pattern.mask[clamp(b,0,pattern.mh-1)*pattern.mw+clamp(a,0,pattern.mw-1)] / 255;
  return (at(x0,y0)*(1-tx)+at(x0+1,y0)*tx)*(1-ty)+(at(x0,y0+1)*(1-tx)+at(x0+1,y0+1)*tx)*ty;
}

// Version 2 boxes are search bounds. A match is a separate, unscaled mask
// placement found inside those bounds. Legacy projects retain their old fits.
export function placementFor(pattern,box){
  if(pattern.phase==='marking'||pattern.phase==='analyzing')return null;
  if(pattern.layoutVersion===2)return box.accepted&&box.match?box.match:null;
  return box;
}

// Patterns list the order overlays were applied. Undo in reverse order.
// Every render begins from the immutable upload, never the preceding preview.
export function deblend(original, w, h, patterns) {
  const output = Float32Array.from(original);
  const touched = new Uint8Array(w*h);
  let clipped = 0;
  for (const p of [...patterns].reverse()) {
    if (!p.enabled || !p.mask) continue;
    const seen=new Set();
    for (const box of [...p.boxes].reverse()) {
      const r=placementFor(p,box);if(!r)continue;
      const key=`${r.x},${r.y},${r.w},${r.h}`;
      if(p.layoutVersion===2&&seen.has(key))continue;
      seen.add(key);
      for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(h, r.y+r.h); y++) {
        for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(w, r.x+r.w); x++) {
          const a = clamp(p.opacity * maskAt(p,r,x,y), 0, .98);
          if (!a) continue;
          const i = (y*w+x)*4;
          for (let c=0;c<3;c++) {
            const v = p.mode === 'screen'
              ? 255 * (1 - (1-output[i+c]/255) / Math.max(.02, 1-a*p.color[c]/255))
              : (output[i+c]-a*p.color[c]) / (1-a);
            output[i+c] = v;
            if (v < 0 || v > 255) touched[y*w+x] = 1;
          }
        }
      }
    }
  }
  for (const v of touched) clipped += v;
  return { pixels: Uint8ClampedArray.from(output), clipped };
}

function localFeature(image,w,h,rect,radius){
  const x0=Math.max(0,rect.x-radius),y0=Math.max(0,rect.y-radius);
  const rw=Math.min(w,rect.x+rect.w+radius)-x0,rh=Math.min(h,rect.y+rect.h+radius)-y0;
  const values=new Float32Array(rw*rh);
  for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
    const i=((y+y0)*w+x+x0)*4;values[y*rw+x]=Math.min(image[i],image[i+1],image[i+2]);
  }
  const bg=boxBlur(values,rw,rh,radius),out=new Float32Array(rect.w*rect.h);
  for(let y=0;y<rect.h;y++)for(let x=0;x<rect.w;x++){
    const i=(y+rect.y-y0)*rw+x+rect.x-x0;
    out[y*rect.w+x]=Math.max(0,(values[i]-bg[i])/Math.max(12,255-bg[i]));
  }
  return out;
}

export function cropMask(mask,mw,mh,origin){
  let x0=mw,y0=mh,x1=-1,y1=-1;
  for(let y=0;y<mh;y++)for(let x=0;x<mw;x++)if(mask[y*mw+x]>24){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  if(x1<0)throw new Error('No light text found in the first box. Tighten that box or change the mask settings.');
  x0=Math.max(0,x0-2);y0=Math.max(0,y0-2);x1=Math.min(mw-1,x1+2);y1=Math.min(mh-1,y1+2);
  const cw=x1-x0+1,ch=y1-y0+1,cropped=new Uint8Array(cw*ch);
  for(let y=0;y<ch;y++)cropped.set(mask.subarray((y+y0)*mw+x0,(y+y0)*mw+x0+cw),y*cw);
  return{mask:cropped,mw:cw,mh:ch,template:{x:origin.x+x0,y:origin.y+y0,w:cw,h:ch}};
}

export function alignInBox(image,w,h,pattern,box){
  const {mw, mh, mask}=pattern;
  if(box.w<mw||box.h<mh)return{match:null,score:0,reason:'Box smaller than the text template. Enlarge it.'};
  const feature=localFeature(image,w,h,box,pattern.radius||12),points=[];
  const sampleStep=Math.max(1,Math.floor(Math.sqrt(mw*mh/1600)));
  for(let y=0;y<mh;y+=sampleStep)for(let x=0;x<mw;x+=sampleStep)points.push({x,y,v:mask[y*mw+x]/255});
  const mean=points.reduce((s,p)=>s+p.v,0)/points.length;
  const variance=points.reduce((s,p)=>s+(p.v-mean)**2,0);
  if(variance<.001)return{match:null,score:0,reason:'Mask needs both strokes and empty background.'};
  const scoreAt=(x,y)=>{
    let sum=0,square=0,dot=0;
    for(const p of points){const v=feature[(y+p.y)*box.w+x+p.x];sum+=v;square+=v*v;dot+=(p.v-mean)*v;}
    return dot/Math.sqrt(Math.max(1e-12,variance*(square-sum*sum/points.length)));
  };
  const maxX=box.w-mw,maxY=box.h-mh;
  const step=Math.max(1,Math.ceil(Math.sqrt((maxX+1)*(maxY+1)/16000)));
  const best=[];
  const consider=(x,y)=>{const score=scoreAt(x,y);best.push({x,y,score});best.sort((a,b)=>b.score-a.score);if(best.length>12)best.pop();};
  for(let y=0;y<=maxY;y+=step)for(let x=0;x<=maxX;x+=step)consider(x,y);
  // Always sample right/bottom boundaries and a known prior alignment.
  for(let x=0;x<=maxX;x+=step)consider(x,maxY);
  for(let y=0;y<=maxY;y+=step)consider(maxX,y);
  consider(maxX,maxY);
  const prior=box.match||pattern.template;
  if(prior&&prior.x>=box.x&&prior.y>=box.y&&prior.x<=box.x+maxX&&prior.y<=box.y+maxY)consider(prior.x-box.x,prior.y-box.y);
  let winner=best[0];
  if(step>1)for(const candidate of [...best]){
    for(let y=Math.max(0,candidate.y-step);y<=Math.min(maxY,candidate.y+step);y++)for(let x=Math.max(0,candidate.x-step);x<=Math.min(maxX,candidate.x+step);x++){
      const score=scoreAt(x,y);if(score>winner.score)winner={x,y,score};
    }
  }
  return{match:{x:box.x+winner.x,y:box.y+winner.y,w:mw,h:mh},score:Math.max(0,winner.score)};
}

export function analyzePattern(image,w,h,pattern,minScore=.55,reestimate=false,progress=()=>{}){
  let p={...pattern};
  if(!p.boxes.length)throw new Error('Mark at least one instance first.');
  if(p.boxes.some(b=>b.w*b.h>4_000_000))throw new Error('Use search boxes under 4 million pixels.');
  if(!p.mask||reestimate){
    const first=p.boxes[0];
    const mask=estimateMask(image,w,h,first,p.radius,p.threshold,p.softness);
    p={...p,...cropMask(mask,first.w,first.h,first)};
  }
  else if(p.layoutVersion!==2)p={...p,...cropMask(p.mask,p.mw,p.mh,p.template||p.boxes[0])};
  const boxes=p.boxes.map((box,i)=>{
    const result=alignInBox(image,w,h,p,box);
    progress((i+1)/p.boxes.length);
    return{...box,reason:null,duplicate:false,...result,accepted:!!result.match&&result.score>=minScore};
  });
  const seen=new Map();
  for(let i=0;i<boxes.length;i++){
    const box=boxes[i];if(!box.match)continue;const key=`${box.match.x},${box.match.y}`;
    if(seen.has(key)){box.accepted=false;box.reason=`Same text instance as box ${seen.get(key)+1}.`;box.duplicate=true;}
    else seen.set(key,i);
  }
  return{mask:p.mask,mw:p.mw,mh:p.mh,template:boxes[0].match||p.template,boxes,layoutVersion:2,phase:'ready'};
}

// Candidate suggestions only: same scale and rotation. Sparse normalized
// correlation of high-pass luminance tolerates some background variation.
export function findRepeats(image, w, h, pattern, minScore = .72, progress = () => {}) {
  const scale = Math.min(1, 900 / Math.max(w,h));
  const sw = Math.max(1, Math.round(w*scale)), sh = Math.max(1, Math.round(h*scale));
  const gray = new Float32Array(sw*sh);
  for(let y=0;y<sh;y++) for(let x=0;x<sw;x++) {
    const i=(Math.min(h-1,Math.floor(y/scale))*w+Math.min(w-1,Math.floor(x/scale)))*4;
    gray[y*sw+x]=Math.min(image[i],image[i+1],image[i+2]);
  }
  const bg=boxBlur(gray,sw,sh,Math.max(2,Math.round(12*scale)));
  const feature=gray.map((v,i)=>Math.max(0,v-bg[i]));
  const tw=Math.round(pattern.mw*scale), th=Math.round(pattern.mh*scale);
  if(tw<4||th<4) throw new Error('Pattern too small for repeat search. Add placements manually.');
  const points=[];
  const step=Math.max(1,Math.ceil(Math.sqrt(tw*th/180)));
  for(let y=0;y<th;y+=step) for(let x=0;x<tw;x+=step) {
    points.push({x,y,v:pattern.mask[Math.min(pattern.mh-1,Math.floor(y/scale))*pattern.mw+Math.min(pattern.mw-1,Math.floor(x/scale))]/255});
  }
  const tm=points.reduce((s,p)=>s+p.v,0)/points.length;
  const tv=points.reduce((s,p)=>s+(p.v-tm)**2,0);
  if(tv<.01) throw new Error('Mask needs both letter strokes and empty background for repeat search.');
  const score=(x,y)=>{
    let sum=0,sq=0,dot=0;
    for(const p of points){const v=feature[(y+p.y)*sw+x+p.x];sum+=v;sq+=v*v;dot+=(p.v-tm)*v;}
    return dot/Math.sqrt(Math.max(.00001,tv*(sq-sum*sum/points.length)));
  };
  const candidates=[];
  for(let y=0;y<=sh-th;y+=2){
    for(let x=0;x<=sw-tw;x+=2){const s=score(x,y);if(s>=minScore-.12)candidates.push({x,y,score:s});}
    if(y%30===0)progress(y/Math.max(1,sh-th));
  }
  candidates.sort((a,b)=>b.score-a.score);
  const boxes=[];
  for(const p of candidates.slice(0,2000)){
    if(boxes.some(b=>Math.abs(b.x-p.x/scale)<pattern.mw*.65&&Math.abs(b.y-p.y/scale)<pattern.mh*.65))continue;
    let best=p;
    for(let yy=Math.max(0,p.y-2);yy<=Math.min(sh-th,p.y+2);yy++) for(let xx=Math.max(0,p.x-2);xx<=Math.min(sw-tw,p.x+2);xx++) {
      const s=score(xx,yy);if(s>best.score)best={x:xx,y:yy,score:s};
    }
    if(best.score>=minScore)boxes.push({x:clamp(Math.round(best.x/scale),0,w-pattern.mw),y:clamp(Math.round(best.y/scale),0,h-pattern.mh),w:pattern.mw,h:pattern.mh,score:best.score});
    if(boxes.length>=100)break;
  }
  return boxes;
}
