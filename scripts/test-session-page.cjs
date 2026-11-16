// Offline fixtures only. No browser launch, desktop input or network.
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const fs=require('node:fs');const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../src/autoplay/session_page.js'),'utf8');
function fixture(host='game.maj-soul.com') {
 const options={anchors:true,button:true,covered:false,hidden:false,noFrame:false,tainted:false};let sourceX=0;
 const canvas={width:1600,height:900,getBoundingClientRect:()=>({left:0,top:0,width:1600,height:900})};
 const scratch={width:0,height:0};
 const context={drawImage(c,x){if(options.tainted)throw Error('tainted');sourceX=x;},getImageData(){
  const n=scratch.width*scratch.height;const p=new Uint8ClampedArray(n*4);
  const rgb=sourceX<650?(options.anchors?[168,115,85]:[50,50,50]):sourceX<1000?(options.anchors?[32,153,215]:[168,115,85]):(options.button?[180,140,45]:[30,30,30]);
  for(let i=0;i<n;i++){const color=sourceX>1000&&options.button&&i<n/10?[240,235,215]:rgb;p.set([...color,255],i*4);}return{data:p};
 }};scratch.getContext=()=>context;
 const document={get hidden(){return options.hidden;},getElementById:()=>canvas,querySelector:()=>canvas,
  createElement:()=>scratch,elementFromPoint:()=>options.covered?{}:canvas};
 const window={};const env=vm.createContext({window,document,location:{hostname:host},
  requestAnimationFrame:cb=>{if(!options.noFrame)queueMicrotask(cb);},setTimeout:cb=>setTimeout(cb,15),clearTimeout});
 vm.runInContext(script,env);return{options,api:window.__akagiTeacherSession,env};
}
test('requires both lobby currency anchors, not just a bright loading screen',async()=>{
 const f=fixture();assert.equal((await f.api.observe()).hall,true);
 f.options.anchors=false;assert.equal((await f.api.observe()).hall,false);
});
test('result candidate requires button colour/caption and unobstructed canvas',async()=>{
 const f=fixture();assert.equal((await f.api.observe()).confirm,true);
 f.options.button=false;assert.equal((await f.api.observe()).confirm,false);
 f.options.button=true;f.options.covered=true;assert.equal((await f.api.observe()).confirm,false);
 assert.equal(f.api.clear(11.4,2.6),false);
});
test('hidden, unreadable or non-rendering page cannot authorize input',async()=>{
 for(const key of ['hidden','tainted','noFrame']){const f=fixture();f.options[key]=true;
 const view=await f.api.observe();assert.equal(view.supported,false);assert.equal(view.confirm,false);assert.equal(view.hall,false);}
});
test('page identity is stable on repeat install and scripts are scoped to game hosts',()=>{
 const f=fixture();const doc=f.api.doc;vm.runInContext(script,f.env);assert.equal(f.api.doc,doc);
 assert.equal(fixture('example.com').api,undefined);assert.equal(fixture('maj-soul.com.evil.org').api,undefined);
});
