const $ = id => document.getElementById(id);
const canvas=$('canvas'), ctx=canvas.getContext('2d'), stage=$('stage');
const originalCanvas=document.createElement('canvas'), resultCanvas=document.createElement('canvas');
let imageBlob=null, filename='', W=0,H=0,patterns=[],activeId=null,tool='pan';
let zoom=1,panX=0,panY=0,space=false,peek=false,drag=null,candidates=[];
let worker, sequence=0, jobs=new Map(), renderRevision=0, renderBusy=false, renderAgain=false;
let renderTimer,saveTimer,saveChain=Promise.resolve(),sessionEpoch=0, maskUndo=[];
const colors=['#d2ed86','#bdabf7','#82d7f0','#f0b982'];
const active=()=>patterns.find(p=>p.id===activeId);
const status=text=>$('status').textContent=text;
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const makeId=()=>crypto.randomUUID();
const copyPatterns=()=>patterns.map(p=>({...p,mask:p.mask?.slice(),boxes:p.boxes.map(b=>({...b}))}));
for(const [id,label]of[['opacity','Text opacity'],['brush','Brush size'],['radius','Background radius'],['threshold','Stroke threshold'],['softness','Edge softness'],['confidence','Match confidence']])$(id).setAttribute('aria-label',label);
for(const label of document.querySelectorAll('label.button')){
  label.tabIndex=0;label.setAttribute('role','button');
  label.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$(label.htmlFor).click();}};
}

function startWorker(){
  worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  worker.onmessage=({data:m})=>{
    if(m.type==='progress'){status(`Finding repeats… ${Math.round(m.progress*100)}%`);return;}
    const job=jobs.get(m.id);if(!job)return;jobs.delete(m.id);
    m.type==='error'?job.reject(new Error(m.error)):job.resolve(m);
  };
  worker.onerror=event=>{event.preventDefault();for(const job of jobs.values())job.reject(new Error('Worker stopped. Reload the page to restart.'));jobs.clear();status('Processing worker failed. Save your project and reload.');};
}
function rpc(type,payload={}){return new Promise((resolve,reject)=>{const id=++sequence;jobs.set(id,{resolve,reject});worker.postMessage({id,type,...payload});});}
async function initWorker(){const data=originalCanvas.getContext('2d').getImageData(0,0,W,H);await rpc('init',{width:W,height:H,pixels:data.data});}
startWorker();

