import {useEffect,useState} from 'react';
export function OfflineStatus(){
 const [status,setStatus]=useState<'preparing'|'ready'|'online'|'retry'>('preparing'),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
  if(import.meta.env.DEV||!window.isSecureContext||!('serviceWorker' in navigator)){setStatus('online');return;}
  setStatus('preparing');
  timer=setTimeout(()=>{if(active)setStatus('retry');},30000);
  (async()=>{const scope=new URL('./',document.baseURI).href;const existing=await navigator.serviceWorker.getRegistration(scope);const reg=existing||await navigator.serviceWorker.register(new URL('./sw.js',document.baseURI).href,{scope,updateViaCache:'none'});void reg.update().catch(()=>{});const registration=await navigator.serviceWorker.ready;
   const channel=new MessageChannel();channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();if(active)setStatus(e.data?.ready?'ready':'retry');};timer=setTimeout(()=>{channel.port1.close();if(active)setStatus('retry');},15000);registration.active?.postMessage({type:'OFFLINE_STATUS'},[channel.port2]);
  })().catch(()=>{if(active)setStatus('retry');});return()=>{active=false;clearTimeout(timer);};
 },[attempt]);
 return <div className="sidebar-footer"><span className="status-dot"/>设备端计算 · 数据不上传<small role="status" aria-live="polite">{status==='ready'?'离线资料已就绪 · 可断网学习':status==='preparing'?'正在准备离线资料…':status==='online'?'空间直觉 → 因果推导 → 验证':<button onClick={()=>setAttempt(v=>v+1)}>重新准备离线资料</button>}</small></div>;
}
