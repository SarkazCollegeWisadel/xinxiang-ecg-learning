/* Build script inserts a content hash and the exact self-contained asset list. */
const BUILD=__BUILD__,ASSETS=__ASSETS__,SCOPE=self.registration.scope;
const PREFIX='xinxiang-offline-'+new URL(SCOPE).pathname+'-',CACHE=PREFIX+BUILD,READY=new URL('./.offline-ready',SCOPE).href;
const ALLOWED=new Set(ASSETS.map(p=>new URL(p,SCOPE).pathname));
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await Promise.all(ASSETS.map(async p=>{const url=new URL(p,SCOPE).href,response=await fetch(new Request(url,{cache:'reload',credentials:'same-origin'}));if(!response.ok||response.redirected||new URL(response.url).origin!==new URL(SCOPE).origin)throw Error('Offline asset unavailable: '+p);await cache.put(url,response);}));
 await cache.put(READY,new Response(JSON.stringify({ready:true,build:BUILD,files:ASSETS.length}),{headers:{'Content-Type':'application/json'}}));
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='OFFLINE_STATUS')event.waitUntil((async()=>{const cache=await caches.open(CACHE),ready=await cache.match(READY);event.ports[0]?.postMessage(ready?await ready.json():{ready:false});})());});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url),base=new URL(SCOPE);
 if(request.method!=='GET'||url.origin!==base.origin)return;
 const navigation=request.mode==='navigate'&&(url.pathname===base.pathname||url.pathname===new URL('index.html',SCOPE).pathname);
 if(navigation){event.respondWith((async()=>{try{const response=await fetch(request);if(response.ok&&!response.redirected)return response;}catch{}const cached=await (await caches.open(CACHE)).match(SCOPE);return cached||Response.error();})());return;}
 if(!ALLOWED.has(url.pathname))return;
 event.respondWith((async()=>{const cache=await caches.open(CACHE),response=await cache.match(url.origin+url.pathname);return response||fetch(request);})());
});