// Settings stay in localStorage; binary image/mask data stays in IndexedDB
// to avoid localStorage's small quota and synchronous multi-megabyte writes.
const database=new Promise((resolve,reject)=>{
  const r=indexedDB.open('waterunmark',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('sessions');
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
});
database.catch(()=>{});
async function dbOp(mode,value){const db=await database;return new Promise((resolve,reject)=>{
  const tx=db.transaction('sessions',mode),store=tx.objectStore('sessions');
  const r=mode==='readonly'?store.get('last'):value===null?store.delete('last'):store.put(value,'last');
  tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
});}
function saveSoon(){
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>{
    const epoch=sessionEpoch;
    const snapshot={version:1,image:imageBlob,filename,patterns:copyPatterns(),activeId};
    const prefs={view:$('view').value,split:$('split').value,showMask:$('showMask').checked,patterns:patterns.map(({mask,...p})=>p),activeId};
    saveChain=saveChain.catch(()=>{}).then(async()=>{
      if(epoch!==sessionEpoch)return;
      try{localStorage.setItem('waterunmark-settings',JSON.stringify(prefs));await dbOp('readwrite',snapshot);$('saved').textContent='Session saved on this device. Image & masks stored locally.';}
      catch{$('saved').textContent='Browser storage unavailable or full. Use Save project to keep your work.';}
    });
  },450);
}
function updateOutputs(){
  for(const [id,suffix]of[['brush',' px'],['radius',' px'],['threshold','%'],['softness','%'],['confidence','%']])$(id+'Out').textContent=$(id).value+suffix;
  $('opacityOut').textContent=Number($('opacity').value).toFixed(1)+'%';
}
function setTool(value){tool=value;for(const [id,name]of[['panTool','pan'],['templateTool','template'],['placeTool','place'],['paintTool','paint'],['eraseTool','erase']])$(id).classList.toggle('active',name===tool);
  const hints={template:'Drag a tight box around one complete text pattern. This replaces its template and placements.',place:'Drag a box around another copy. Its mask scales to that box. Match the original padding.',paint:'Paint only on the template box (placement 1). Brush edits update every copy.',erase:'Erase false strokes in the template box (placement 1). Hold Shift to erase while painting.',pan:'Drag to pan. Wheel to zoom at the pointer. Space temporarily pans from any tool.'};
  $('toolHint').textContent=hints[value];stage.style.cursor=value==='pan'?'grab':value==='paint'||value==='erase'?'crosshair':'crosshair';
}
function syncUI(){
  $('empty').hidden=!!W;$('export').disabled=!W;
  $('patternControls').hidden=!active();$('adjustControls').hidden=!active();
  $('patterns').innerHTML=patterns.map((p,i)=>`<div class="pattern"><button data-select="${p.id}" class="${p.id===activeId?'active':''}"><span class="swatch" style="background:${colors[i%colors.length]}"></span>${escapeHTML(p.name)}<small>${p.boxes.length} places</small></button><button data-remove="${p.id}" aria-label="Delete ${escapeHTML(p.name)}">×</button></div>`).join('');
  const p=active();if(p){
    $('opacity').value=p.opacity*100;$('enabled').checked=p.enabled;$('blend').value=p.mode;
    $('color').value='#'+p.color.map(c=>c.toString(16).padStart(2,'0')).join('');
    $('radius').value=p.radius;$('threshold').value=p.threshold*100;$('softness').value=p.softness*100;
    $('placementCount').textContent=p.boxes.length;
    $('placements').innerHTML=p.boxes.map((b,i)=>`<div class="row"><span>${i===0?'Template':`Copy ${i}`} · ${b.x}, ${b.y} · ${b.w}×${b.h}</span>${i?`<button data-box="${i}" aria-label="Remove copy ${i}">×</button>`:'<span>↳ paint here</span>'}</div>`).join('');
    for(const id of ['estimate','exportMask','find','paintTool','eraseTool','placeTool','sweep'])$(id).disabled=!p.mask;
  }
  $('zoomLabel').textContent=Math.round(zoom*100)+'%';$('imageInfo').textContent=W?`${W.toLocaleString()} × ${H.toLocaleString()} px · ${filename}`:'No image loaded';
  $('beforeTag').hidden=!W||$('view').value!=='split';$('afterTag').hidden=!W||$('view').value!=='split';
  $('split').disabled=$('view').value!=='split';updateOutputs();draw();
}
function newPattern(){const p={id:makeId(),name:`Pattern ${patterns.length+1}`,enabled:true,opacity:.25,mode:'normal',color:[255,255,255],radius:12,threshold:.15,softness:.25,mask:null,mw:0,mh:0,boxes:[]};patterns.push(p);activeId=p.id;maskUndo=[];candidates=[];renderCandidates();syncUI();setTool('template');saveSoon();}
$('addPattern').onclick=()=>{if(!W){status('Open an image first.');return;}newPattern();};
$('patterns').onclick=e=>{
  const selected=e.target.closest('[data-select]'),remove=e.target.closest('[data-remove]');
  if(selected){activeId=selected.dataset.select;maskUndo=[];candidates=[];renderCandidates();syncUI();saveSoon();}
  if(remove){patterns=patterns.filter(p=>p.id!==remove.dataset.remove);if(!active())activeId=patterns[0]?.id||null;maskUndo=[];candidates=[];renderCandidates();syncUI();requestRender();saveSoon();}
};
$('placements').onclick=e=>{const b=e.target.closest('[data-box]');if(b){active().boxes.splice(Number(b.dataset.box),1);syncUI();requestRender();saveSoon();}};
for(const [id,value]of[['panTool','pan'],['templateTool','template'],['placeTool','place'],['paintTool','paint'],['eraseTool','erase']])$(id).onclick=()=>setTool(value);

