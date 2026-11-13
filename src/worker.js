import { estimateMask, deblend, findRepeats } from './core.js';
let original, width, height;
self.onmessage = ({data:m}) => {
  try {
    if(m.type==='init') { original=new Uint8ClampedArray(m.pixels);width=m.width;height=m.height;self.postMessage({id:m.id,type:'ready'});return; }
    if(!original)throw new Error('Upload an image first.');
    if(m.type==='mask'){
      const mask=estimateMask(original,width,height,m.rect,m.radius,m.threshold,m.softness);
      self.postMessage({id:m.id,type:'mask',mask},[mask.buffer]);
    }
    if(m.type==='render'){
      const result=deblend(original,width,height,m.patterns);
      self.postMessage({id:m.id,type:'render',...result},[result.pixels.buffer]);
    }
    if(m.type==='find'){
      const boxes=findRepeats(original,width,height,m.pattern,m.minScore,progress=>self.postMessage({id:m.id,type:'progress',progress}));
      self.postMessage({id:m.id,type:'find',boxes});
    }
  }catch(error){self.postMessage({id:m.id,type:'error',error:error.message});}
};
