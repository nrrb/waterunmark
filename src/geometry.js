// All rectangles use image pixels. Handles remain a fixed size on screen.
export const handles = r => [
  ['nw',r.x,r.y],['n',r.x+r.w/2,r.y],['ne',r.x+r.w,r.y],
  ['e',r.x+r.w,r.y+r.h/2],['se',r.x+r.w,r.y+r.h],
  ['s',r.x+r.w/2,r.y+r.h],['sw',r.x,r.y+r.h],['w',r.x,r.y+r.h/2]
];
export function hitHandle(rect,point,tolerance){
  return handles(rect).find(([,x,y])=>Math.abs(point.x-x)<=tolerance&&Math.abs(point.y-y)<=tolerance)?.[0]||null;
}
export const contains=(r,p)=>p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h;
export function resizeRect(rect,handle,dx,dy,width,height){
  let left=rect.x,top=rect.y,right=rect.x+rect.w,bottom=rect.y+rect.h;
  if(handle.includes('w'))left=Math.max(0,Math.min(right-4,Math.round(left+dx)));
  if(handle.includes('e'))right=Math.min(width,Math.max(left+4,Math.round(right+dx)));
  if(handle.includes('n'))top=Math.max(0,Math.min(bottom-4,Math.round(top+dy)));
  if(handle.includes('s'))bottom=Math.min(height,Math.max(top+4,Math.round(bottom+dy)));
  return{x:left,y:top,w:right-left,h:bottom-top};
}
export function moveRect(rect,dx,dy,width,height){
  return{x:Math.max(0,Math.min(width-rect.w,Math.round(rect.x+dx))),y:Math.max(0,Math.min(height-rect.h,Math.round(rect.y+dy))),w:rect.w,h:rect.h};
}
