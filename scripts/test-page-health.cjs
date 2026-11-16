// Pure Node fixtures: no browser, desktop input or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/autoplay/page_health.js'), 'utf8');
function fixture(host = 'game.maj-soul.com') {
  let now = 100, focused = false, pending;
  function target() {
    const listeners = {};
    return { addEventListener(k, f) { (listeners[k] ||= []).push(f); },
      dispatchEvent(e) { for (const f of listeners[e.type] || []) f(e); }, listeners };
  }
  const canvas = Object.assign(target(), { getBoundingClientRect: () => ({width:1600,height:900}) });
  const document = Object.assign(target(), { hidden:false, hasFocus:()=>focused,
    getElementById:()=>canvas, querySelector:()=>canvas });
  const window = Object.assign(target(), { requestAnimationFrame:f=>{pending=f;} });
  const context = vm.createContext({ window, document, location:{hostname:host},
    Date:{now:()=>now}, performance:{now:()=>now}, Event:class {constructor(type){this.type=type;}} });
  vm.runInContext(script, context);
  return {window,document,canvas,context, tick(){now+=16;pending();}, advance(ms){now+=ms;},
    focus(v){focused=v;}, get api(){return window.__akagiTeacherHealth;} };
}
test('installation is idempotent and scoped to game hosts', () => {
  assert.equal(fixture('example.org').api, undefined);
  assert.equal(fixture('maj-soul.com.attacker.org').api, undefined);
  const f=fixture(); const api=f.api; vm.runInContext(script,f.context);
  assert.equal(f.api,api); assert.equal(f.window.listeners.blur.length,1);
});
test('focus guard expires and never suppresses input element blur', () => {
  const f=fixture(); let suppressed=0;
  const blur=target=>f.window.dispatchEvent({type:'blur',target,stopImmediatePropagation(){suppressed++;}});
  blur(f.window); assert.equal(suppressed,0);
  f.api.prepare(1000); assert.equal(f.api.snapshot().focusRepairs,1);
  blur({}); assert.equal(suppressed,0); blur(f.window); assert.equal(suppressed,1);
  f.api.finish(); blur(f.window); assert.equal(suppressed,1);
  f.api.prepare(1000); f.advance(1001); blur(f.window); assert.equal(suppressed,1);
  f.document.hidden=true; const repairs=f.api.snapshot().focusRepairs;
  f.api.prepare(1000); assert.equal(f.api.snapshot().focusRepairs,repairs);
});
test('tracks render progression, visibility, context loss and received input separately', () => {
  const f=fixture(); f.tick(); assert.equal(f.api.snapshot().frames,1);
  f.advance(4000); assert.equal(f.api.snapshot().frameAgeMs,4000);
  f.canvas.dispatchEvent({type:'webglcontextlost'}); assert.equal(f.api.snapshot().contextLost,true);
  f.canvas.dispatchEvent({type:'webglcontextrestored'}); assert.equal(f.api.snapshot().contextLost,false);
  f.document.hidden=true; f.document.dispatchEvent({type:'visibilitychange'});
  f.window.dispatchEvent({type:'mousedown',target:{}});
  f.window.dispatchEvent({type:'mousedown',target:f.canvas});
  const h=f.api.snapshot(); assert.equal(h.mouseDown,1); assert.equal(h.visibilityChanges,1);
  assert.equal(h.hidden,true); assert.equal(h.losses,1); assert.equal(h.restores,1);
});

test('last press reports only events and frames from that press', () => {
  const f=fixture(); f.window.dispatchEvent({type:'mousedown',target:f.canvas});
  f.api.prepare(1000); f.tick();
  f.window.dispatchEvent({type:'mousedown',target:f.canvas});
  f.window.dispatchEvent({type:'mouseup',target:f.canvas});
  const p=f.api.finish().lastPress;
  assert.equal(p.mouseDown,1); assert.equal(p.mouseUp,1);
  assert.equal(p.framesAdvanced,1); assert.equal(p.focusRepaired,true);
  f.api.prepare(1000); const next=f.api.finish().lastPress;
  assert.equal(next.mouseDown,0); assert.equal(next.framesAdvanced,0);
});
