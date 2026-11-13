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

// Patterns list the order overlays were applied. Undo in reverse order.
// Every render begins from the immutable upload, never the preceding preview.
export function deblend(original, w, h, patterns) {
  const output = Float32Array.from(original);
  const touched = new Uint8Array(w*h);
  let clipped = 0;
  for (const p of [...patterns].reverse()) {
    if (!p.enabled || !p.mask) continue;
    for (const r of [...p.boxes].reverse()) {
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