function draw(){
  const cssW=stage.clientWidth,cssH=stage.clientHeight,dpr=devicePixelRatio||1;
  if(canvas.width!==Math.round(cssW*dpr)||canvas.height!==Math.round(cssH*dpr)){canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssW,cssH);if(!W)return;
  const view=peek?'original':$('view').value,split=cssW*Number($('split').value)/100;
  const paintImage=(source)=>{ctx.save();ctx.translate(panX,panY);ctx.scale(zoom,zoom);ctx.drawImage(source,0,0);ctx.restore();};
  if(view==='original')paintImage(originalCanvas);else if(view==='result')paintImage(resultCanvas);else{
    paintImage(resultCanvas);ctx.save();ctx.beginPath();ctx.rect(0,0,split,cssH);ctx.clip();paintImage(originalCanvas);ctx.restore();
    ctx.strokeStyle='#edf1f288';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(split,0);ctx.lineTo(split,cssH);ctx.stroke();
    ctx.fillStyle='#edf1f2';ctx.fillRect(split-2,cssH/2-17,4,34);
  }
  if(!peek&&$('showMask').checked){
    patterns.forEach((p,i)=>{
      const color=colors[i%colors.length];
      if(p.id===activeId&&p.mask&&p.boxes.length){
        const mc=maskCanvas(p,color),r=p.boxes[0];ctx.save();ctx.globalAlpha=.5;ctx.drawImage(mc,panX+r.x*zoom,panY+r.y*zoom,r.w*zoom,r.h*zoom);ctx.restore();
      }
      p.boxes.forEach((r,j)=>{ctx.strokeStyle=color;ctx.lineWidth=p.id===activeId?1.5:1;ctx.setLineDash(j?[5,4]:[]);ctx.strokeRect(panX+r.x*zoom,panY+r.y*zoom,r.w*zoom,r.h*zoom);ctx.setLineDash([]);ctx.font='10px system-ui';ctx.fillStyle=color;ctx.fillText(`${p.name} · ${j===0?'template':j}`,panX+r.x*zoom+4,Math.max(12,panY+r.y*zoom-6));});
    });
    ctx.strokeStyle='#82d7f0';ctx.setLineDash([2,4]);candidates.forEach(r=>ctx.strokeRect(panX+r.x*zoom,panY+r.y*zoom,r.w*zoom,r.h*zoom));ctx.setLineDash([]);
  }
  if(drag?.kind==='box'){const r=rectFrom(drag.start,drag.current);ctx.strokeStyle='#fff';ctx.setLineDash([5,4]);ctx.strokeRect(panX+r.x*zoom,panY+r.y*zoom,r.w*zoom,r.h*zoom);ctx.setLineDash([]);}
}
let maskCache=null;
function invalidateMask(){maskCache=null;}
function maskCanvas(p,color='#ffffff'){
  if(maskCache?.p===p&&maskCache.color===color)return maskCache.canvas;
  const c=document.createElement('canvas');c.width=p.mw;c.height=p.mh;
  const data=c.getContext('2d').createImageData(p.mw,p.mh),rgb=color.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16));
  for(let i=0;i<p.mask.length;i++){data.data[i*4]=rgb[0];data.data[i*4+1]=rgb[1];data.data[i*4+2]=rgb[2];data.data[i*4+3]=p.mask[i];}
  c.getContext('2d').putImageData(data,0,0);maskCache={p,color,canvas:c};return c;
}
new ResizeObserver(draw).observe(stage);
function fit(){if(!W)return;zoom=Math.min((stage.clientWidth-60)/W,(stage.clientHeight-60)/H);panX=(stage.clientWidth-W*zoom)/2;panY=(stage.clientHeight-H*zoom)/2;syncUI();}
function zoomAt(factor,x=stage.clientWidth/2,y=stage.clientHeight/2){if(!W)return;const z=Math.max(.02,Math.min(32,zoom*factor));panX=x-(x-panX)*z/zoom;panY=y-(y-panY)*z/zoom;zoom=z;syncUI();}
$('zoomIn').onclick=()=>zoomAt(1.25);$('zoomOut').onclick=()=>zoomAt(.8);$('fit').onclick=fit;$('actual').onclick=()=>zoomAt(1/zoom);
stage.addEventListener('wheel',e=>{if(!W)return;e.preventDefault();const b=stage.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*.0015),e.clientX-b.left,e.clientY-b.top);},{passive:false});
function point(e){const r=stage.getBoundingClientRect();return{x:(e.clientX-r.left-panX)/zoom,y:(e.clientY-r.top-panY)/zoom};}
function rectFrom(a,b){const x=Math.max(0,Math.min(W-1,Math.round(Math.min(a.x,b.x)))),y=Math.max(0,Math.min(H-1,Math.round(Math.min(a.y,b.y))));return{x,y,w:Math.max(1,Math.min(W-x,Math.round(Math.max(a.x,b.x))-x)),h:Math.max(1,Math.min(H-y,Math.round(Math.max(a.y,b.y))-y))};}
function rememberMask(p=active()){if(p?.mask){maskUndo.push({id:p.id,mask:p.mask.slice()});if(maskUndo.length>10)maskUndo.shift();}}
function brushAt(a,b,erase){
  const p=active();if(!p?.mask||!p.boxes.length)return;const r=p.boxes[0],radius=Number($('brush').value)/2;
  const distance=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.max(1,Math.ceil(distance/Math.max(1,radius/2)));
  for(let s=0;s<=steps;s++){
    const x=a.x+(b.x-a.x)*s/steps-r.x,y=a.y+(b.y-a.y)*s/steps-r.y;
    for(let yy=Math.max(0,Math.floor(y-radius));yy<Math.min(p.mh,y+radius+1);yy++)for(let xx=Math.max(0,Math.floor(x-radius));xx<Math.min(p.mw,x+radius+1);xx++){
      const coverage=Math.min(1,Math.max(0,radius+.5-Math.hypot(xx-x,yy-y)))*255,i=yy*p.mw+xx;
      p.mask[i]=erase?Math.min(p.mask[i],255-coverage):Math.max(p.mask[i],coverage);
    }
  }
  invalidateMask();draw();requestRender();
}
stage.onpointerdown=e=>{
  if(!W||e.button>1)return;stage.focus();stage.setPointerCapture(e.pointerId);const pt=point(e);
  if(space||tool==='pan'||e.button===1){drag={kind:'pan',x:e.clientX,y:e.clientY,px:panX,py:panY};stage.style.cursor='grabbing';return;}
  if(tool==='paint'||tool==='erase'){if(!active()?.mask)return;rememberMask();drag={kind:'brush',last:pt};brushAt(pt,pt,tool==='erase'||e.shiftKey);return;}
  if(!active())return;
  drag={kind:'box',start:pt,current:pt,patternId:activeId,tool};draw();
};
stage.onpointermove=e=>{
  if(!drag)return;
  if(drag.kind==='pan'){panX=drag.px+e.clientX-drag.x;panY=drag.py+e.clientY-drag.y;draw();}
  if(drag.kind==='box'){drag.current=point(e);draw();}
  if(drag.kind==='brush'){const next=point(e);brushAt(drag.last,next,tool==='erase'||e.shiftKey);drag.last=next;}
};
stage.onpointerup=async e=>{
  if(!drag)return;const d=drag;drag=null;stage.releasePointerCapture(e.pointerId);stage.style.cursor=tool==='pan'?'grab':'crosshair';
  if(d.kind==='box'){
    const p=patterns.find(p=>p.id===d.patternId);if(!p)return;
    const rect=rectFrom(d.start,point(e));if(rect.w<4||rect.h<4){draw();return;}
    if(d.tool==='template'){
      if(rect.w*rect.h>4_000_000){status('Select a smaller template (under 4 million pixels).');draw();return;}
      p.boxes=[rect];p.mw=rect.w;p.mh=rect.h;p.mask=new Uint8Array(p.mw*p.mh);maskUndo=[];await estimate(p);
    }else p.boxes.push(rect);
    syncUI();requestRender();saveSoon();
  }
  if(d.kind==='brush')saveSoon();draw();
};
stage.onpointercancel=()=>{drag=null;draw();};
document.addEventListener('keydown',e=>{
  if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||$('sweepDialog').open)return;
  if(e.code==='Space'){space=true;e.preventDefault();}if(e.key.toLowerCase()==='o'){peek=true;draw();}
  if(e.key==='Escape'){drag=null;setTool('pan');draw();}
});
document.addEventListener('keyup',e=>{if(e.code==='Space')space=false;if(e.key.toLowerCase()==='o'){peek=false;draw();}});
window.addEventListener('blur',()=>{space=false;peek=false;drag=null;draw();});

