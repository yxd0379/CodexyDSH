/** Prepare a proxied Web page to keep its streaming carrier on the local Host. */

/** Each embedded realm has its own storage facade; the parent's Storage prototype is untouched. */
const storageBootstrap = String.raw`(function(prefix){
  for(const name of ['localStorage','sessionStorage']){
    let storage;
    try{storage=globalThis[name];}catch{continue;}
    if(!storage)continue;
    const keys=()=>Array.from({length:storage.length},(_,index)=>storage.key(index)).filter(key=>key!==null&&key.startsWith(prefix)).map(key=>key.slice(prefix.length));
    const methods={getItem:key=>storage.getItem(prefix+String(key)),setItem:(key,value)=>storage.setItem(prefix+String(key),String(value)),removeItem:key=>storage.removeItem(prefix+String(key)),clear:()=>{for(const key of keys())storage.removeItem(prefix+key);},key:index=>keys()[Number(index)>>>0]??null};
    const target=Object.create(null);
    for(const [key,value]of Object.entries(methods))Object.defineProperty(target,key,{value,configurable:true});
    Object.defineProperty(target,'length',{get:()=>keys().length,configurable:true});
    Object.defineProperty(target,Symbol.toStringTag,{value:'Storage',configurable:true});
    const scoped=new Proxy(target,{
      get:(object,key)=>Reflect.has(object,key)?Reflect.get(object,key):typeof key==='string'?methods.getItem(key)??undefined:undefined,
      set:(_object,key,value)=>{if(typeof key!=='string')return false;methods.setItem(key,value);return true;},
      deleteProperty:(_object,key)=>{if(typeof key==='string')methods.removeItem(key);return true;},
      ownKeys:()=>keys(),
      has:(object,key)=>Reflect.has(object,key)||typeof key==='string'&&methods.getItem(key)!==null,
      getOwnPropertyDescriptor:(object,key)=>typeof key==='string'&&methods.getItem(key)!==null?{value:methods.getItem(key),writable:true,enumerable:true,configurable:true}:Reflect.getOwnPropertyDescriptor(object,key),
      defineProperty:(_object,key,descriptor)=>{if(typeof key!=='string'||!('value'in descriptor))return false;methods.setItem(key,descriptor.value);return true;}
    });
    Object.defineProperty(globalThis,name,{value:scoped,configurable:true,enumerable:true});
    if(typeof globalThis.addEventListener==='function')globalThis.addEventListener('storage',event=>{
      if(event.storageArea!==storage)return;
      if(event.key!==null&&!event.key.startsWith(prefix)){event.stopImmediatePropagation();return;}
      Object.defineProperties(event,{key:{value:event.key===null?null:event.key.slice(prefix.length)},storageArea:{value:scoped}});
    },true);
  }
})`.replaceAll('\n', ' ')

function scriptJson(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/**
 * Install the local streaming base before the remote page's bootstrap executes.
 * Relative resources and the remote Host's module graph remain document-relative,
 * so they naturally follow the authenticated proxy prefix.
 * @param html - Remote index after the remote Host rendered its injections.
 * @param streamBaseUrl - Local HTTP(S) proxy directory, including its trailing slash.
 * @returns The index with an early, script-safe transport assignment.
 */
export function transformEmbeddedIndex(html: string, streamBaseUrl: string): string {
  const base = new URL(streamBaseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !base.pathname.endsWith('/')) throw new Error('Embedded remote streaming base must be an HTTP(S) directory')
  if (!/<head(?:\s[^>]*)?>/iu.test(html)) throw new Error('Remote Web index is missing its head element')
  const encoded = scriptJson(base.href)
  const namespace = scriptJson(`codexy.remote:${base.pathname}:`)
  // This authenticated proxy represents an owned loopback SSH Host even under dsh-app://app.
  // Preserve Host-backed settings rather than selecting the public remote-page memory mode.
  const script = `<script>${storageBootstrap}(${namespace});globalThis.__DSH_TRANSPORT__={...globalThis.__DSH_TRANSPORT__,ownsHost:true,streamBaseUrl:${encoded}};</script>`
  return html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${script}`)
}
