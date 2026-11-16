// Ranked-loop page observations, adapted from AkagiMS 1.3.2's shipped
// 16:9 coordinates / lobby anchors (Copyright 2026 Shinkuan, Apache-2.0).
// No application IPC or direct game protocol writes.
(() => {
  const host = location.hostname;
  if (!['maj-soul.com','mahjongsoul.com','majsoul.com','mahjongsoul.game.yo-star.com']
    .some(root => host === root || host.endsWith('.'+root))) return;
  if (window.__akagiTeacherSession) return;
  const doc = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const canvas = () => document.getElementById('unity-canvas') || document.querySelector('canvas');
  const scratch = document.createElement('canvas');
  const context = scratch.getContext('2d', {willReadFrequently:true});
  const anchors = [[5.587,0.793,168,115,85],[8.012,0.793,32,153,215]];
  function clear(x,y) {
    const c=canvas(); if(!c || document.hidden) return false;
    const r=c.getBoundingClientRect(); if(r.width<1 || r.height<1) return false;
    const hit=document.elementFromPoint(r.left+x*r.width/16,r.top+y*r.height/9);
    return hit===c;
  }
  function pixels(c,x,y,w,h,width,height) {
    scratch.width=width; scratch.height=height;
    context.drawImage(c,(x-w/2)*c.width/16,(y-h/2)*c.height/9,w*c.width/16,h*c.height/9,0,0,width,height);
    return context.getImageData(0,0,width,height).data;
  }
  function anchor(c,a) {
    const p=pixels(c,a[0],a[1],0.16,0.16,4,4); let r=0,g=0,b=0;
    for(let i=0;i<p.length;i+=4){r+=p[i];g+=p[i+1];b+=p[i+2];}
    return Math.abs(r/16-a[2])<=38 && Math.abs(g/16-a[3])<=38 && Math.abs(b/16-a[4])<=38;
  }
  // Conservative gold-button + bright-caption check, not OCR. This only
  // authorizes a known result-confirm point after a protocol end event.
  function confirm(c) {
    const p=pixels(c,14.59,8.37,1.1,0.38,64,24); let gold=0,ink=0;
    for(let i=0;i<p.length;i+=4){const r=p[i],g=p[i+1],b=p[i+2];
      if(r>100 && r>g*0.95 && g>b*1.15 && r>b*1.35 && r-b>45)gold++;
      if(r>205 && g>195 && b>165 && Math.max(r,g,b)-Math.min(r,g,b)<65)ink++;
    }
    return gold>p.length/4*0.25 && ink>p.length/4*0.02 && clear(14.59,8.37);
  }
  function observe() {
    return new Promise(resolve=>{
      let done=false;
      const finish=v=>{if(!done){done=true;resolve({doc,...v});}};
      const timer=setTimeout(()=>finish({supported:false,hall:false,confirm:false}),800);
      requestAnimationFrame(()=>{
        if(done)return;
        try {
          const c=canvas();
          if(!c || !c.width || !c.height || document.hidden || !context) {
            finish({supported:false,hall:false,confirm:false});
          } else {
            finish({supported:true,hall:anchors.every(a=>anchor(c,a)),confirm:confirm(c)});
          }
        } catch { finish({supported:false,hall:false,confirm:false}); }
        clearTimeout(timer);
      });
    });
  }
  window.__akagiTeacherSession=Object.freeze({doc,observe,clear});
})();