async function estimate(p=active()){
  if(!p?.boxes.length)return;const token=p.id,rect={...p.boxes[0]};status('Estimating text strokes in worker…');
  try{const r=await rpc('mask',{rect,radius:p.radius,threshold:p.threshold,softness:p.softness});if(!patterns.includes(p)||p.id!==token||JSON.stringify(p.boxes[0])!==JSON.stringify(rect))return;
    rememberMask(p);p.mask=r.mask;invalidateMask();syncUI();requestRender();saveSoon();status('Mask estimated. Inspect the colored strokes and brush out background details.');
  }catch(e){status(e.message);}
}
$('estimate').onclick=()=>estimate();
$('undoMask').onclick=()=>{const p=active();const last=maskUndo.pop();if(p&&last?.id===p.id&&last.mask.length===p.mw*p.mh){p.mask=last.mask;invalidateMask();draw();requestRender();saveSoon();}};
for(const id of ['brush','radius','threshold','softness','confidence'])$(id).oninput=()=>{updateOutputs();const p=active();if(p){p.radius=Number($('radius').value);p.threshold=Number($('threshold').value)/100;p.softness=Number($('softness').value)/100;saveSoon();}};

function requestRender(){renderRevision++;clearTimeout(renderTimer);renderTimer=setTimeout(render,75);}
async function render(){
  if(!W)return;if(renderBusy){renderAgain=true;return;}
  renderBusy=true;const rev=renderRevision,epoch=sessionEpoch;status('Updating preview…');
  try{const r=await rpc('render',{patterns:copyPatterns()});if(rev===renderRevision&&epoch===sessionEpoch){resultCanvas.getContext('2d').putImageData(new ImageData(r.pixels,W,H),0,0);draw();status(`${r.clipped.toLocaleString()} pixels outside recoverable range · original preserved`);}}
  catch(e){status(e.message);}finally{renderBusy=false;if(renderAgain||rev!==renderRevision){renderAgain=false;requestRender();}}
}
function adjust(){const p=active();if(!p)return;p.opacity=Number($('opacity').value)/100;p.enabled=$('enabled').checked;p.mode=$('blend').value;p.color=$('color').value.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16));updateOutputs();requestRender();saveSoon();}
for(const id of ['opacity','enabled','blend','color'])$(id).oninput=adjust;
$('less').onclick=()=>{$('opacity').value=Math.max(0,Number($('opacity').value)-.5);adjust();};
$('more').onclick=()=>{$('opacity').value=Math.min(90,Number($('opacity').value)+.5);adjust();};
$('view').onchange=()=>{syncUI();saveSoon();};$('split').oninput=()=>{draw();saveSoon();};$('showMask').onchange=()=>{draw();saveSoon();};

