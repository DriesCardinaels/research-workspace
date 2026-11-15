/* Small DOM fixture for testing the public pane lifecycle and real Tool dispatch. */
export class Element {
  constructor(tag) {
    this.tag=tag;this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.attrs=this.attributes;this.events={};this.listeners={};this.style={};this.value='';this.textContent='';this.open=false;this.dataset={};
    const classes=new Set();this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)};
  }
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  addEventListener(k,fn,options={}){
    (this.listeners[k]??=[]).push({fn,once:options.once});
    this.events[k]=(...args)=>{let result;for(const item of [...this.listeners[k]]){if(item.once)this.removeEventListener(k,item.fn);result=item.fn(...args);}return result;};
    if(!this['on'+k])this['on'+k]=this.events[k];
  }
  removeEventListener(k,fn){this.listeners[k]=(this.listeners[k]||[]).filter(item=>item.fn!==fn);}
  focus(){this.ownerDocument.activeElement=this;this.focused=true;}
  select(){this.selected=true;}
  setSelectionRange(start,end){this.selection=[start,end];}
  showModal(){if(this.failOpen)throw Error('Native modal failure');this.open=true;}
  close(value=''){this.returnValue=value;this.open=false;this.events.close?.();}
  remove(){this.removed=true;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
  get isConnected(){return !this.removed&&(this.tagName==='BODY'||!!this.parentElement?.isConnected);}
  get options(){return this.children;}
  getBoundingClientRect(){return {left:10,bottom:20};}
  closest(selector){return selector==='[inert]'?null:this.tagName==='DIALOG'?this:this.parentElement?.closest(selector);}
  matches(selector){
    const tag=selector.match(/^[\w-]+/)?.[0];
    if(tag&&tag.toUpperCase()!==this.tagName)return false;
    if(selector.includes(':not([disabled])')&&this.disabled)return false;
    if(selector==='[autofocus]')return !!this.autofocus;
    const attr=selector.match(/^\[([\w-]+)(?:=([^\]]+))?\]$/);
    if(attr)return attr[2]?this.getAttribute(attr[1])===attr[2]:this.getAttribute(attr[1])!==null;
    return !!tag;
  }
  querySelectorAll(selector){return this.children.flatMap(node=>[...(selector.split(',').some(s=>node.matches(s))?[node]:[]),...node.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  reportValidity(){return this.querySelectorAll('input,select').every(node=>!node.required||!!node.value);}
}
export function createDocument(){
  const document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},querySelectorAll:()=>[]};
  document.createElement=tag=>Object.assign(new Element(tag),{ownerDocument:document});
  document.body=document.createElement('body');return document;
}