function renderCandidates(){
  $('candidates').innerHTML=candidates.length?`<p class="hint">${candidates.length} suggestions (blue boxes). Uncheck false matches.</p>`+candidates.map((b,i)=>`<label class="check"><input type="checkbox" checked data-candidate="${i}">${b.x}, ${b.y} · ${(b.score*100).toFixed(0)}%</label>`).join('')+'<button id="acceptCandidates">Add checked copies</button><button id="discardCandidates">Discard</button>':'';
  if(candidates.length){$('acceptCandidates').onclick=()=>{const p=active();for(const input of $('candidates').querySelectorAll('input:checked')){const b=candidates[Number(input.dataset.candidate)];if(!p.boxes.some(r=>Math.abs(r.x-b.x)<p.mw*.5&&Math.abs(r.y-b.y)<p.mh*.5))p.boxes.push(b);}candidates=[];renderCandidates();syncUI();requestRender();saveSoon();};$('discardCandidates').onclick=()=>{candidates=[];renderCandidates();draw();};}
}
$('find').onclick=async()=>{
  const p=active();if(!p?.mask)return;$('find').disabled=true;$('cancel').hidden=false;
  try{const r=await rpc('find',{pattern:{...p,mask:p.mask.slice()},minScore:Number($('confidence').value)/100});if(active()!==p)return;
    candidates=r.boxes.filter(b=>!p.boxes.some(a=>Math.abs(a.x-b.x)<p.mw*.5&&Math.abs(a.y-b.y)<p.mh*.5));renderCandidates();draw();status(`${candidates.length} repeat suggestions. Review before adding.`);
  }catch(e){status(e.message);}finally{$('find').disabled=false;$('cancel').hidden=true;}
};
$('cancel').onclick=async()=>{
  worker.terminate();for(const job of jobs.values())job.reject(new Error('Search cancelled.'));jobs.clear();startWorker();await initWorker();status('Search cancelled.');requestRender();
};

async function installImage(blob,name,{restoredPatterns=[],selectedId=null}={}){
  if(blob.size>40*1024*1024)throw new Error('Choose an image under 40 MB.');
  const bitmap=await createImageBitmap(blob);
  if(bitmap.width*bitmap.height>32_000_000){bitmap.close();throw new Error('Choose an image under 32 megapixels.');}
  clearTimeout(saveTimer);sessionEpoch++;renderRevision++;
  W=bitmap.width;H=bitmap.height;originalCanvas.width=resultCanvas.width=W;originalCanvas.height=resultCanvas.height=H;
  originalCanvas.getContext('2d').drawImage(bitmap,0,0);resultCanvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
  imageBlob=blob;filename=name;patterns=restoredPatterns;activeId=selectedId||patterns[0]?.id||null;maskUndo=[];candidates=[];invalidateMask();renderCandidates();
  await initWorker();fit();setTool('pan');syncUI();if(patterns.length)requestRender();status('Image ready. Add a pattern, then select one full text instance.');
}
$('upload').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{await installImage(file,file.name);newPattern();saveSoon();}catch(err){status(err.message);}e.target.value='';};
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export').onclick=async()=>{
  if(!W)return;$('export').disabled=true;const epoch=sessionEpoch,w=W,h=H,name=filename;status('Rendering full-resolution export…');
  try{const r=await rpc('render',{patterns:copyPatterns()});if(epoch!==sessionEpoch)throw new Error('Image changed; export again.');const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').putImageData(new ImageData(r.pixels,w,h),0,0);c.toBlob(blob=>{if(blob)download(blob,name.replace(/\.[^.]+$/,'')+'-restored.png');},'image/png');status('Full-resolution PNG exported.');}
  catch(e){status(e.message);}finally{$('export').disabled=!W;}
};
$('exportMask').onclick=()=>{const p=active();if(!p?.mask)return;const c=maskCanvas(p);c.toBlob(blob=>blob&&download(blob,`${p.name.replaceAll(' ','-')}-mask.png`));};
$('maskUpload').onchange=async e=>{const file=e.target.files[0],p=active();if(!file||!p?.boxes.length){status('Select a template before importing a mask.');return;}
  try{const b=await createImageBitmap(file),c=document.createElement('canvas');if(b.width!==p.mw||b.height!==p.mh){b.close();throw new Error(`Mask must be ${p.mw} × ${p.mh} pixels.`);}c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(b,0,0);b.close();const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;rememberMask();
    const hasAlpha=pixels.some((v,i)=>i%4===3&&v<255);p.mask=Uint8Array.from({length:p.mw*p.mh},(_,i)=>hasAlpha?pixels[i*4+3]:Math.round((pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3));invalidateMask();syncUI();requestRender();saveSoon();status('Mask imported. Alpha or white pixels mark text strokes.');
  }catch(err){status(err.message);}e.target.value='';};
const base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
const unbase64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const blobURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
$('saveProject').onclick=async()=>{if(!imageBlob){status('Open an image first.');return;}try{const blob=imageBlob,project={version:1,filename,patterns:copyPatterns().map(p=>({...p,mask:p.mask?base64(p.mask):null})),activeId};project.image=await blobURL(blob);download(new Blob([JSON.stringify(project)],{type:'application/json'}),'waterunmark-project.json');status('Project exported with original image, masks, and settings.');}catch(e){status(e.message);}};
function validatePatterns(list,w,h){
  if(!Array.isArray(list)||list.length>50)throw new Error('Invalid pattern list.');
  return list.map((p,i)=>{
    if(!Array.isArray(p.boxes)||p.boxes.length>300||!Number.isFinite(p.opacity)||p.opacity<0||p.opacity>.9||!['normal','screen'].includes(p.mode)||!Array.isArray(p.color)||p.color.length!==3||p.color.some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('Invalid pattern settings.');
    for(const b of p.boxes)if(![b.x,b.y,b.w,b.h].every(Number.isInteger)||b.x<0||b.y<0||b.w<1||b.h<1||b.x+b.w>w||b.y+b.h>h)throw new Error('A placement is outside the image.');
    if(p.mask){if(!Number.isInteger(p.mw)||!Number.isInteger(p.mh)||p.mw<1||p.mh<1||p.mw*p.mh>4_000_000||p.mask.length!==p.mw*p.mh||!p.boxes.length||p.boxes[0].w!==p.mw||p.boxes[0].h!==p.mh)throw new Error('Invalid mask dimensions.');}
    return {...p,id:makeId(),name:String(p.name||`Pattern ${i+1}`).slice(0,50),enabled:!!p.enabled,radius:Math.max(2,Math.min(60,Number(p.radius)||12)),threshold:Math.max(0,Math.min(.9,Number(p.threshold)||.15)),softness:Math.max(.01,Math.min(1,Number(p.softness)||.25))};
  });
}
$('projectUpload').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{
  if(file.size>80*1024*1024)throw new Error('Project is too large (80 MB maximum).');const data=JSON.parse(await file.text());
  if(data.version!==1||typeof data.image!=='string'||!/^data:image\/(png|jpeg|webp|avif);base64,/.test(data.image))throw new Error('Unsupported project file.');
  const imageBytes=unbase64(data.image.split(',')[1]),blob=new Blob([imageBytes],{type:data.image.slice(5,data.image.indexOf(';'))}),bitmap=await createImageBitmap(blob);
  const list=validatePatterns(data.patterns.map(p=>({...p,mask:p.mask?unbase64(p.mask):null})),bitmap.width,bitmap.height);bitmap.close();
  const selectedId=list[data.patterns.findIndex(p=>p.id===data.activeId)]?.id;
  await installImage(blob,String(data.filename||'image.png'),{restoredPatterns:list,selectedId});saveSoon();status('Project restored.');
  }catch(err){status(`Could not open project: ${err.message}`);}e.target.value='';};
$('clearSession').onclick=async()=>{clearTimeout(saveTimer);sessionEpoch++;await saveChain.catch(()=>{});try{localStorage.removeItem('waterunmark-settings');await dbOp('readwrite',null);$('saved').textContent='Saved session forgotten. Current work stays open until you close it.';}catch{status('Could not clear browser storage.');}};

$('sweep').onclick=async()=>{
  const p=active();if(!p?.mask)return;const epoch=sessionEpoch,snapshot=copyPatterns(),index=patterns.indexOf(p),rect=p.boxes[0];
  const values=[-4,-2,0,2,4].map(d=>Math.max(0,Math.min(.9,p.opacity+d/100)));
  $('sweepGrid').innerHTML='';$('sweepDialog').showModal();$('sweep').disabled=true;
  try{for(const value of values){if(!$('sweepDialog').open||epoch!==sessionEpoch)break;snapshot[index].opacity=value;const r=await rpc('render',{patterns:snapshot});if(epoch!==sessionEpoch)break;
    const full=document.createElement('canvas');full.width=W;full.height=H;full.getContext('2d').putImageData(new ImageData(r.pixels,W,H),0,0);
    const c=document.createElement('canvas'),scale=Math.min(1,600/Math.max(rect.w,rect.h));c.width=Math.max(1,Math.round(rect.w*scale));c.height=Math.max(1,Math.round(rect.h*scale));c.getContext('2d').drawImage(full,rect.x,rect.y,rect.w,rect.h,0,0,c.width,c.height);full.width=full.height=1;
    const button=document.createElement('button'),label=document.createElement('strong');label.textContent=(value*100).toFixed(1)+'%';button.append(c,label);button.onclick=()=>{if(!patterns.includes(p))return;activeId=p.id;p.opacity=value;syncUI();requestRender();saveSoon();$('sweepDialog').close();};$('sweepGrid').append(button);
  }}catch(e){status(e.message);}finally{$('sweep').disabled=false;}
};
$('closeSweep').onclick=()=>$('sweepDialog').close();

async function demo(){
  const c=document.createElement('canvas');c.width=1400;c.height=950;const g=c.getContext('2d');
  const sky=g.createLinearGradient(0,0,0,950);sky.addColorStop(0,'#1e3647');sky.addColorStop(.55,'#8c8170');sky.addColorStop(1,'#263a3f');g.fillStyle=sky;g.fillRect(0,0,1400,950);
  g.fillStyle='#c9b893';g.beginPath();g.arc(1035,235,75,0,Math.PI*2);g.fill();
  for(const [color,y,points]of[['#364b51',370,[0,180,310,520,680,880,1110,1400]],['#243c43',500,[0,220,430,700,980,1200,1400]],['#172f36',680,[0,290,530,860,1100,1400]]]){g.fillStyle=color;g.beginPath();g.moveTo(0,950);points.forEach((x,i)=>g.lineTo(x,y+(i%2?130:-80)));g.lineTo(1400,950);g.fill();}
  g.strokeStyle='#a0b9a71a';for(let i=0;i<60;i++){g.beginPath();g.moveTo(0,700+i*4);g.lineTo(1400,700+i*4+20);g.stroke();}
  const demoPatterns=[];
  for(const [name,text,opacity,positions,size]of[['Pattern 1','SAMPLE IMAGE',.24,[[130,150],[550,390],[900,700]],36],['Pattern 2','PREVIEW ONLY',.15,[[100,620],[920,300]],24]]){
    const m=document.createElement('canvas');m.width=330;m.height=75;const mg=m.getContext('2d');mg.fillStyle='white';mg.font=`600 ${size}px system-ui`;mg.fillText(text,12,49);const pixels=mg.getImageData(0,0,330,75).data;const mask=Uint8Array.from({length:330*75},(_,i)=>pixels[i*4+3]);
    const boxes=positions.map(([x,y])=>({x,y,w:330,h:75}));demoPatterns.push({id:makeId(),name,opacity,enabled:true,mode:'normal',color:[255,255,255],radius:12,threshold:.15,softness:.25,mw:330,mh:75,mask,boxes});
    g.globalAlpha=opacity;for(const b of boxes)g.drawImage(m,b.x,b.y);g.globalAlpha=1;
  }
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));await installImage(blob,'mountain-demo.png',{restoredPatterns:demoPatterns});$('showMask').checked=false;$('opacity').value=18;adjust();status('Demo loaded with exact masks. Tune Pattern 1 toward 24% and Pattern 2 toward 15%.');saveSoon();
}
$('loadDemo').onclick=()=>demo().catch(e=>status(e.message));$('emptyDemo').onclick=$('loadDemo').onclick;
async function restore(){
  const epoch=sessionEpoch;
  try{const stored=await dbOp('readonly');if(!stored?.image||epoch!==sessionEpoch)return;const bitmap=await createImageBitmap(stored.image),ps=validatePatterns(stored.patterns,bitmap.width,bitmap.height);bitmap.close();if(epoch!==sessionEpoch)return;
    const selectedId=ps[stored.patterns.findIndex(p=>p.id===stored.activeId)]?.id;
    await installImage(stored.image,stored.filename,{restoredPatterns:ps,selectedId});
    try{const prefs=JSON.parse(localStorage.getItem('waterunmark-settings'));if(prefs){if(['split','original','result'].includes(prefs.view))$('view').value=prefs.view;$('split').value=Math.max(0,Math.min(100,Number(prefs.split)||50));$('showMask').checked=prefs.showMask!==false;}}catch{}
    syncUI();$('saved').textContent='Previous session restored from this device.';
  }catch{$('saved').textContent='No saved session available. Open an image or project to begin.';}
}
syncUI();restore();
